import { randomInt } from 'node:crypto';

import { blunders, notices, pick } from '@/games/adapter.base';
import {
  BREACH_STATIONS, TASK_STATIONS, VENTS,
  distance, nearestNav, pathBetween, roomAt,
} from '@/games/spaceMystery/map';
import type { SpaceMatch, SpacePlayer } from '@/games/spaceMystery/types';

/**
 * The Stupids that crew the *Meridian*.
 *
 * ## The rule everything here is built around
 *
 * A bot is handed `view` — the output of the engine's projection for its own
 * seat, byte for byte the same object the person in that seat would be sent —
 * and it reads **nothing else about anybody else**. It may read its own
 * `player` record, because that is its own hand, and it may read its own
 * memory, because that is its own head. It never walks the match's player map.
 *
 * That is not a convention to be careful about; it is why a crew bot cannot
 * know who the traitor is. The answer is not in the object. If a future change
 * wants a bot to notice something new, the thing to change is the projection —
 * which gives it to the people in the game at the same time.
 *
 * The one exception is stated in `BotMemory.allies`: a traitor bot knows its
 * fellow traitors, because a traitor at a real table does too, and that is set
 * once at match start from its own role.
 *
 * ## Why the bots are not good
 *
 * They are meant to be beatable and a bit daft, like the rest of the roster.
 * The difficulty dials change what a bot *notices* rather than what it is
 * allowed to see: an easy traitor will happily stab somebody in a crowded
 * cafeteria, and an easy crewmate will walk past a corpse. That is
 * [BotPersonality.read] doing its job, and it is why Easy is genuinely easier
 * rather than merely slower.
 */

type View = Record<string, unknown>;

/** How close a waypoint counts as reached. */
const ARRIVE = 1.6;

/** Reach for a console, a vent or a body. Matches the engine's own figure. */
const INTERACT = 3.5;

/** Range at which a traitor will commit. Slightly beyond the engine's reach,
 *  so it closes the last stride rather than standing just outside it. */
const STRIKE = 3.0;

/** How far away another living crewmate still counts as a witness. */
const WITNESS_RANGE = 17;

export interface BotStep {
  match: SpaceMatch;
  player: SpacePlayer;
  deltaMs: number;
  view: View;
  act(action: Record<string, unknown>): void;
}

/**
 * One bot, one tick.
 *
 * Split in two on purpose: perception runs every tick because it is cheap and
 * missing a body for half a second looks like a bug, while *planning* runs on
 * the character's own clock, because a bot that reconsiders its entire life
 * twenty times a second walks like an insect.
 */
export function stepBot(step: BotStep): void {
  const { player, view, deltaMs } = step;
  const memory = player.memory;
  if (!memory || !player.alive) return;

  // A meeting is handled elsewhere: talking and voting are not walking.
  if (view.phase === 'meeting') return;

  perceive(step);

  memory.thinkInMs -= deltaMs;
  if (memory.thinkInMs <= 0 || memory.path.length === 0) {
    plan(step);
    // Re-planning cadence is the character's think time, jittered, so two
    // Stupids in one corridor do not turn round on the same tick forever.
    const base = player.personality?.thinkMs ?? 1500;
    memory.thinkInMs = base + randomInt(Math.max(1, Math.round(base)));
  }

  steer(step);
  reach(step);
}

/**
 * Updates what this bot has seen, from its own projection and nothing else.
 */
function perceive(step: BotStep): void {
  const { player, view } = step;
  const memory = player.memory!;
  const now = Number(view.serverMs) || Date.now();

  // Where it is, for the alibi it will give if a meeting is called. A bot that
  // cannot say where it was is a bot nobody can clear.
  memory.lastRoomId = roomAt(player.x, player.y)?.id ?? null;

  const others = seenPlayers(view).filter((seat) => seat.playerId !== player.playerId);
  const bodies = seenBodies(view);

  for (const other of others) {
    if (!other.alive) continue;
    memory.sightings.unshift({
      playerId: other.playerId,
      roomId: roomAt(other.x, other.y)?.id ?? null,
      atMs: now,
    });

    // Standing over a corpse. The only piece of hard evidence in the game that
    // does not require somebody to be believed, and an inattentive bot walks
    // straight past it.
    if (!notices(player.personality ?? { read: 0.5 })) continue;
    for (const body of bodies) {
      if (distance(other.x, other.y, body.x, body.y) <= 6) {
        memory.suspicion[other.playerId] = (memory.suspicion[other.playerId] ?? 0) + 0.6;
      }
    }

    // Climbing out of a vent, which only a traitor or a ghost is ever sent —
    // so in practice this is one traitor noticing another, and it is
    // deliberately harmless: allies do not accuse each other.
    if (other.venting) {
      memory.suspicion[other.playerId] = (memory.suspicion[other.playerId] ?? 0) + 0.9;
    }
  }

  // Memory, not a log. Two hundred sightings is more than any accusation needs
  // and the match would otherwise grow one every tick for twenty minutes.
  if (memory.sightings.length > 200) memory.sightings.length = 200;
}

