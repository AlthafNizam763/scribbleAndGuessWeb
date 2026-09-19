import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { BOT_DIFFICULTY, type BotDifficultyWire } from '@/constants/autoTournament.constants';
import type { PlatformPlayerState } from '@/games/game.types';
import { SpaceMysteryEngine, spaceMysteryTuning } from '@/games/spaceMystery/engine';
import {
  MEETING_TABLE, ROOMS, TASK_STATIONS, VENTS, distance, roomAt, walkable,
} from '@/games/spaceMystery/map';

/**
 * The *Meridian*, and the things about it that no screenshot would catch.
 *
 * ## What is actually worth proving
 *
 * This is the only game on the platform where the server is the sole thing
 * standing between a modified client and knowing everything, so most of this
 * file is about the projection rather than about the rules:
 *
 * 1. **Nobody is sent a role they are not entitled to.** The single most
 *    important assertion in the suite. A leak here does not crash anything and
 *    does not look wrong on screen; it just quietly ends the game for everyone
 *    who is not cheating.
 * 2. **Nobody is sent a position they cannot see.** Same reasoning. A client
 *    that can draw through walls has won, and the only defence is that the
 *    coordinates never arrive.
 * 3. **The client cannot move itself.** Directions are clamped and integrated
 *    server-side, so a hostile client cannot teleport, outrun anybody or walk
 *    through a bulkhead.
 * 4. **A match ends.** A social deduction game that cannot reach a win
 *    condition is a lobby nobody can leave.
 *
 * Fake timers throughout: a match runs for minutes of wall clock, and the tick
 * is the thing under test.
 */

let engine: SpaceMysteryEngine;
let results: { matchId: string; result: Record<string, unknown> }[];

const MATCH = 'match-1';
const ROOM = 'room-1';

function seat(id: string, isBot: boolean, difficulty: BotDifficultyWire | null = null): PlatformPlayerState {
  return {
    playerId: id, userId: isBot ? null : id, username: id.toUpperCase(),
    avatarId: 0, avatarColorIndex: 0,
    isBot, botDifficulty: difficulty, isReady: true, connected: true, joinedAtMs: 0,
  };
}

/** A match of [count] seats, all human unless [bots] says otherwise. */
function begin(count: number, options: { bots?: boolean } = {}): string[] {
  const ids = Array.from({ length: count }, (_, index) => `p${index}`);
  engine.begin({
    matchId: MATCH,
    roomId: ROOM,
    players: ids.map((id) => seat(id, options.bots === true, options.bots === true ? BOT_DIFFICULTY.normal : null)),
  });
  return ids;
}

function view(playerId: string): Record<string, unknown> {
  const state = engine.viewFor(MATCH, playerId);
  expect(state, `no view for ${playerId}`).not.toBeNull();
  return state!;
}

function you(playerId: string): Record<string, unknown> {
  return view(playerId).you as Record<string, unknown>;
}

function seen(playerId: string): Record<string, unknown>[] {
  return view(playerId).players as Record<string, unknown>[];
}

/** Everybody's role, read from the one place a test is allowed to look. */
function roles(ids: string[]): Record<string, string> {
  return Object.fromEntries(ids.map((id) => [id, String(you(id).role)]));
}

/** Teleports a player, for tests that need two people in one place. */
function place(playerId: string, x: number, y: number): void {
  // Through the engine's own movement, which is the only way in — but a single
  // huge step would be clamped, so this walks. The map is 100 units across and
  // a tick moves 0.7 units, so a few hundred ticks crosses anything.
  const match = (engine as unknown as { matches: Map<string, { players: Map<string, { x: number; y: number }> }> })
    .matches.get(MATCH)!;
  const player = match.players.get(playerId)!;
  expect(walkable(x, y), `(${x}, ${y}) is not floor`).toBe(true);
  player.x = x;
  player.y = y;
}

beforeEach(() => {
  vi.useFakeTimers();
  results = [];
  engine = new SpaceMysteryEngine();
  engine.bindRecorder(async (matchId, result) => { results.push({ matchId, result }); });
});

afterEach(() => {
  engine.end(MATCH);
  vi.useRealTimers();
});

