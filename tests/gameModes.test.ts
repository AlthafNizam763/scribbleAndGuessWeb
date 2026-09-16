import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ROOM_LIMITS } from '@/constants/game.constants';
import {
  GAME_MODE,
  GAME_MODES,
  GAME_MODES_LIST,
  TEAM,
  modeRules,
} from '@/constants/gameModes.constants';
import { gameModeService } from '@/services/gameMode.service';
import { spectatorService } from '@/services/spectator.service';
import { defaultSettings } from '@/services/room.service';
import { scoringService } from '@/services/scoring.service';
import { makePlayer, makeRoom } from './helpers';

/**
 * Game modes, teams and spectators.
 *
 * ## What is worth asserting
 *
 * The modes are a *table*, so the risk is not that one branch is wrong — there
 * are no branches — but that the table itself is inconsistent: a mode whose
 * minimum exceeds its maximum, or whose ceiling exceeds the room's. Those are
 * checked across the whole catalogue rather than one entry at a time.
 *
 * The spectator invariant is the one that matters most and is the hardest to
 * see: a spectator must be absent from `players`, because that absence is what
 * makes "cannot draw, cannot guess, cannot score" true without a check
 * anywhere. A test that only asserted the UI hides the toolbar would pass
 * while a watcher quietly joined the turn order.
 */

const ANA = '507f1f77bcf86cd799439011';
const BO = '507f1f77bcf86cd799439012';
const CID = '507f1f77bcf86cd799439013';
const DEE = '507f1f77bcf86cd799439014';

beforeEach(() => {
  vi.restoreAllMocks();
});

describe('the mode catalogue', () => {
  it('is internally consistent', () => {
    for (const mode of GAME_MODES) {
      expect(mode.minPlayers, mode.key).toBeGreaterThanOrEqual(2);
      expect(mode.maxPlayers, mode.key).toBeGreaterThanOrEqual(mode.minPlayers);
      expect(mode.scoreMultiplier, mode.key).toBeGreaterThan(0);
      expect(mode.name, mode.key).not.toHaveLength(0);
      expect(mode.description, mode.key).not.toHaveLength(0);
    }
  });

  /** A mode may make a room smaller. It may never make one bigger. */
  it('never exceeds the room ceiling', () => {
    for (const mode of GAME_MODES) {
      expect(mode.maxPlayers, mode.key).toBeLessThanOrEqual(ROOM_LIMITS.maxPlayers.max);
    }
  });

  it('has a unique key per mode', () => {
    expect(new Set(GAME_MODES_LIST).size).toBe(GAME_MODES_LIST.length);
  });

  /**
   * Forward compatibility, and the reason the stored field is a plain string:
   * a room saved under a mode this build has never heard of must still play.
   */
  it('falls back to Classic for an unknown mode', () => {
    expect(modeRules('from_the_future').key).toBe(GAME_MODE.classic);
    expect(modeRules(null).key).toBe(GAME_MODE.classic);
    expect(modeRules(undefined).key).toBe(GAME_MODE.classic);
  });

  it('gives exactly one mode each of the four behaviour flags', () => {
    expect(GAME_MODES.filter((mode) => mode.keepBoardBetweenTurns)).toHaveLength(1);
    expect(GAME_MODES.filter((mode) => !mode.drawerSeesBoard)).toHaveLength(1);
    expect(GAME_MODES.filter((mode) => mode.singleColor)).toHaveLength(1);
    expect(GAME_MODES.filter((mode) => mode.teams)).toHaveLength(1);
  });
});

describe('resolving a mode onto a room', () => {
  function settingsFor(gameMode: string) {
    return { ...defaultSettings(), gameMode };
  }

  it('leaves Classic alone', () => {
    const base = settingsFor(GAME_MODE.classic);
    const resolved = gameModeService.resolveSettings(base);

    expect(resolved.drawTimeSeconds).toBe(base.drawTimeSeconds);
    expect(resolved.hintCount).toBe(base.hintCount);
  });

  /** A Speed room whose host left the draw time at 80 is still Speed. */
  it('overrides the room where the mode has an opinion', () => {
    const resolved = gameModeService.resolveSettings({
      ...settingsFor(GAME_MODE.speed),
      drawTimeSeconds: 180,
    });

    expect(resolved.drawTimeSeconds).toBe(40);
    expect(resolved.hintCount).toBe(1);
  });

  it('withholds the word length entirely in No Hint', () => {
    const resolved = gameModeService.resolveSettings(settingsFor(GAME_MODE.noHint));

    expect(resolved.hintCount).toBe(0);
    expect(resolved.wordMode).toBe('hidden');
  });

  it('narrows the word pool in Challenge', () => {
    expect(
      gameModeService.resolveSettings(settingsFor(GAME_MODE.challenge)).wordDifficulty,
    ).toBe('hard');
  });

  /** Duo holds two people however `maxPlayers` was left. */
  it('narrows the seat count but never widens it', () => {
    const duo = gameModeService.resolveSettings({
      ...settingsFor(GAME_MODE.duo),
      maxPlayers: 12,
    });
    expect(duo.maxPlayers).toBe(2);

    const classic = gameModeService.resolveSettings({
      ...settingsFor(GAME_MODE.classic),
      maxPlayers: 4,
    });
    expect(classic.maxPlayers).toBe(4);
  });
});