/** Chooses what this bot is trying to do, and lays a path to it. */
function plan(step: BotStep): void {
  const { player, view } = step;
  const memory = player.memory!;
  const personality = player.personality ?? { blunderChance: 0.35, boldness: 0.5, read: 0.6, thinkMs: 1500 };

  // Daft, on purpose, and never illegal: it wanders off instead.
  if (blunders(personality)) {
    memory.intent = 'wander';
    memory.targetStationId = null;
    memory.targetPlayerId = null;
    routeTo(step, wanderPoint());
    return;
  }

  if (player.role === 'traitor') { planTraitor(step); return; }
  planCrew(step);
}

function planCrew(step: BotStep): void {
  const { player, view } = step;
  const memory = player.memory!;
  const personality = player.personality ?? { blunderChance: 0.35, boldness: 0.5, read: 0.6, thinkMs: 1500 };

  // A body in sight beats everything. Reporting it is how the crew gets a
  // meeting it did not have to spend an emergency on.
  const body = seenBodies(view)[0];
  if (body && notices(personality)) {
    memory.intent = 'report';
    memory.targetStationId = null;
    routeTo(step, body);
    return;
  }

  // The reactor is going. A crewmate who ignores it loses the match for
  // everybody, so this outranks tasks — for a bot that noticed the alarm.
  const sabotage = asRecord(view.sabotage);
  if (sabotage.kind === 'breach' && notices(personality)) {
    const held = asRecord(sabotage.holds);
    // Head for a switch nobody is holding; if both are held, the crew has it.
    const free = BREACH_STATIONS.filter((station) => held[station.id] !== true);
    if (free.length > 0) {
      const station = nearest(player, free);
      memory.intent = 'fix';
      memory.targetStationId = station.id;
      routeTo(step, station);
      return;
    }
  }

  const you = asRecord(view.you);
  const outstanding = taskList(you).filter((task) => !task.done);
  if (outstanding.length > 0) {
    const stations = outstanding
      .map((task) => TASK_STATIONS.find((station) => station.id === task.stationId))
      .filter((station): station is (typeof TASK_STATIONS)[number] => station !== undefined);

    if (stations.length > 0) {
      // Nearest first is both the sensible route and, usefully, the one that
      // keeps a bot in the room it is already in for a while — which is what
      // makes bots turn up as witnesses rather than as traffic.
      const station = personality.boldness >= 0.8 ? pick(stations) : nearest(player, stations);
      memory.intent = 'task';
      memory.targetStationId = station.id;
      routeTo(step, station);
      return;
    }
  }

  memory.intent = 'wander';
  memory.targetStationId = null;
  routeTo(step, wanderPoint());
}