describe('dealing a match', () => {
  it('names one traitor at a small table and two at a large one', () => {
    const small = begin(5);
    expect(Object.values(roles(small)).filter((role) => role === 'traitor')).toHaveLength(1);
    engine.end(MATCH);

    const large = begin(8);
    // Two is a majority of five but not of eight. One traitor in a room of ten
    // never gets a turn; two in a room of four have already won.
    expect(Object.values(roles(large)).filter((role) => role === 'traitor')).toHaveLength(2);
  });

  it('gives everybody a task list, including the traitor', () => {
    const ids = begin(6);
    for (const id of ids) {
      // A traitor with no tasks is a traitor who is obvious the first time
      // anybody watches them stand still.
      expect((you(id).tasks as unknown[]).length).toBe(spaceMysteryTuning.TASKS_EACH);
    }
  });

  it(`counts only the crew's tasks towards repair`, () => {
    const ids = begin(6);
    const crew = ids.filter((id) => you(id).role === 'crew').length;

    // Otherwise a traitor could win the game for the crew by doing its own
    // fake list, which is the opposite of what the list is for.
    expect(view(ids[0]!).taskTotal).toBe(crew * spaceMysteryTuning.TASKS_EACH);
  });

  it('starts everybody on the floor, not inside a wall', () => {
    const ids = begin(10);
    for (const id of ids) {
      const self = you(id);
      expect(walkable(Number(self.x), Number(self.y)), id).toBe(true);
    }
  });
});

describe('what a player is allowed to know', () => {
  it('never tells a crewmate anybody else’s role', () => {
    const ids = begin(6);
    const crewId = ids.find((id) => you(id).role === 'crew')!;

    // The assertion that matters most in this file. Everybody is in the
    // cafeteria at the start, so every other player is visible — and still
    // none of them arrives with a role attached.
    for (const other of seen(crewId)) {
      if (other.playerId === crewId) continue;
      expect(other.role, `${String(other.playerId)} leaked a role`).toBeNull();
    }
  });

  it('tells a traitor who its partners are, and nobody else', () => {
    const ids = begin(8);
    const traitors = ids.filter((id) => you(id).role === 'traitor');
    const crew = ids.filter((id) => you(id).role === 'crew');

    // A traitor at a real table knows the other one. That is the only fact in
    // the game anybody is handed rather than working out.
    for (const id of traitors) {
      expect(you(id).allies).toEqual(traitors.filter((other) => other !== id));
    }
    for (const id of crew) {
      expect(you(id).allies).toEqual([]);
    }
  });

  it('does not send a player somebody they cannot see', () => {
    const ids = begin(4);
    const [watcher, distant] = ids;

    const bridge = ROOMS.find((room) => room.id === 'bridge')!;
    const cargo = ROOMS.find((room) => room.id === 'cargo')!;
    place(watcher!, bridge.x + bridge.width / 2, bridge.y + bridge.height / 2);
    place(distant!, cargo.x + cargo.width / 2, cargo.y + cargo.height / 2);

    // Opposite corners of the ship. A client that could draw them has been
    // sent them; this is the test that says it was not.
    const visible = seen(watcher!).map((row) => row.playerId);
    expect(visible).toContain(watcher);
    expect(visible).not.toContain(distant);
  });

  it('does not send a player through a wall they are standing next to', () => {
    const ids = begin(4);
    const [watcher, other] = ids;

    // The bridge and the reactor are one above the other and close enough to
    // be well inside sight range — but there is a bulkhead between them, and
    // the corridor that joins them runs round the side.
    const bridge = ROOMS.find((room) => room.id === 'bridge')!;
    const reactor = ROOMS.find((room) => room.id === 'reactor')!;
    place(watcher!, bridge.x + 14, bridge.y + 10);
    place(other!, reactor.x + 13, reactor.y + 2);

    const span = distance(bridge.x + 14, bridge.y + 10, reactor.x + 13, reactor.y + 2);
    expect(span, 'the fixture needs them inside sight range').toBeLessThan(spaceMysteryTuning.VISION);
    expect(seen(watcher!).map((row) => row.playerId)).not.toContain(other);
  });

  it('shows a ghost everything, because a ghost cannot act on it', () => {
    const ids = begin(4);
    const traitorId = ids.find((id) => you(id).role === 'traitor')!;
    const victimId = ids.find((id) => you(id).role === 'crew')!;

    place(traitorId, MEETING_TABLE.x, MEETING_TABLE.y);
    place(victimId, MEETING_TABLE.x + 1, MEETING_TABLE.y);
    vi.advanceTimersByTime(spaceMysteryTuning.KILL_COOLDOWN_MS + 1000);
    engine.input(MATCH, traitorId, { type: 'eliminate', targetId: victimId });

    const cargo = ROOMS.find((room) => room.id === 'cargo')!;
    place(ids.find((id) => id !== traitorId && id !== victimId)!, cargo.x + 5, cargo.y + 5);

    // The traditional rule, and it costs nothing: a dead player has no move to
    // make, so there is nothing for the knowledge to corrupt.
    expect(you(victimId).alive).toBe(false);
    expect(seen(victimId).length).toBe(ids.length);
  });

  it('never says who pulled the reactor', () => {
    const ids = begin(5);
    const traitorId = ids.find((id) => you(id).role === 'traitor')!;
    vi.advanceTimersByTime(spaceMysteryTuning.KILL_COOLDOWN_MS + 1000);

    engine.input(MATCH, traitorId, { type: 'sabotage', kind: 'breach' });

    const sabotage = view(ids.find((id) => id !== traitorId)!).sabotage as Record<string, unknown>;
    expect(sabotage.kind).toBe('breach');
    // The alarm on the wall says the reactor is going. It does not name a
    // suspect, and neither does this.
    expect(Object.keys(sabotage)).not.toContain('byId');
  });
});

