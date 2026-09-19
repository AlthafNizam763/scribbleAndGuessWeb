import { randomInt } from 'node:crypto';

import { personalityFor } from '@/games/botPersonalities';
import { shuffle } from '@/games/cards';
import type { PlatformPlayerState } from '@/games/game.types';
import { stepBot, rememberMeeting, botVote, botSpeech } from '@/games/spaceMystery/bots';
import {
  BREACH_STATIONS, MEETING_TABLE, SPAWN_POINTS, TASK_STATIONS, VENTS,
  distance, lineOfSight, mapDescription, roomAt, walkable,
} from '@/games/spaceMystery/map';
import type {
  BotMemory, SabotageKind, SpaceEvent, SpaceMatch, SpacePlayer, SpaceRole,
} from '@/games/spaceMystery/types';
import { logger } from '@/utils/logger';

/**
 * The Space Mystery simulation.
 *
 * ## Why this is not an adapter
 *
 * Every other game on this platform is turn-based: an action arrives, the
 * adapter folds it into a state document, the document is written to Mongo and
 * broadcast. That shape is exactly wrong here. Ten crewmates walking around a
 * ship produce a state change twenty times a second whether or not anybody
 * pressed anything, and writing that to a database would be a hundred and
 * fifty document writes a second per match to persist something nobody will
 * ever want to read back.
 *
 * So the live match lives in memory, here, and Mongo sees it exactly three
 * times: when it starts, when somebody is ejected, and when it ends. The
 * adapter beside this file is the bridge — it owns the durable record; this
 * owns the ship.
 *
 * ## Server-authoritative, and what that buys
 *
 * Clients send a *direction*, never a position. The server integrates it
 * against the floor plan, so a modified client cannot walk through a wall,
 * cannot teleport across the deck, and cannot reach something it is not next
 * to. Every action — a task, an elimination, a report — is re-checked against
 * the server's own copy of where that player is.
 *
 * The same principle covers seeing, which is the one that matters most in a
 * deduction game: each player is sent only the players their own line of sight
 * reaches. A client that draws everybody through the walls has nothing to
 * draw, because the positions were never sent to it. This is the difference
 * between a social deduction game and a game where the cheats know everything.
 *
 * ## The tick
 *
 * Twenty simulation steps a second, broadcast on every second step. Movement
 * needs the fine step to stay smooth against walls; eyes do not need ten
 * updates a second more than they need five, and halving the broadcast halves
 * the bandwidth of the most expensive thing this platform does.
 */

/** Simulation step. 20 Hz: fine enough for wall sliding to feel solid. */
const TICK_MS = 50;

/** Broadcast every second step, so the wire runs at 10 Hz. */
const BROADCAST_EVERY = 2;

/** Units per second. Crossing the cafeteria takes about two seconds. */
const WALK_SPEED = 14;

/** How far anybody can see, normally. */
const VISION = 22;

/** How far a crewmate can see with the lights out. Traitors are unaffected. */
const VISION_DARK = 9;

/** Reach for a task, a vent, a repair or a report. */
const INTERACT_RADIUS = 3.5;

/** Reach for an elimination. Shorter than interacting: you have to be on them. */
const KILL_RADIUS = 3.2;

/**
 * Reach for the emergency button, measured from the middle of the table.
 *
 * Larger than [INTERACT_RADIUS] because it is a table rather than a console —
 * and because the spawn ring sits up to eight units out from the centre, so
 * anything tighter would mean some players start a match unable to call the
 * meeting the game opens by telling them about.
 */
const TABLE_RADIUS = 9;

const KILL_COOLDOWN_MS = 25_000;
/** After a meeting everybody is bunched at the table, so the clock restarts. */
const KILL_COOLDOWN_AFTER_MEETING_MS = 15_000;
const SABOTAGE_COOLDOWN_MS = 30_000;

const DISCUSSION_MS = 40_000;
const VOTING_MS = 30_000;

const BREACH_DEADLINE_MS = 45_000;
const LIGHTS_MS = 35_000;
const COMMS_MS = 30_000;

/** Emergency meetings per player, for the whole match. */
const EMERGENCIES_EACH = 1;

/** Real tasks each crewmate is given. */
const TASKS_EACH = 4;

/**
 * Sends each watcher their own view.
 *
 * Takes a builder rather than a payload because the whole point is that two
 * players in different rooms are sent different things.
 */
export type SpaceBroadcaster = (
  matchId: string,
  /** The platform room the match belongs to, which is the socket channel. */
  roomId: string,
  build: (viewerId: string) => Record<string, unknown>,
) => void;

/** Writes a finished match back to the durable record. */
export type SpaceRecorder = (matchId: string, result: Record<string, unknown>) => Promise<void>;

/**
 * Tells the voice layer that who-may-talk has just changed.
 *
 * Called on exactly three transitions — a meeting opening, a meeting closing,
 * and somebody dying — rather than on the tick. Voice membership can only
 * change at those points, and re-deriving it ten times a second would put a
 * database read per member into the hot loop to answer a question whose answer
 * had not moved.
 */