function planTraitor(step: BotStep): void {
  const { player, view } = step;
  const memory = player.memory!;
  const personality = player.personality ?? { blunderChance: 0.35, boldness: 0.5, read: 0.6, thinkMs: 1500 };
  const you = asRecord(view.you);
  const ready = Number(you.killCooldownMs ?? 0) <= 0;

  const allies = new Set<string>([player.playerId, ...memory.allies]);
  const quarry = seenPlayers(view)
    .filter((seat) => seat.alive && !allies.has(seat.playerId));

  if (ready && quarry.length > 0) {
    // Alone, or near enough. A bot that is paying attention counts the other
    // people who can see the spot before it commits; one that is not simply
    // walks up to somebody in a crowded cafeteria and ruins its own match,
    // which is exactly what an easy traitor should do.
    const careful = notices(personality);
    const isolated = quarry.filter((target) => {
      if (!careful) return true;
      const witnesses = quarry.filter(
        (other) => other.playerId !== target.playerId
          && distance(other.x, other.y, target.x, target.y) <= WITNESS_RANGE,
      );
      return witnesses.length === 0;
    });

    const target = isolated.length > 0 ? nearest(player, isolated) : null;
    if (target !== null) {
      memory.intent = 'hunt';
      memory.targetPlayerId = target.playerId;
      memory.targetStationId = null;
      routeTo(step, target);
      return;
    }
  }

  // Nothing to hunt. Pull something, if the panel is clear — a bold character
  // reaches for the reactor, a cautious one takes the lights and the cover
  // they give.
  if (view.sabotage === null && ready) {
    const appetite = Math.round(personality.boldness * 100);
    if (randomInt(100) < appetite) {
      step.act({ type: 'sabotage', kind: personality.boldness >= 0.65 ? 'breach' : 'lights' });
      memory.intent = 'lurk';
      routeTo(step, wanderPoint());
      return;
    }
  }

  // Otherwise look busy. Standing at a console is visible to everybody else as
  // `working`, which is the whole point: a traitor who never does a task is a
  // traitor everybody notices.
  const outstanding = taskList(you).filter((task) => !task.done);
  const stations = outstanding
    .map((task) => TASK_STATIONS.find((station) => station.id === task.stationId))
    .filter((station): station is (typeof TASK_STATIONS)[number] => station !== undefined);

  if (stations.length > 0) {
    const station = nearest(player, stations);
    memory.intent = 'task';
    memory.targetStationId = station.id;
    routeTo(step, station);
    return;
  }

  memory.intent = 'wander';
  routeTo(step, wanderPoint());
}

/** Walks the current path, one tick's worth. */
function steer(step: BotStep): void {
  const { player, act } = step;
  const memory = player.memory!;

  while (memory.path.length > 0
    && distance(player.x, player.y, memory.path[0]!.x, memory.path[0]!.y) <= ARRIVE) {
    memory.path.shift();
  }

  const next = memory.path[0];
  if (!next) { act({ type: 'move', dx: 0, dy: 0 }); return; }

  const dx = next.x - player.x;
  const dy = next.y - player.y;
  const span = Math.hypot(dx, dy) || 1;
  act({ type: 'move', dx: dx / span, dy: dy / span });
}

/** Does the thing it walked all this way to do, once it is close enough. */
function reach(step: BotStep): void {
  const { player, view, act } = step;
  const memory = player.memory!;

  switch (memory.intent) {
    case 'task':
    case 'fix': {
      const stationId = memory.targetStationId;
      if (stationId === null) return;

      if (memory.intent === 'fix') return; // Standing on the switch *is* the fix.

      const station = TASK_STATIONS.find((entry) => entry.id === stationId);
      if (!station) return;
      if (distance(player.x, player.y, station.x, station.y) > INTERACT) return;
      if (player.working !== null) return;
      act({ type: 'task', stationId });
      return;
    }

    case 'report': {
      const body = seenBodies(view)[0];
      if (!body) return;
      if (distance(player.x, player.y, body.x, body.y) > INTERACT) return;
      act({ type: 'report' });
      memory.intent = 'wander';
      return;
    }

    case 'hunt': {
      const targetId = memory.targetPlayerId;
      if (targetId === null) return;
      const target = seenPlayers(view).find((seat) => seat.playerId === targetId);
      if (!target || !target.alive) { memory.intent = 'wander'; return; }
      if (distance(player.x, player.y, target.x, target.y) > STRIKE) return;

      act({ type: 'eliminate', targetId });

      // Straight down the nearest vent if there is one to hand. Leaving the
      // body where it was standing is what a traitor with no exit has to do,
      // and it is also how they get caught.
      const vent = VENTS.find((entry) => distance(player.x, player.y, entry.x, entry.y) <= INTERACT);
      if (vent) act({ type: 'vent' });

      memory.intent = 'wander';
      memory.targetPlayerId = null;
      memory.path = [];
      return;
    }

    default:
      return;
  }
}

/**
 * Turns a walk across the ship into a list of points.
 *
 * Waypoints first, then the destination itself, so the last stride is a
 * straight line to the console rather than to the middle of the room it is in.
 */