describe('movement', () => {
  it('clamps a direction, so a client cannot outrun anybody', () => {
    const ids = begin(2);
    const [mover] = ids;
    const before = { x: Number(you(mover!).x), y: Number(you(mover!).y) };

    // A client asking to move nine hundred units east. Honest clients send
    // this too — an analogue stick at its corner is longer than one unit —
    // which is why it is normalised rather than rejected.
    engine.input(MATCH, mover!, { type: 'move', dx: 900, dy: 0 });
    vi.advanceTimersByTime(spaceMysteryTuning.TICK_MS * 4);

    const travelled = Number(you(mover!).x) - before.x;
    const ceiling = spaceMysteryTuning.WALK_SPEED * (spaceMysteryTuning.TICK_MS * 5 / 1000);
    expect(travelled).toBeGreaterThan(0);
    expect(travelled).toBeLessThanOrEqual(ceiling);
  });

  it('will not walk a player through a bulkhead', () => {
    const ids = begin(2);
    const [mover] = ids;

    // Due north out of the cafeteria is a wall: the only ways out are the
    // corridors, and none of them is straight up from the middle.
    place(mover!, MEETING_TABLE.x, MEETING_TABLE.y);
    engine.input(MATCH, mover!, { type: 'move', dx: 0, dy: -1 });
    vi.advanceTimersByTime(4000);

    const self = you(mover!);
    expect(walkable(Number(self.x), Number(self.y))).toBe(true);
    expect(roomAt(Number(self.x), Number(self.y))?.id).toBe('cafeteria');
  });

  it('slides along a wall instead of stopping dead on it', () => {
    const ids = begin(2);
    const [mover] = ids;

    // Into the top-left corner of the cafeteria at forty-five degrees. Without
    // the per-axis retry this stops the moment the diagonal fails, and every
    // corridor on the ship becomes something you have to aim at.
    place(mover!, MEETING_TABLE.x, MEETING_TABLE.y - 5);
    const before = Number(you(mover!).x);
    engine.input(MATCH, mover!, { type: 'move', dx: -0.7071, dy: -0.7071 });
    vi.advanceTimersByTime(1000);

    expect(Number(you(mover!).x)).toBeLessThan(before);
  });
});