export type SpaceVoiceReconciler = (matchId: string, roomId: string) => void;

export class SpaceMysteryEngine {
  private readonly matches = new Map<string, SpaceMatch>();
  private timer: NodeJS.Timeout | null = null;

  /**
   * Bound separately, and that is not fussiness.
   *
   * Recording a result needs the platform service, which is always loaded.
   * Broadcasting needs the socket server, which is not — a test, a REST-only
   * process or the tournament worker has no sockets at all. Binding them
   * together would mean either a match that cannot save its result in those
   * processes, or an import of the socket layer from the service layer, which
   * is a cycle.
   */
  private broadcaster: SpaceBroadcaster | null = null;
  private recorder: SpaceRecorder | null = null;
  private voiceReconciler: SpaceVoiceReconciler | null = null;

  bindBroadcaster(broadcast: SpaceBroadcaster): void {
    this.broadcaster = broadcast;
  }

  bindRecorder(record: SpaceRecorder): void {
    this.recorder = record;
  }

  bindVoiceReconciler(reconcile: SpaceVoiceReconciler): void {
    this.voiceReconciler = reconcile;
  }

  /** How many ships are currently flying. For the health probe. */
  activeMatches(): number {
    return this.matches.size;
  }

  /**
   * Starts a match: assigns roles, deals task lists, and puts everybody round
   * the table.
   *
   * Roles are drawn here rather than in the adapter because they must never
   * reach the durable public state, and the safest way to guarantee that is
   * for the only copy to live in a process that has no way to write it.
   */
  begin(input: { matchId: string; roomId: string; players: PlatformPlayerState[] }): void {
    const seats = input.players;
    if (seats.length === 0) return;

    // One traitor up to six players, two from seven. Two traitors in a small
    // game is an immediate majority; one in a large game never gets a turn.
    const traitorCount = seats.length >= 7 ? 2 : 1;
    const traitors = new Set(shuffle(seats.map((seat) => seat.playerId)).slice(0, traitorCount));
    const spawns = shuffle([...SPAWN_POINTS]);

    const players = new Map<string, SpacePlayer>();
    let taskTotal = 0;

    seats.forEach((seat, index) => {
      const role: SpaceRole = traitors.has(seat.playerId) ? 'traitor' : 'crew';
      const spawn = spawns[index % spawns.length]!;
      const tasks = shuffle(TASK_STATIONS.map((station) => station.id)).slice(0, TASKS_EACH);

      // A traitor gets a task list too, and it looks exactly like everybody
      // else's — that is the entire point of it — but it is not counted
      // towards repair, so a traitor cannot win the game for the crew by
      // standing at consoles.
      if (role === 'crew') taskTotal += tasks.length;

      players.set(seat.playerId, {
        playerId: seat.playerId,
        username: seat.username,
        isBot: seat.isBot,
        botId: seat.isBot ? (seat.playerId) : null,
        personality: seat.isBot ? personalityFor(botIdOf(seat), seat.botDifficulty) : null,
        role,
        alive: true,
        x: spawn.x,
        y: spawn.y,
        inputX: 0,
        inputY: 0,
        facing: 1,
        tasks,
        completed: [],
        working: null,
        killCooldownMs: role === 'traitor' ? KILL_COOLDOWN_AFTER_MEETING_MS : 0,
        ventId: null,
        memory: seat.isBot ? freshMemory() : null,
      });
    });

    // Traitor bots are told who they are working with, which is the one fact
    // in a bot's memory it did not learn by looking — and the one a traitor at
    // a real table would also simply know.
    for (const player of players.values()) {
      if (player.role !== 'traitor' || player.memory === null) continue;
      player.memory.allies = [...traitors].filter((id) => id !== player.playerId);
    }

    this.matches.set(input.matchId, {
      matchId: input.matchId,
      roomId: input.roomId,
      status: 'playing',
      players,
      order: seats.map((seat) => seat.playerId),
      bodies: [],
      sabotage: null,
      meeting: null,
      emergencies: Object.fromEntries(seats.map((seat) => [seat.playerId, EMERGENCIES_EACH])),
      taskTotal,
      taskDone: 0,
      events: [],
      result: null,
      startedAtMs: Date.now(),
      lastTickMs: Date.now(),
      ticks: 0,
    });

    this.ensureTimer();
  }