function routeTo(step: BotStep, destination: { x: number; y: number }): void {
  const { player } = step;
  const memory = player.memory!;

  const from = nearestNav(player.x, player.y);
  const to = nearestNav(destination.x, destination.y);

  if (from === null || to === null) {
    memory.path = [destination];
    return;
  }

  const hops = pathBetween(from.id, to.id).map((node) => ({ x: node.x, y: node.y }));
  memory.path = [...hops, destination];
}

/** Somewhere to go when there is nothing to do. Always a real room. */
function wanderPoint(): { x: number; y: number } {
  const station = pick(TASK_STATIONS);
  return { x: station.x, y: station.y };
}

function nearest<T extends { x: number; y: number }>(from: { x: number; y: number }, items: readonly T[]): T {
  let best = items[0]!;
  let bestSpan = Infinity;
  for (const item of items) {
    const span = distance(from.x, from.y, item.x, item.y);
    if (span < bestSpan) { best = item; bestSpan = span; }
  }
  return best;
}

// ---------------------------------------------------------------------------
// Meetings
// ---------------------------------------------------------------------------

/**
 * What a bot brings into the room when a meeting opens.
 *
 * Only its own sightings, weighted by how recent they are and whether they put
 * somebody with the victim. A bot that saw nothing arrives with nothing, which
 * is the correct and frequently useless contribution of an actual player.
 */
export function rememberMeeting(player: SpacePlayer, bodyOf: string | null): void {
  const memory = player.memory;
  if (!memory) return;

  memory.path = [];
  memory.targetPlayerId = null;

  if (bodyOf === null) return;

  const now = Date.now();
  const victimRooms = memory.sightings
    .filter((sighting) => sighting.playerId === bodyOf && now - sighting.atMs < 45_000)
    .map((sighting) => sighting.roomId);
  if (victimRooms.length === 0) return;

  const rooms = new Set(victimRooms);
  for (const sighting of memory.sightings) {
    if (now - sighting.atMs > 45_000) continue;
    if (sighting.playerId === bodyOf) continue;
    if (!rooms.has(sighting.roomId)) continue;
    // Seen in the same room as the victim, shortly before the victim stopped
    // being alive. Circumstantial, and that is what a meeting is made of.
    memory.suspicion[sighting.playerId] = (memory.suspicion[sighting.playerId] ?? 0) + 0.35;
  }
}

/**
 * Who this bot votes for, or `null` to skip.
 *
 * Crew vote their suspicions when they have one worth acting on and skip when
 * they do not, because a crew that ejects somebody every meeting loses to
 * arithmetic. Traitors vote to survive: never an ally, and preferably whoever
 * is pointing at them.
 */
export function botVote(player: SpacePlayer, match: SpaceMatch, view: View): string | null {
  const memory = player.memory;
  const personality = player.personality;
  if (!memory || !personality) return null;

  // In a meeting the projection is open to everybody, so this is the same
  // roster every player at the table is looking at.
  const candidates = seenPlayers(view)
    .filter((seat) => seat.alive && seat.playerId !== player.playerId);
  if (candidates.length === 0) return null;

  if (blunders(personality)) {
    return randomInt(3) === 0 ? null : pick(candidates).playerId;
  }

  if (player.role === 'traitor') {
    const allies = new Set(memory.allies);
    const targets = candidates.filter((seat) => !allies.has(seat.playerId));
    if (targets.length === 0) return null;

    // Whoever named this bot out loud is the immediate problem.
    const accuser = meetingSaid(view).find(
      (line) => line.text.includes(player.username) && targets.some((seat) => seat.playerId === line.playerId),
    );
    if (accuser) return accuser.playerId;

    // Otherwise push the vote at whoever the table already doubts, which a
    // traitor can read from the meeting exactly as anybody else can.
    const heat = targets
      .map((seat) => ({ seat, score: Number(memory.suspicion[seat.playerId] ?? 0) }))
      .sort((a, b) => b.score - a.score);
    return (heat[0]?.score ?? 0) > 0 ? heat[0]!.seat.playerId : pick(targets).playerId;
  }

  const ranked = candidates
    .map((seat) => ({ seat, score: Number(memory.suspicion[seat.playerId] ?? 0) }))
    .sort((a, b) => b.score - a.score);
  const leader = ranked[0];

  // A bold crewmate ejects on a hunch; a careful one wants to have actually
  // seen something. Below the bar it skips, which is usually right.
  const bar = 0.9 - personality.boldness * 0.5;
  if (!leader || leader.score < bar) return null;
  return leader.seat.playerId;
}