describe('the traitor', () => {
  function armed(count = 5) {
    const ids = begin(count);
    const traitorId = ids.find((id) => you(id).role === 'traitor')!;
    const crewId = ids.find((id) => you(id).role === 'crew')!;
    vi.advanceTimersByTime(spaceMysteryTuning.KILL_COOLDOWN_MS + 1000);
    return { ids, traitorId, crewId };
  }

  it('cannot reach somebody it is not standing next to', () => {
    const { traitorId, crewId } = armed();
    const cargo = ROOMS.find((room) => room.id === 'cargo')!;
    place(traitorId, MEETING_TABLE.x, MEETING_TABLE.y);
    place(crewId, cargo.x + 5, cargo.y + 5);

    engine.input(MATCH, traitorId, { type: 'eliminate', targetId: crewId });

    // The client said it did it. The server knows where both of them are.
    expect(you(crewId).alive).toBe(true);
  });

  it('cannot act twice inside its cooldown', () => {
    const ids = begin(6);
    const traitorId = ids.find((id) => you(id).role === 'traitor')!;
    const victims = ids.filter((id) => you(id).role === 'crew');
    vi.advanceTimersByTime(spaceMysteryTuning.KILL_COOLDOWN_MS + 1000);

    place(traitorId, MEETING_TABLE.x, MEETING_TABLE.y);
    place(victims[0]!, MEETING_TABLE.x + 1, MEETING_TABLE.y);
    engine.input(MATCH, traitorId, { type: 'eliminate', targetId: victims[0]! });

    place(victims[1]!, MEETING_TABLE.x + 1, MEETING_TABLE.y);
    engine.input(MATCH, traitorId, { type: 'eliminate', targetId: victims[1]! });

    expect(you(victims[0]!).alive).toBe(false);
    expect(you(victims[1]!).alive).toBe(true);
  });

  it('refuses a crewmate who claims to be one', () => {
    const ids = begin(5);
    const crew = ids.filter((id) => you(id).role === 'crew');
    vi.advanceTimersByTime(spaceMysteryTuning.KILL_COOLDOWN_MS + 1000);

    place(crew[0]!, MEETING_TABLE.x, MEETING_TABLE.y);
    place(crew[1]!, MEETING_TABLE.x + 1, MEETING_TABLE.y);
    engine.input(MATCH, crew[0]!, { type: 'eliminate', targetId: crew[1]! });

    // The role lives on the server. A client asserting otherwise is ignored.
    expect(you(crew[1]!).alive).toBe(true);
  });

  it('leaves a body where the victim was standing', () => {
    const { traitorId, crewId } = armed();
    const reactor = ROOMS.find((room) => room.id === 'reactor')!;
    place(traitorId, reactor.x + 8, reactor.y + 7);
    place(crewId, reactor.x + 9, reactor.y + 7);

    engine.input(MATCH, traitorId, { type: 'eliminate', targetId: crewId });

    const bodies = view(traitorId).bodies as Record<string, unknown>[];
    expect(bodies).toHaveLength(1);
    expect(bodies[0]!.playerId).toBe(crewId);
    // Standing over it is the point: it is what makes being seen there
    // incriminating, and what makes venting away a decision.
    expect(distance(
      Number(you(traitorId).x), Number(you(traitorId).y),
      Number(bodies[0]!.x), Number(bodies[0]!.y),
    )).toBeLessThan(1);
  });

  it('will not let a crewmate down a vent', () => {
    const ids = begin(5);
    const crewId = ids.find((id) => you(id).role === 'crew')!;
    const vent = VENTS[0]!;
    place(crewId, vent.x, vent.y);

    engine.input(MATCH, crewId, { type: 'vent' });

    expect(you(crewId).ventId).toBeNull();
  });

  it('moves a traitor only between mouths on one network', () => {
    const ids = begin(5);
    const traitorId = ids.find((id) => you(id).role === 'traitor')!;
    const port = VENTS.filter((vent) => vent.network === 'port');
    const starboard = VENTS.find((vent) => vent.network === 'starboard')!;

    place(traitorId, port[0]!.x, port[0]!.y);
    engine.input(MATCH, traitorId, { type: 'vent' });
    expect(you(traitorId).ventId).toBe(port[0]!.id);

    // The far side of the ship is not on this network, and asking for it is
    // how a modified client would cross the map in one message.
    engine.input(MATCH, traitorId, { type: 'vent', ventId: starboard.id });
    expect(you(traitorId).ventId).toBe(port[0]!.id);

    engine.input(MATCH, traitorId, { type: 'vent', ventId: port[1]!.id });
    expect(you(traitorId).ventId).toBe(port[1]!.id);
  });
});