  /** Drops a match, whether it finished or the room simply closed. */
  end(matchId: string): void {
    this.matches.delete(matchId);
    if (this.matches.size === 0 && this.timer !== null) {
      // Nothing flying: stop the clock rather than spinning on an empty map
      // twenty times a second for the rest of the process's life.
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /**
   * Applies one player action.
   *
   * Every branch re-derives what it needs from the server's own copy of the
   * world. The client says "I am using this console"; the server decides
   * whether that player is standing next to it.
   */
  input(matchId: string, playerId: string, action: Record<string, unknown>): void {
    const match = this.matches.get(matchId);
    if (!match || match.status !== 'playing') return;
    const player = match.players.get(playerId);
    if (!player) return;

    switch (action.type) {
      case 'move': return this.applyMove(match, player, action);
      case 'task': return this.applyTask(match, player, action);
      case 'eliminate': return this.applyEliminate(match, player, action);
      case 'report': return this.applyReport(match, player);
      case 'meeting': return this.applyEmergency(match, player);
      case 'vote': return this.applyVote(match, player, action);
      case 'sabotage': return this.applySabotage(match, player, action);
      case 'vent': return this.applyVent(match, player, action);
      default: return;
    }
  }

  /** One player's view of the ship, as both the client and its bots see it. */
  viewFor(matchId: string, viewerId: string): Record<string, unknown> | null {
    const match = this.matches.get(matchId);
    if (!match) return null;
    return this.project(match, viewerId);
  }

  /** The floor plan, handed over once when a client joins a match. */
  map(): Record<string, unknown> {
    return mapDescription();
  }

  /**
   * Whether this seat may hold a voice connection, and why not if it may not.
   *
   * ## The rule, and why it is this one
   *
   * Voice is open to **living players, during a meeting**, and closed the rest
   * of the time. Two separate reasons:
   *
   * 1. **The dead must not be heard.** A ghost who can talk to the living is a
   *    ghost who names their killer, and the match is over. This is the
   *    "spectators must not accidentally receive audio" requirement, and it is
   *    enforced by refusing them membership — not by muting a button.
   * 2. **The living should not talk while the ship is running.** A crew on an
   *    open channel for the whole match cannot be infiltrated: the traitor is
   *    whoever stops talking. Confining voice to meetings is what makes the
   *    discussion a discussion rather than a formality, and it is the rule
   *    this genre has settled on.
   *
   * Returned as a verdict rather than a throw because the caller wants to
   * distinguish "no such match" from "not yet" — the first is an error and the
   * second is a microphone that lights up when a body is reported.
   */
  voiceStatus(matchId: string, playerId: string): {
    known: boolean;
    allowed: boolean;
    reason: 'ok' | 'no_match' | 'not_seated' | 'dead' | 'no_meeting';
  } {
    const match = this.matches.get(matchId);
    if (!match) return { known: false, allowed: false, reason: 'no_match' };

    const player = match.players.get(playerId);
    if (!player) return { known: true, allowed: false, reason: 'not_seated' };
    if (!player.alive) return { known: true, allowed: false, reason: 'dead' };
    if (match.meeting === null) return { known: true, allowed: false, reason: 'no_meeting' };

    return { known: true, allowed: true, reason: 'ok' };
  }

  /** Everybody currently entitled to voice, for the membership reconciler. */
  voiceEligible(matchId: string): string[] {
    const match = this.matches.get(matchId);
    if (!match || match.meeting === null) return [];
    return [...match.players.values()]
      .filter((seat) => seat.alive)
      .map((seat) => seat.playerId);
  }

  // -------------------------------------------------------------------------
  // Actions
  // -------------------------------------------------------------------------

  private applyMove(match: SpaceMatch, player: SpacePlayer, action: Record<string, unknown>): void {
    // Movement is frozen during a meeting, and a player inside a vent is not
    // walking anywhere. Both are checked here rather than in the integrator,
    // so a held key cannot accumulate into a lurch when the meeting ends.
    if (match.meeting !== null || player.ventId !== null) return;

    const dx = Number(action.dx);
    const dy = Number(action.dy);
    if (!Number.isFinite(dx) || !Number.isFinite(dy)) return;

    // Clamped to a unit vector on arrival. A client sending {dx: 900} is
    // asking to move ninety times as fast, and this is where that is refused —
    // not by rejecting the message, but by normalising it, because the same
    // message arrives honestly from an analogue stick pushed to its corner.
    const magnitude = Math.hypot(dx, dy);
    if (magnitude < 0.01) { player.inputX = 0; player.inputY = 0; return; }

    const scale = Math.min(1, magnitude) / magnitude;
    player.inputX = dx * scale;
    player.inputY = dy * scale;
    if (Math.abs(dx) > 0.05) player.facing = dx < 0 ? -1 : 1;
  }

  private applyTask(match: SpaceMatch, player: SpacePlayer, action: Record<string, unknown>): void {
    if (!player.alive || match.meeting !== null || player.ventId !== null) return;

    const stationId = String(action.stationId ?? '');
    const station = TASK_STATIONS.find((entry) => entry.id === stationId);
    if (!station) return;

    // On this player's own list, not yet done, and they are standing at it.
    if (!player.tasks.includes(stationId) || player.completed.includes(stationId)) return;
    if (distance(player.x, player.y, station.x, station.y) > INTERACT_RADIUS) return;
    if (player.working !== null) return;

    player.working = { stationId, endsAtMs: Date.now() + station.durationMs };
  }

  private applyEliminate(match: SpaceMatch, player: SpacePlayer, action: Record<string, unknown>): void {
    if (player.role !== 'traitor' || !player.alive) return;
    if (match.meeting !== null || player.killCooldownMs > 0 || player.ventId !== null) return;

    const target = match.players.get(String(action.targetId ?? ''));
    if (!target || !target.alive || target.playerId === player.playerId) return;

    // Traitors do not eliminate each other. Checked server-side rather than
    // trusted to a client that simply would not offer the button.
    if (target.role === 'traitor') return;
    if (target.ventId !== null) return;
    if (distance(player.x, player.y, target.x, target.y) > KILL_RADIUS) return;

    target.alive = false;
    target.working = null;
    match.bodies.push({ playerId: target.playerId, x: target.x, y: target.y, atMs: Date.now() });
    player.killCooldownMs = KILL_COOLDOWN_MS;

    // The traitor steps onto the spot, which is what makes standing over a
    // body incriminating and why doing it is a decision.
    player.x = target.x;
    player.y = target.y;

    push(match, { type: 'eliminated', playerId: target.playerId, atMs: Date.now() });
    this.voiceReconciler?.(match.matchId, match.roomId);
    this.checkWin(match);
  }

  private applyReport(match: SpaceMatch, player: SpacePlayer): void {
    if (!player.alive || match.meeting !== null) return;

    const body = match.bodies.find(
      (corpse) => distance(player.x, player.y, corpse.x, corpse.y) <= INTERACT_RADIUS,
    );
    if (!body) return;

    this.openMeeting(match, player.playerId, 'body', body.playerId);
  }

  private applyEmergency(match: SpaceMatch, player: SpacePlayer): void {
    if (!player.alive || match.meeting !== null) return;
    if ((match.emergencies[player.playerId] ?? 0) <= 0) return;

    // Not during a breach. Otherwise the crew can call a meeting to run out
    // the clock on the one sabotage that is supposed to threaten them.
    if (match.sabotage?.kind === 'breach') return;
    if (distance(player.x, player.y, MEETING_TABLE.x, MEETING_TABLE.y) > TABLE_RADIUS) return;

    match.emergencies[player.playerId] = (match.emergencies[player.playerId] ?? 1) - 1;
    this.openMeeting(match, player.playerId, 'emergency', null);
  }

  private applyVote(match: SpaceMatch, player: SpacePlayer, action: Record<string, unknown>): void {
    const meeting = match.meeting;
    if (!meeting || meeting.phase !== 'voting' || !player.alive) return;
    if (player.playerId in meeting.votes) return;

    const raw = action.targetId;
    const targetId = typeof raw === 'string' && raw.length > 0 ? raw : null;
    if (targetId !== null) {
      const target = match.players.get(targetId);
      if (!target || !target.alive) return;
    }

    meeting.votes[player.playerId] = targetId;
    // Who voted is public the moment they vote; *what* they voted is not shown
    // until the count. That is the tension of the last few seconds.
    push(match, { type: 'vote_cast', playerId: player.playerId, atMs: Date.now() });

    const living = [...match.players.values()].filter((seat) => seat.alive).length;
    if (Object.keys(meeting.votes).length >= living) this.closeMeeting(match);
  }

  private applySabotage(match: SpaceMatch, player: SpacePlayer, action: Record<string, unknown>): void {
    if (player.role !== 'traitor' || !player.alive) return;
    if (match.meeting !== null || match.sabotage !== null || player.killCooldownMs > 0) return;

    const kind = String(action.kind ?? 'breach') as SabotageKind;
    if (kind !== 'breach' && kind !== 'lights' && kind !== 'comms') return;

    const now = Date.now();
    const life = kind === 'breach' ? BREACH_DEADLINE_MS : kind === 'lights' ? LIGHTS_MS : COMMS_MS;

    match.sabotage = {
      kind,
      byId: player.playerId,
      startedAtMs: now,
      deadlineAtMs: now + life,
      holds: kind === 'breach'
        ? Object.fromEntries(BREACH_STATIONS.map((station) => [station.id, null]))
        : {},
    };

    // Sabotage shares the elimination clock. Without that a traitor could pull
    // the reactor and walk into the scramble with a free kill every time.
    player.killCooldownMs = Math.max(player.killCooldownMs, SABOTAGE_COOLDOWN_MS);

    // Who did it is never broadcast. The event says the reactor is going, the
    // same as the alarm on the wall does.
    push(match, { type: 'sabotage', detail: kind, atMs: now });
  }

  private applyVent(match: SpaceMatch, player: SpacePlayer, action: Record<string, unknown>): void {
    if (player.role !== 'traitor' || !player.alive || match.meeting !== null) return;

    if (player.ventId !== null) {
      const current = VENTS.find((vent) => vent.id === player.ventId);
      if (!current) { player.ventId = null; return; }

      // No destination named means "climb out here", which is the ordinary
      // way a traitor leaves a vent.
      const requested = typeof action.ventId === 'string' ? action.ventId : '';
      if (requested === '') {
        player.x = current.x;
        player.y = current.y;
        player.ventId = null;
        push(match, { type: 'vent', playerId: player.playerId, atMs: Date.now() });
        return;
      }

      // A destination that is named but unreachable — a mouth on the other
      // network, or one that does not exist — is **refused**, not quietly
      // turned into an exit. Treating it as an exit would hand a modified
      // client a way to surface at a moment of its choosing by naming
      // rubbish, and would mean a mistyped id silently did something else.
      const destination = VENTS.find(
        (vent) => vent.id === requested && vent.network === current.network,
      );
      if (!destination) return;

      player.x = destination.x;
      player.y = destination.y;
      player.ventId = destination.id;
      return;
    }

    const vent = VENTS.find(
      (entry) => distance(player.x, player.y, entry.x, entry.y) <= INTERACT_RADIUS,
    );
    if (!vent) return;

    player.ventId = vent.id;
    player.working = null;
    player.inputX = 0;
    player.inputY = 0;
    push(match, { type: 'vent', playerId: player.playerId, atMs: Date.now() });
  }

  // -------------------------------------------------------------------------
  // The tick
  // -------------------------------------------------------------------------

  private ensureTimer(): void {
    if (this.timer !== null) return;
    this.timer = setInterval(() => this.step(), TICK_MS);
    // Never hold the process open for a game nobody is playing.
    this.timer.unref?.();
  }

  private step(): void {
    const now = Date.now();
    for (const match of [...this.matches.values()]) {
      try {
        this.advance(match, now);
      } catch (error: unknown) {
        // One broken ship must not stop every other ship in the process.
        logger.exception('a Space Mystery tick failed', error, { matchId: match.matchId });
      }
    }
  }

  private advance(match: SpaceMatch, now: number): void {
    if (match.status !== 'playing') return;

    const deltaMs = Math.min(250, now - match.lastTickMs);
    match.lastTickMs = now;
    match.ticks += 1;

    if (match.meeting !== null) {
      this.advanceMeeting(match, now);
    } else {
      this.advanceStation(match, now, deltaMs / 1000);
    }

    if (match.ticks % BROADCAST_EVERY === 0) this.publish(match);

    // Events are for the tick they happened on. A client that missed one was
    // not connected, and replaying it late would fire an alarm for a reactor
    // that has already been fixed.
    if (match.events.length > 0) match.events = [];
  }

  private advanceStation(match: SpaceMatch, now: number, deltaSeconds: number): void {
    for (const player of match.players.values()) {
      if (player.killCooldownMs > 0) {
        player.killCooldownMs = Math.max(0, player.killCooldownMs - deltaSeconds * 1000);
      }

      // Bots decide before anybody moves, so their decision and their movement
      // land on the same tick rather than a frame apart.
      if (player.isBot && player.alive) {
        stepBot({
          match, player, deltaMs: deltaSeconds * 1000,
          view: this.project(match, player.playerId),
          act: (action) => this.input(match.matchId, player.playerId, action),
        });
      }

      if (!player.alive) {
        // Ghosts still drift about, because watching from a fixed point is
        // dull and a ghost cannot affect anything anyway.
        this.integrate(player, deltaSeconds);
        continue;
      }

      if (player.ventId !== null) continue;

      // Standing still is a requirement, not a courtesy: walking off cancels
      // the console, which is what makes a long task a commitment.
      if (player.working !== null) {
        const station = TASK_STATIONS.find((entry) => entry.id === player.working!.stationId);
        const inReach = station !== undefined
          && distance(player.x, player.y, station.x, station.y) <= INTERACT_RADIUS;

        if (!inReach) {
          player.working = null;
        } else if (now >= player.working.endsAtMs) {
          player.completed.push(player.working.stationId);
          if (player.role === 'crew') match.taskDone += 1;
          push(match, { type: 'task_done', playerId: player.playerId, atMs: now });
          player.working = null;
        }
      }

      this.integrate(player, deltaSeconds);
    }

    this.advanceSabotage(match, now);
    this.checkWin(match);
  }

  /**
   * Moves one body, and slides it along anything it runs into.
   *
   * The slide is the difference between a ship that feels like a place and one
   * that feels like a grid: without it, a player walking diagonally into a
   * wall stops dead, and every corridor becomes a thing you have to aim at.
   * Trying each axis on its own after the combined step fails is the cheapest
   * way to get it, and it is exact for axis-aligned walls, which is all there
   * are here.
   */
  private integrate(player: SpacePlayer, deltaSeconds: number): void {
    if (player.inputX === 0 && player.inputY === 0) return;

    const step = WALK_SPEED * deltaSeconds;
    const dx = player.inputX * step;
    const dy = player.inputY * step;

    if (walkable(player.x + dx, player.y + dy)) {
      player.x += dx;
      player.y += dy;
      return;
    }
    if (walkable(player.x + dx, player.y)) { player.x += dx; return; }
    if (walkable(player.x, player.y + dy)) { player.y += dy; }
  }

  private advanceSabotage(match: SpaceMatch, now: number): void {
    const sabotage = match.sabotage;
    if (!sabotage) return;

    if (sabotage.kind !== 'breach') {
      if (now >= sabotage.deadlineAtMs) {
        match.sabotage = null;
        push(match, { type: 'sabotage_fixed', detail: sabotage.kind, atMs: now });
      }
      return;
    }

    // Both switches, at opposite ends of the ship, held at the same moment.
    // Recomputed from positions every tick rather than latched, so letting go
    // releases it — which is what forces two people to commit at once.
    for (const station of BREACH_STATIONS) {
      const holder = [...match.players.values()].find(
        (seat) => seat.alive
          && seat.ventId === null
          && distance(seat.x, seat.y, station.x, station.y) <= INTERACT_RADIUS,
      );
      sabotage.holds[station.id] = holder ? holder.playerId : null;
    }

    const held = BREACH_STATIONS.every((station) => sabotage.holds[station.id] !== null);
    if (held) {
      match.sabotage = null;
      push(match, { type: 'sabotage_fixed', detail: 'breach', atMs: now });
      return;
    }

    if (now >= sabotage.deadlineAtMs) {
      this.finish(match, { winnerTeam: 'traitors', reason: 'reactor_breach' });
    }
  }

  // -------------------------------------------------------------------------
  // Meetings
  // -------------------------------------------------------------------------

  private openMeeting(match: SpaceMatch, callerId: string, reason: 'body' | 'emergency', bodyOf: string | null): void {
    const now = Date.now();

    match.meeting = {
      reason, callerId, bodyOf,
      phase: 'discussion',
      endsAtMs: now + DISCUSSION_MS,
      votes: {},
      said: [],
    };

    // Bodies are cleared when the meeting opens, exactly as at a table: the
    // one that was found is the subject of the meeting, and the others are
    // gone. A body that survived the meeting could be reported twice.
    match.bodies = [];

    for (const player of match.players.values()) {
      player.working = null;
      player.inputX = 0;
      player.inputY = 0;
      player.ventId = null;
      player.x = MEETING_TABLE.x + (randomInt(1200) - 600) / 100;
      player.y = MEETING_TABLE.y + (randomInt(1200) - 600) / 100;
      if (player.memory) {
        player.memory.spoke = false;
        // What each bot brings to the meeting is what it saw, which is
        // already in its own memory. This only lets it turn that into an
        // accusation.
        rememberMeeting(player, bodyOf);
      }
    }

    // A meeting stops a sabotage, including a breach. The alternative is a
    // reactor timing out while everybody is locked in a vote they cannot
    // leave, which is a loss nobody had a chance to prevent.
    match.sabotage = null;

    push(match, {
      type: 'meeting', playerId: callerId, targetId: bodyOf ?? undefined,
      detail: reason, atMs: now,
    });

    // Voice opens with the meeting, for the living.
    this.voiceReconciler?.(match.matchId, match.roomId);
  }

  private advanceMeeting(match: SpaceMatch, now: number): void {
    const meeting = match.meeting;
    if (!meeting) return;

    // Bots talk during the discussion and vote during the vote, both on their
    // own clocks, so a table of Stupids does not answer in unison.
    for (const player of match.players.values()) {
      if (!player.isBot || !player.alive || !player.memory) continue;

      if (meeting.phase === 'discussion' && !player.memory.spoke) {
        const line = botSpeech(player, match, this.project(match, player.playerId));
        if (line !== null) {
          player.memory.spoke = true;
          meeting.said.push({ playerId: player.playerId, text: line, atMs: now });
        }
        continue;
      }

      if (meeting.phase === 'voting' && !(player.playerId in meeting.votes)) {
        // Spread across the voting window rather than instant, so the human
        // players are not staring at a finished tally for twenty seconds.
        const elapsed = VOTING_MS - (meeting.endsAtMs - now);
        const readyAt = 4000 + (player.personality?.thinkMs ?? 1500);
        if (elapsed < readyAt) continue;

        const choice = botVote(player, match, this.project(match, player.playerId));
        this.applyVote(match, player, { targetId: choice ?? '' });
      }
    }

    if (now < meeting.endsAtMs) return;

    if (meeting.phase === 'discussion') {
      meeting.phase = 'voting';
      meeting.endsAtMs = now + VOTING_MS;
      return;
    }

    this.closeMeeting(match);
  }

  private closeMeeting(match: SpaceMatch): void {
    const meeting = match.meeting;
    if (!meeting) return;

    const tally: Record<string, number> = {};
    let skips = 0;
    for (const target of Object.values(meeting.votes)) {
      if (target === null) { skips += 1; continue; }
      tally[target] = (tally[target] ?? 0) + 1;
    }

    const ranked = Object.entries(tally).sort(([, a], [, b]) => b - a);
    const top = ranked[0];
    const tied = ranked.length > 1 && ranked[1]![1] === top?.[1];

    // A tie ejects nobody, and so does a skip majority. Both are the same
    // rule: an ejection needs a clear plurality, because throwing somebody out
    // of an airlock on a coin toss is not a decision the crew made.
    const ejectedId = top !== undefined && !tied && top[1] > skips ? top[0] : null;

    if (ejectedId !== null) {
      const ejected = match.players.get(ejectedId);
      if (ejected) {
        ejected.alive = false;
        ejected.working = null;
      }
    }

    // Whether the ejected player was a traitor is announced. It is the only
    // hard information the crew ever gets, and a game that withholds it turns
    // every meeting into the same conversation.
    push(match, {
      type: 'ejected',
      playerId: ejectedId ?? undefined,
      detail: ejectedId === null
        ? (tied ? 'tied' : 'skipped')
        : match.players.get(ejectedId)?.role === 'traitor' ? 'traitor' : 'crew',
      atMs: Date.now(),
    });

    match.meeting = null;
    match.bodies = [];

    // And closes again when it ends — which also drops whoever was just
    // ejected, before they can say anything from the airlock.
    this.voiceReconciler?.(match.matchId, match.roomId);

    // Everybody is standing in one place, so nobody gets a free elimination on
    // the walk out.
    for (const player of match.players.values()) {
      if (player.role === 'traitor') player.killCooldownMs = KILL_COOLDOWN_AFTER_MEETING_MS;
      if (player.memory) player.memory.thinkInMs = 0;
    }

    this.checkWin(match);
  }

  // -------------------------------------------------------------------------
  // Winning, and telling everybody about it
  // -------------------------------------------------------------------------

  private checkWin(match: SpaceMatch): void {
    if (match.status !== 'playing') return;

    const living = [...match.players.values()].filter((seat) => seat.alive);
    const traitors = living.filter((seat) => seat.role === 'traitor').length;
    const crew = living.length - traitors;

    if (traitors === 0) {
      this.finish(match, { winnerTeam: 'crew', reason: 'traitors_ejected' });
      return;
    }
    if (match.taskTotal > 0 && match.taskDone >= match.taskTotal) {
      this.finish(match, { winnerTeam: 'crew', reason: 'station_repaired' });
      return;
    }
    if (traitors >= crew) {
      this.finish(match, { winnerTeam: 'traitors', reason: 'traitors_outnumber_crew' });
    }
  }

  private finish(match: SpaceMatch, outcome: Record<string, unknown>): void {
    if (match.status !== 'playing') return;

    match.status = 'completed';
    const winnerTeam = outcome.winnerTeam === 'traitors' ? 'traitor' : 'crew';

    match.result = {
      ...outcome,
      // Roles are finally public. Nothing before this line has ever sent them
      // to anybody who was not entitled to them.
      roles: Object.fromEntries([...match.players.values()].map((seat) => [seat.playerId, seat.role])),
      winnerIds: [...match.players.values()]
        .filter((seat) => seat.role === winnerTeam)
        .map((seat) => seat.playerId),
      survivors: [...match.players.values()].filter((seat) => seat.alive).map((seat) => seat.playerId),
      tasksCompleted: match.taskDone,
      tasksTotal: match.taskTotal,
      durationMs: Date.now() - match.startedAtMs,
    };

    push(match, { type: 'win', detail: String(outcome.winnerTeam), atMs: Date.now() });

    // One last broadcast carrying the reveal, then the durable write. The
    // broadcast goes first: the players should see the result at the moment it
    // happens, not after a round trip to a database.
    this.publish(match);

    void this.recorder?.(match.matchId, match.result).catch((error: unknown) => {
      logger.exception('recording a Space Mystery result failed', error, { matchId: match.matchId });
    });

    // Held briefly so late-arriving views still resolve to the finished match
    // rather than to nothing at all.
    setTimeout(() => this.end(match.matchId), 10_000).unref?.();
  }

  private publish(match: SpaceMatch): void {
    this.broadcaster?.(match.matchId, match.roomId, (viewerId) => this.project(match, viewerId));
  }

  // -------------------------------------------------------------------------
  // The projection — the anti-cheat, in one function
  // -------------------------------------------------------------------------

  /**
   * What one player is allowed to know.
   *
   * Read this function as the security boundary it is. A field that is not
   * built here is a field no client and no bot can see, whatever either of
   * them does. In particular:
   *
   *  - **Roles.** Only your own, plus your fellow traitors if you are one.
   *  - **Positions.** Only players your line of sight actually reaches, and
   *    never anybody inside a vent. A ghost sees everything, which is the
   *    traditional rule and costs nothing, because a ghost cannot act.
   *  - **Task lists.** Only your own. Task *progress* is a single number, so
   *    the crew can see the bar move without learning whose bar it is.
   *  - **Who sabotaged.** Never. The alarm says the reactor is going; it does
   *    not say who pulled it.
   */
  private project(match: SpaceMatch, viewerId: string): Record<string, unknown> {
    const viewer = match.players.get(viewerId);
    const now = Date.now();
    const dark = match.sabotage?.kind === 'lights';
    const inMeeting = match.meeting !== null;

    // A ghost has no secrets left to keep from it, and a meeting puts
    // everybody in one room anyway.
    const omniscient = viewer === undefined || !viewer.alive || inMeeting;
    const range = dark && viewer?.role !== 'traitor' ? VISION_DARK : VISION;

    const visible = [...match.players.values()].filter((other) => {
      if (other.playerId === viewerId) return true;
      if (other.ventId !== null) return omniscient || other.role === viewer?.role;
      if (omniscient) return true;
      if (!other.alive) return false;
      if (distance(viewer!.x, viewer!.y, other.x, other.y) > range) return false;
      return lineOfSight(viewer!.x, viewer!.y, other.x, other.y);
    });

    const allies = viewer?.role === 'traitor'
      ? [...match.players.values()].filter((seat) => seat.role === 'traitor').map((seat) => seat.playerId)
      : [];

    return {
      gameId: 'SPACE_MYSTERY',
      status: match.status,
      matchId: match.matchId,
      phase: inMeeting ? 'meeting' : 'station',
      serverMs: now,

      /** The viewer's own card. The only place a role is ever named. */
      you: viewer === undefined ? null : {
        playerId: viewer.playerId,
        role: viewer.role,
        alive: viewer.alive,
        x: round(viewer.x),
        y: round(viewer.y),
        tasks: viewer.tasks.map((stationId) => ({
          stationId,
          done: viewer.completed.includes(stationId),
        })),
        working: viewer.working === null ? null : {
          stationId: viewer.working.stationId,
          remainingMs: Math.max(0, viewer.working.endsAtMs - now),
        },
        killCooldownMs: Math.round(viewer.killCooldownMs),
        ventId: viewer.ventId,
        emergenciesLeft: match.emergencies[viewer.playerId] ?? 0,
        allies: allies.filter((id) => id !== viewer.playerId),
      },

      players: visible.map((other) => ({
        playerId: other.playerId,
        username: other.username,
        isBot: other.isBot,
        x: round(other.x),
        y: round(other.y),
        facing: other.facing,
        alive: other.alive,
        /** Only ever true for a viewer who is entitled to see it. */
        venting: other.ventId !== null,
        working: other.working !== null,
        /** A role, but only where the projection above already allowed it. */
        role: omniscient && match.status === 'completed' ? other.role
          : allies.includes(other.playerId) && viewer?.role === 'traitor' ? 'traitor'
          : null,
      })),

      /** Seat order, so colours stay put even for players currently unseen. */
      seats: match.order,

      bodies: match.bodies
        .filter((body) => omniscient
          || (distance(viewer!.x, viewer!.y, body.x, body.y) <= range
            && lineOfSight(viewer!.x, viewer!.y, body.x, body.y)))
        .map((body) => ({ playerId: body.playerId, x: round(body.x), y: round(body.y) })),

      /** One number. The crew can watch the bar; nobody learns whose it is. */
      taskProgress: match.taskTotal === 0 ? 0 : match.taskDone / match.taskTotal,
      taskTotal: match.taskTotal,
      taskDone: match.taskDone,

      sabotage: match.sabotage === null ? null : {
        kind: match.sabotage.kind,
        remainingMs: Math.max(0, match.sabotage.deadlineAtMs - now),
        // Which switches are down, not who is holding them: the alarm panel
        // shows the state of the reactor, not a roster.
        holds: Object.fromEntries(
          Object.entries(match.sabotage.holds).map(([id, holder]) => [id, holder !== null]),
        ),
      },

      meeting: match.meeting === null ? null : {
        reason: match.meeting.reason,
        callerId: match.meeting.callerId,
        bodyOf: match.meeting.bodyOf,
        phase: match.meeting.phase,
        remainingMs: Math.max(0, match.meeting.endsAtMs - now),
        // Who has voted, never what they voted, until the count.
        voted: Object.keys(match.meeting.votes),
        said: match.meeting.said,
        yourVote: viewer && viewer.playerId in match.meeting.votes
          ? match.meeting.votes[viewer.playerId]
          : undefined,
      },

      events: match.events,
      result: match.result,
    };
  }
}

/** Two decimal places. A client cannot draw more, and the wire pays for them. */
function round(value: number): number {
  return Math.round(value * 100) / 100;
}

function push(match: SpaceMatch, event: SpaceEvent): void {
  match.events.push(event);
}

function freshMemory(): BotMemory {
  return {
    path: [],
    intent: 'wander',
    targetStationId: null,
    targetPlayerId: null,
    thinkInMs: 0,
    suspicion: {},
    sightings: [],
    lastRoomId: null,
    allies: [],
    spoke: false,
  };
}

/**
 * The character behind a seated Stupid.
 *
 * A platform bot's seat id is generated, while its *character* is the roster
 * key. The room document carries both; this pulls the one the personality
 * table is keyed on, and falls back to the seat id so an unknown character
 * still gets middling dials rather than throwing at match start.
 */
function botIdOf(seat: PlatformPlayerState): string {
  const candidate = (seat as unknown as { botId?: unknown }).botId;
  return typeof candidate === 'string' && candidate.length > 0 ? candidate : seat.playerId;
}

/** Placed here, and injected, for the same reason the platform bot driver is. */
export const spaceMysteryEngine = new SpaceMysteryEngine();

export const spaceMysteryTuning = {
  TICK_MS, BROADCAST_EVERY, WALK_SPEED, VISION, VISION_DARK,
  INTERACT_RADIUS, KILL_RADIUS, TABLE_RADIUS, KILL_COOLDOWN_MS, DISCUSSION_MS, VOTING_MS,
  BREACH_DEADLINE_MS, TASKS_EACH,
} as const;

export { roomAt };