/**
 * One line of table talk, or `null` if this bot has nothing to say.
 *
 * Canned, obviously — the alternative is a language model in the tick loop —
 * but assembled from what this bot actually saw, so the accusations are true
 * to its own evidence and the alibis are true to where it actually was. A bot
 * that says it was in the reactor was in the reactor.
 */
export function botSpeech(player: SpacePlayer, match: SpaceMatch, view: View): string | null {
  const memory = player.memory;
  if (!memory) return null;

  const names = new Map(seenPlayers(view).map((seat) => [seat.playerId, seat.username]));
  const room = memory.lastRoomId;
  const where = room === null ? 'the corridors' : roomName(room);

  const ranked = Object.entries(memory.suspicion)
    .filter(([id]) => id !== player.playerId && names.has(id))
    .sort(([, a], [, b]) => b - a);
  const top = ranked[0];

  if (player.role === 'traitor') {
    // A traitor's alibi is the only thing it says that is reliably false.
    if (top && top[1] >= 0.6 && randomInt(2) === 0) {
      return `Not sure about ${names.get(top[0])}. Where were you?`;
    }
    return pick([
      `I was in ${where} the whole time.`,
      `Just came from ${where}. Nothing down there.`,
      `Don't look at me, I was doing wiring in ${where}.`,
    ]);
  }

  if (top && top[1] >= 0.6) {
    return pick([
      `${names.get(top[0])} was right next to the body.`,
      `I saw ${names.get(top[0])} acting strange. That's my vote.`,
      `It's ${names.get(top[0])}. I watched them.`,
    ]);
  }

  if (top && top[1] >= 0.3) {
    return `${names.get(top[0])} was near them not long ago. Could be nothing.`;
  }

  return pick([
    `I was in ${where}, saw nobody.`,
    `Nothing from me. I was on tasks in ${where}.`,
    `No idea. Skipping unless somebody has something.`,
  ]);
}

// ---------------------------------------------------------------------------
// Reading the projection. Every accessor below takes the *view*, on purpose.
// ---------------------------------------------------------------------------

interface SeenPlayer {
  playerId: string;
  username: string;
  x: number;
  y: number;
  alive: boolean;
  venting: boolean;
}

function seenPlayers(view: View): SeenPlayer[] {
  if (!Array.isArray(view.players)) return [];
  return view.players.flatMap((row) => {
    const seat = asRecord(row);
    return typeof seat.playerId === 'string'
      ? [{
          playerId: seat.playerId,
          username: typeof seat.username === 'string' ? seat.username : 'Somebody',
          x: Number(seat.x) || 0,
          y: Number(seat.y) || 0,
          alive: seat.alive !== false,
          venting: seat.venting === true,
        }]
      : [];
  });
}

function seenBodies(view: View): { playerId: string; x: number; y: number }[] {
  if (!Array.isArray(view.bodies)) return [];
  return view.bodies.flatMap((row) => {
    const body = asRecord(row);
    return typeof body.playerId === 'string'
      ? [{ playerId: body.playerId, x: Number(body.x) || 0, y: Number(body.y) || 0 }]
      : [];
  });
}

function taskList(you: Record<string, unknown>): { stationId: string; done: boolean }[] {
  if (!Array.isArray(you.tasks)) return [];
  return you.tasks.flatMap((row) => {
    const task = asRecord(row);
    return typeof task.stationId === 'string'
      ? [{ stationId: task.stationId, done: task.done === true }]
      : [];
  });
}

function meetingSaid(view: View): { playerId: string; text: string }[] {
  const meeting = asRecord(view.meeting);
  if (!Array.isArray(meeting.said)) return [];
  return meeting.said.flatMap((row) => {
    const line = asRecord(row);
    return typeof line.playerId === 'string' && typeof line.text === 'string'
      ? [{ playerId: line.playerId, text: line.text }]
      : [];
  });
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function roomName(roomId: string): string {
  return ROOM_NAMES[roomId] ?? roomId;
}

const ROOM_NAMES: Readonly<Record<string, string>> = {
  bridge: 'the bridge',
  observatory: 'the observatory',
  medbay: 'med bay',
  reactor: 'the reactor',
  cafeteria: 'the cafeteria',
  comms: 'comms',
  engine: 'the engine bay',
  storage: 'storage',
  cargo: 'the cargo hold',
};