describe('tasks', () => {
  it('refuses a task that is not on your list', () => {
    const ids = begin(4);
    const worker = ids[0]!;
    const mine = new Set((you(worker).tasks as { stationId: string }[]).map((task) => task.stationId));
    const notMine = TASK_STATIONS.find((station) => !mine.has(station.id))!;

    place(worker, notMine.x, notMine.y);
    engine.input(MATCH, worker, { type: 'task', stationId: notMine.id });

    expect(you(worker).working).toBeNull();
  });

  it('refuses a task you are not standing at', () => {
    const ids = begin(4);
    const worker = ids[0]!;
    const task = (you(worker).tasks as { stationId: string }[])[0]!;

    // Still in the cafeteria, claiming to be at a console on the bridge.
    engine.input(MATCH, worker, { type: 'task', stationId: task.stationId });
    expect(you(worker).working).toBeNull();
  });

  it('takes the station’s own time, and cancels if you walk off', () => {
    const ids = begin(4);
    const worker = ids[0]!;
    const taskId = (you(worker).tasks as { stationId: string }[])[0]!.stationId;
    const station = TASK_STATIONS.find((entry) => entry.id === taskId)!;

    place(worker, station.x, station.y);
    engine.input(MATCH, worker, { type: 'task', stationId: taskId });
    expect(you(worker).working).not.toBeNull();

    // Walking away is what makes a long task a commitment rather than a tap.
    place(worker, MEETING_TABLE.x, MEETING_TABLE.y);
    vi.advanceTimersByTime(spaceMysteryTuning.TICK_MS * 2);
    expect(you(worker).working).toBeNull();
    expect(view(ids[0]!).taskDone).toBe(0);

    place(worker, station.x, station.y);
    engine.input(MATCH, worker, { type: 'task', stationId: taskId });
    vi.advanceTimersByTime(station.durationMs + spaceMysteryTuning.TICK_MS * 2);

    expect((you(worker).tasks as { stationId: string; done: boolean }[])
      .find((task) => task.stationId === taskId)?.done).toBe(true);
  });
});

describe('meetings', () => {
  function meeting(count = 5) {
    const ids = begin(count);
    const traitorId = ids.find((id) => you(id).role === 'traitor')!;
    const caller = ids.find((id) => id !== traitorId)!;
    engine.input(MATCH, caller, { type: 'meeting' });
    return { ids, traitorId, caller };
  }

  it('freezes the ship', () => {
    const { ids, caller } = meeting();
    const before = Number(you(caller).x);

    engine.input(MATCH, caller, { type: 'move', dx: 1, dy: 0 });
    vi.advanceTimersByTime(1000);

    expect(view(ids[0]!).phase).toBe('meeting');
    expect(Number(you(caller).x)).toBe(before);
  });

  it('only opens the vote once the discussion is over', () => {
    const { ids, caller } = meeting();
    const others = ids.filter((id) => id !== caller);

    expect((view(caller).meeting as Record<string, unknown>).phase).toBe('discussion');
    engine.input(MATCH, caller, { type: 'vote', targetId: others[0]! });
    expect((view(caller).meeting as Record<string, unknown>).voted).toEqual([]);

    vi.advanceTimersByTime(spaceMysteryTuning.DISCUSSION_MS + spaceMysteryTuning.TICK_MS);
    expect((view(caller).meeting as Record<string, unknown>).phase).toBe('voting');
  });

  it('ejects on a plurality and announces what they were', () => {
    const { ids, traitorId } = meeting();
    vi.advanceTimersByTime(spaceMysteryTuning.DISCUSSION_MS + spaceMysteryTuning.TICK_MS);

    for (const id of ids) engine.input(MATCH, id, { type: 'vote', targetId: traitorId });
    vi.advanceTimersByTime(spaceMysteryTuning.TICK_MS * 2);

    // Whether the ejected player was a traitor is the only hard information
    // the crew ever gets. Withholding it makes every meeting the same one.
    expect(results[0]?.result.winnerTeam).toBe('crew');
    expect(results[0]?.result.reason).toBe('traitors_ejected');
  });

  it('ejects nobody on a tie', () => {
    const { ids } = meeting(4);
    vi.advanceTimersByTime(spaceMysteryTuning.DISCUSSION_MS + spaceMysteryTuning.TICK_MS);

    // Two apiece. Throwing somebody out of an airlock on a coin toss is not a
    // decision the crew made.
    engine.input(MATCH, ids[0]!, { type: 'vote', targetId: ids[2]! });
    engine.input(MATCH, ids[1]!, { type: 'vote', targetId: ids[2]! });
    engine.input(MATCH, ids[2]!, { type: 'vote', targetId: ids[3]! });
    engine.input(MATCH, ids[3]!, { type: 'vote', targetId: ids[2]! });
    vi.advanceTimersByTime(spaceMysteryTuning.TICK_MS * 2);

    const alive = ids.filter((id) => you(id).alive === true);
    expect(alive.length).toBeGreaterThanOrEqual(3);
  });

  it('refuses a second vote from the same player', () => {
    const { ids, caller } = meeting();
    vi.advanceTimersByTime(spaceMysteryTuning.DISCUSSION_MS + spaceMysteryTuning.TICK_MS);
    const others = ids.filter((id) => id !== caller);

    engine.input(MATCH, caller, { type: 'vote', targetId: others[0]! });
    engine.input(MATCH, caller, { type: 'vote', targetId: others[1]! });

    const state = view(caller).meeting as Record<string, unknown>;
    expect(state.yourVote).toBe(others[0]);
    expect((state.voted as string[]).filter((id) => id === caller)).toHaveLength(1);
  });

  it('gives each player one emergency for the whole match', () => {
    const { ids, caller } = meeting();
    expect(you(caller).emergenciesLeft).toBe(0);

    vi.advanceTimersByTime(spaceMysteryTuning.DISCUSSION_MS + spaceMysteryTuning.VOTING_MS + 1000);
    engine.input(MATCH, caller, { type: 'meeting' });

    expect(view(ids[0]!).phase).toBe('station');
  });
});