describe('starting a match under a mode', () => {
  function roomIn(gameMode: string, playerIds: string[]) {
    const room = makeRoom({ players: playerIds.map((userId) => makePlayer({ userId })) });
    room.settings = { ...room.settings, gameMode };
    return room;
  }

  it('refuses a Duo room with three people', () => {
    const room = roomIn(GAME_MODE.duo, [ANA, BO, CID]);
    expect(() => gameModeService.assertCanStart(room, 3)).toThrow();
  });

  it('refuses a Team room with three people', () => {
    const room = roomIn(GAME_MODE.team, [ANA, BO, CID]);
    expect(() => gameModeService.assertCanStart(room, 3)).toThrow();
  });

  it('refuses a Relay room with two', () => {
    const room = roomIn(GAME_MODE.relay, [ANA, BO]);
    expect(() => gameModeService.assertCanStart(room, 2)).toThrow();
  });

  it('accepts a Classic room with two', () => {
    const room = roomIn(GAME_MODE.classic, [ANA, BO]);
    expect(() => gameModeService.assertCanStart(room, 2)).not.toThrow();
  });
});

describe('teams', () => {
  function teamRoom() {
    const room = makeRoom({
      players: [ANA, BO, CID, DEE].map((userId) => makePlayer({ userId })),
    });
    room.settings = { ...room.settings, gameMode: GAME_MODE.team };
    room.turnOrder = [ANA, BO, CID, DEE];
    return room;
  }

  it('splits the room evenly by turn order', () => {
    const room = teamRoom();
    gameModeService.assignTeams(room);

    expect(room.players.get(ANA)?.team).toBe(TEAM.red);
    expect(room.players.get(BO)?.team).toBe(TEAM.blue);
    expect(room.players.get(CID)?.team).toBe(TEAM.red);
    expect(room.players.get(DEE)?.team).toBe(TEAM.blue);
  });

  it('totals each side', () => {
    const room = teamRoom();
    gameModeService.assignTeams(room);

    room.players.get(ANA)!.score = 100;
    room.players.get(CID)!.score = 50;
    room.players.get(BO)!.score = 30;

    const totals = gameModeService.teamScores(room);

    expect(totals.get(TEAM.red)).toBe(150);
    expect(totals.get(TEAM.blue)).toBe(30);
  });

  /** Outside a team mode nobody has a side, and there are no team totals. */
  it('leaves everybody teamless outside a team mode', () => {
    const room = teamRoom();
    room.settings = { ...room.settings, gameMode: GAME_MODE.classic };
    room.players.get(ANA)!.team = TEAM.red;

    gameModeService.assignTeams(room);

    expect(room.players.get(ANA)?.team).toBe(TEAM.none);
    expect(gameModeService.teamScores(room).size).toBe(0);
  });
});

describe('mode effects on play', () => {
  function roomIn(gameMode: string) {
    const room = makeRoom({ players: [makePlayer({ userId: ANA })] });
    room.settings = { ...room.settings, gameMode };
    return room;
  }

  it('keeps the board only in Relay', () => {
    expect(gameModeService.keepsBoard(roomIn(GAME_MODE.relay))).toBe(true);
    expect(gameModeService.keepsBoard(roomIn(GAME_MODE.classic))).toBe(false);
  });

  it('blinds the drawer only in Blind', () => {
    expect(gameModeService.drawerSeesBoard(roomIn(GAME_MODE.blind))).toBe(false);
    expect(gameModeService.drawerSeesBoard(roomIn(GAME_MODE.classic))).toBe(true);
  });

  /**
   * The lock is the first colour the drawer actually used, not one the server
   * picked — and it is read from the board, so it survives a reconnect.
   */
  it('locks to the first colour drawn in One Colour', () => {
    const room = roomIn(GAME_MODE.oneColor);
    expect(gameModeService.lockedColor(room)).toBeNull();

    room.board.strokes.push({
      id: 's-1',
      a: ANA,
      p: [[0.1, 0.1]],
      c: 0xffd64545,
      w: 4,
      t: 'pen',
      ts: 1,
    });

    expect(gameModeService.lockedColor(room)).toBe(0xffd64545);
  });

  it('ignores an eraser when deciding the locked colour', () => {
    const room = roomIn(GAME_MODE.oneColor);

    room.board.strokes.push(
      { id: 'e', a: ANA, p: [[0, 0]], c: 0xffffffff, w: 20, t: 'eraser', ts: 1 },
      { id: 's', a: ANA, p: [[0, 0]], c: 0xff3b7dd8, w: 4, t: 'pen', ts: 2 },
    );

    expect(gameModeService.lockedColor(room)).toBe(0xff3b7dd8);
  });

  it('never locks a colour outside One Colour', () => {
    const room = roomIn(GAME_MODE.classic);
    room.board.strokes.push({
      id: 's',
      a: ANA,
      p: [[0, 0]],
      c: 0xffd64545,
      w: 4,
      t: 'pen',
      ts: 1,
    });

    expect(gameModeService.lockedColor(room)).toBeNull();
  });

  /** A mode that makes guessing harder pays more, so none is the one to farm. */
  it('scales points by the mode multiplier', () => {
    const base = scoringService.guesserPoints({
      msRemaining: 40_000,
      msTotal: 80_000,
      guessOrder: 2,
      difficulty: 'medium',
    });

    const blind = scoringService.guesserPoints({
      msRemaining: 40_000,
      msTotal: 80_000,
      guessOrder: 2,
      difficulty: 'medium',
      modeMultiplier: modeRules(GAME_MODE.blind).scoreMultiplier,
    });

    expect(blind).toBeGreaterThan(base);
  });

  it('keeps Team and Duo off the global leaderboard', () => {
    expect(gameModeService.isRanked(roomIn(GAME_MODE.team))).toBe(false);
    expect(gameModeService.isRanked(roomIn(GAME_MODE.duo))).toBe(false);
    expect(gameModeService.isRanked(roomIn(GAME_MODE.classic))).toBe(true);
    expect(gameModeService.isRanked(roomIn(GAME_MODE.blind))).toBe(true);
  });
});