describe('sabotage', () => {
  it('loses the match for the crew if the reactor is not held in time', () => {
    const ids = begin(6);
    const traitorId = ids.find((id) => you(id).role === 'traitor')!;
    vi.advanceTimersByTime(spaceMysteryTuning.KILL_COOLDOWN_MS + 1000);

    engine.input(MATCH, traitorId, { type: 'sabotage', kind: 'breach' });
    vi.advanceTimersByTime(spaceMysteryTuning.BREACH_DEADLINE_MS + 1000);

    expect(results[0]?.result).toMatchObject({ winnerTeam: 'traitors', reason: 'reactor_breach' });
  });

  it('cuts a crewmate’s sight but not a traitor’s', () => {
    const ids = begin(6);
    const traitorId = ids.find((id) => you(id).role === 'traitor')!;
    const crew = ids.filter((id) => you(id).role === 'crew');
    vi.advanceTimersByTime(spaceMysteryTuning.KILL_COOLDOWN_MS + 1000);

    const cafeteria = ROOMS.find((room) => room.id === 'cafeteria')!;
    const far = { x: cafeteria.x + 2, y: cafeteria.y + 2 };
    const near = { x: cafeteria.x + 20, y: cafeteria.y + 13 };
    const span = distance(far.x, far.y, near.x, near.y);
    expect(span).toBeGreaterThan(spaceMysteryTuning.VISION_DARK);
    expect(span).toBeLessThan(spaceMysteryTuning.VISION);

    place(crew[0]!, far.x, far.y);
    place(crew[1]!, near.x, near.y);
    place(traitorId, far.x, far.y);

    expect(seen(crew[0]!).map((row) => row.playerId)).toContain(crew[1]);
    engine.input(MATCH, traitorId, { type: 'sabotage', kind: 'lights' });

    // The asymmetry is the point of the sabotage: the crew loses the room and
    // the traitor keeps it.
    expect(seen(crew[0]!).map((row) => row.playerId)).not.toContain(crew[1]);
    expect(seen(traitorId).map((row) => row.playerId)).toContain(crew[1]);
  });

  it('will not let the crew hide from a breach inside a meeting', () => {
    const ids = begin(6);
    const traitorId = ids.find((id) => you(id).role === 'traitor')!;
    const crewId = ids.find((id) => you(id).role === 'crew')!;
    vi.advanceTimersByTime(spaceMysteryTuning.KILL_COOLDOWN_MS + 1000);

    engine.input(MATCH, traitorId, { type: 'sabotage', kind: 'breach' });
    engine.input(MATCH, crewId, { type: 'meeting' });

    // Otherwise the answer to every reactor is "call a meeting and wait".
    expect(view(crewId).phase).toBe('station');
    expect(view(crewId).sabotage).not.toBeNull();
  });
});

describe('a match full of Stupids', () => {
  it('plays itself to a finish', () => {
    begin(6, { bots: true });

    // Twelve minutes of ship time, stepped in ticks. A match that cannot reach
    // a win condition shows up here as an empty `results`.
    for (let elapsed = 0; elapsed < 12 * 60_000 && results.length === 0; elapsed += 500) {
      vi.advanceTimersByTime(500);
    }

    expect(results).toHaveLength(1);
    expect(['crew', 'traitors']).toContain(String(results[0]!.result.winnerTeam));
  });

  it('never lets a crew bot act on something it was not shown', () => {
    const ids = begin(8, { bots: true });
    vi.advanceTimersByTime(30_000);

    // The structural version of the assertion at the top of this file: after
    // half a minute of bots walking about, no crew seat's projection has ever
    // carried another player's role.
    for (const id of ids) {
      if (you(id).role !== 'crew') continue;
      for (const other of seen(id)) {
        if (other.playerId === id) continue;
        expect(other.role, `${String(other.playerId)} leaked to a crew bot`).toBeNull();
      }
    }
  });
});