describe('spectators', () => {
  function roomWith(options: { allowSpectators?: boolean } = {}) {
    const room = makeRoom({ players: [makePlayer({ userId: ANA })] });
    room.settings = {
      ...room.settings,
      allowSpectators: options.allowSpectators ?? true,
      maxPlayers: 2,
    };
    return room;
  }

  /**
   * A fake socket, which is all `join` touches.
   *
   * Typed as its own shape rather than cast to `never` at the point of
   * creation: the cast belongs at the call boundary, so these objects stay
   * spreadable for the two-device tests below.
   */
  interface FakeSocket {
    id: string;
    data: {
      user: { id: string; username: string; avatarId: number; avatarColorIndex: number };
      roomId: string | null;
    };
    join: () => void;
  }

  function socketFor(userId: string, id = `sock-${userId}`): FakeSocket {
    return {
      id,
      data: {
        user: { id: userId, username: 'Watcher', avatarId: 1, avatarColorIndex: 2 },
        roomId: null,
      },
      join: vi.fn(),
    };
  }

  /**
   * The invariant the whole design rests on. A spectator is *absent* from
   * `players`, which is what makes "cannot draw, cannot guess, cannot score,
   * cannot be the drawer" true without a check anywhere in the engine.
   */
  it('never puts a spectator in the player list', () => {
    const room = roomWith();
    spectatorService.join(room, socketFor(BO) as never);

    expect(room.players.has(BO)).toBe(false);
    expect(room.spectators.has(BO)).toBe(true);
    expect(room.turnOrder).not.toContain(BO);
  });

  it('refuses when the host has spectating switched off', () => {
    const room = roomWith({ allowSpectators: false });
    expect(() => spectatorService.join(room, socketFor(BO) as never)).toThrow();
  });

  it('refuses somebody who already holds a seat', () => {
    const room = roomWith();
    expect(() => spectatorService.join(room, socketFor(ANA) as never)).toThrow();
  });

  /** A second device is the same person, not a second watcher. */
  it('counts one watcher once across two devices', () => {
    const room = roomWith();

    spectatorService.join(room, socketFor(BO) as never);
    const second = socketFor(BO, 'sock-2') as never;
    spectatorService.join(room, second);

    expect(room.spectators.size).toBe(1);
    expect(room.spectators.get(BO)?.socketIds.size).toBe(2);
  });

  it('keeps the watcher until their last socket goes', () => {
    const room = roomWith();
    spectatorService.join(room, socketFor(BO) as never);
    spectatorService.join(room, socketFor(BO, 'sock-2') as never);

    expect(spectatorService.leave(room, BO, 'sock-2')).toBe(false);
    expect(room.spectators.has(BO)).toBe(true);

    expect(spectatorService.leave(room, BO, `sock-${BO}`)).toBe(true);
    expect(room.spectators.has(BO)).toBe(false);
  });

  it('reports a room as full at the mode seat limit', () => {
    const room = roomWith();
    expect(spectatorService.isFull(room)).toBe(false);

    room.players.set(BO, makePlayer({ userId: BO }));
    expect(spectatorService.isFull(room)).toBe(true);
  });

  /**
   * Switching spectating off means "nobody watches", not "no *new* watchers" —
   * so the gallery is emptied rather than grandfathered.
   */
  it('empties the gallery when spectating is switched off', () => {
    const room = roomWith();
    spectatorService.join(room, socketFor(BO) as never);

    spectatorService.clear(room, 'spectating_disabled');

    expect(room.spectators.size).toBe(0);
  });
});
