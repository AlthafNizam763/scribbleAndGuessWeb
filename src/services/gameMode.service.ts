import { ROOM_LIMITS } from '@/constants/game.constants';
import {
  TEAM,
  TEAM_SIDES,
  modeRules,
  type GameModeDefinition,
  type TeamWire,
} from '@/constants/gameModes.constants';
import type { RoomSettingsDto } from '@/types/room.types';
import type { RuntimePlayer, RuntimeRoom } from '@/types/socket.types';
import { errors } from '@/utils/errors';

/**
 * What a game mode actually does to a match.
 *
 * ## The engine never asks which mode it is in
 *
 * It asks this service what the rules are. Every mode-specific decision in the
 * game — how long a turn runs, how many hints there are, whether the board is
 * wiped, whether the drawer can see it — is answered here from the table in
 * `gameModes.constants.ts`, so adding a tenth mode is a table entry rather
 * than a tenth branch through `game.service.ts`.
 *
 * ## Settings are resolved once, when the match starts
 *
 * A mode's overrides are folded into the room's settings at `startGame` and
 * the result is what the turn loop reads. Resolving per turn would mean a
 * host editing the room mid-match could change the rules under a live turn;
 * resolving once means the match plays by the rules it began with, which is
 * also what "settings lock when the game starts" means in practice.
 */

export class GameModeService {
  /** The rules for a room's configured mode. Never throws. */
  rulesFor(room: RuntimeRoom): GameModeDefinition {
    return modeRules(room.settings.gameMode);
  }

  /**
   * The settings a match should actually run with.
   *
   * The mode's overrides win over the room's own choices, because the mode is
   * what everybody agreed to play: a Speed room whose host left the draw time
   * at 80 is still Speed. `maxPlayers` is narrowed but never widened — a mode
   * may make a room smaller (Duo) and may not let it exceed the room ceiling.
   */
  resolveSettings(settings: RoomSettingsDto): RoomSettingsDto {
    const rules = modeRules(settings.gameMode);

    return {
      ...settings,
      ...(rules.overrides.drawTimeSeconds !== undefined
        ? { drawTimeSeconds: rules.overrides.drawTimeSeconds }
        : {}),
      ...(rules.overrides.hintCount !== undefined
        ? { hintCount: rules.overrides.hintCount }
        : {}),
      ...(rules.overrides.wordMode !== undefined
        ? { wordMode: rules.overrides.wordMode }
        : {}),
      ...(rules.overrides.wordDifficulty !== undefined
        ? { wordDifficulty: rules.overrides.wordDifficulty }
        : {}),
      maxPlayers: Math.min(
        settings.maxPlayers,
        rules.maxPlayers,
        ROOM_LIMITS.maxPlayers.max,
      ),
    };
  }

  /**
   * Refuses to start a match the mode cannot support.
   *
   * Checked at `startGame` rather than at join time, because a room fills and
   * empties before anybody presses start — refusing a fifth player from a Duo
   * room would be right, but refusing to *open* one because it briefly had
   * five would not.
   */
  assertCanStart(room: RuntimeRoom, activePlayers: number): void {
    const rules = this.rulesFor(room);

    if (activePlayers < rules.minPlayers) {
      throw errors.invalidAction(
        `${rules.name} needs at least ${rules.minPlayers} players.`,
      );
    }

    if (activePlayers > rules.maxPlayers) {
      throw errors.invalidAction(
        `${rules.name} takes at most ${rules.maxPlayers} players.`,
      );
    }
  }

  /**
   * Whether a seat is available under this mode.
   *
   * The mode's ceiling and the room's are both honoured, and the lower wins —
   * which is how a Duo room holds two people however its `maxPlayers` was set.
   */
  seatLimit(room: RuntimeRoom): number {
    const rules = this.rulesFor(room);
    return Math.min(room.settings.maxPlayers, rules.maxPlayers);
  }

  // --------------------------------------------------------------- teams --

  /**
   * Splits the room into two sides, as evenly as the count allows.
   *
   * Assigned by seat order rather than at random. A random split re-rolled at
   * every start would make "play again" shuffle the teams people had just
   * settled into, and the shuffle already happened: `turnOrder` is randomised,
   * so alternating down it is both stable and unbiased.
   *
   * A no-op outside a team mode, so the caller need not branch.
   */
  assignTeams(room: RuntimeRoom): void {
    const rules = this.rulesFor(room);

    if (!rules.teams) {
      for (const player of room.players.values()) player.team = TEAM.none;
      return;
    }

    let index = 0;
    for (const userId of room.turnOrder) {
      const player = room.players.get(userId);
      if (!player) continue;

      player.team = TEAM_SIDES[index % TEAM_SIDES.length] ?? TEAM.none;
      index += 1;
    }
  }

  /**
   * Points per side, for a team mode's standings.
   *
   * Returns an empty map outside a team mode, which is what lets the result
   * builder ask unconditionally.
   */
  teamScores(room: RuntimeRoom): Map<TeamWire, number> {
    const rules = this.rulesFor(room);
    if (!rules.teams) return new Map();

    const totals = new Map<TeamWire, number>();
    for (const side of TEAM_SIDES) totals.set(side, 0);

    for (const player of room.players.values()) {
      const side = player.team;
      if (side === TEAM.none) continue;
      totals.set(side, (totals.get(side) ?? 0) + player.score);
    }

    return totals;
  }

  /** Whether two players are on the same side. False outside a team mode. */
  sameTeam(room: RuntimeRoom, a: RuntimePlayer, b: RuntimePlayer): boolean {
    if (!this.rulesFor(room).teams) return false;
    return a.team !== TEAM.none && a.team === b.team;
  }

  // -------------------------------------------------------------- drawing --

  /** Whether the board survives into the next turn. Relay only. */
  keepsBoard(room: RuntimeRoom): boolean {
    return this.rulesFor(room).keepBoardBetweenTurns;
  }

  /**
   * Whether the drawer may see the board they are drawing on.
   *
   * Stated by the server rather than left to the client. A blind mode where
   * the canvas is merely hidden by the app is a mode anybody can switch off,
   * and the flag rides on the game state so every client is told the same
   * thing.
   */
  drawerSeesBoard(room: RuntimeRoom): boolean {
    return this.rulesFor(room).drawerSeesBoard;
  }

  /**
   * The colour a turn is locked to, or null when any colour is allowed.
   *
   * The lock is the *first* colour the drawer actually used, not one the
   * server picked: a mode that assigned a colour would be a different game,
   * and one that trusted the client to stick to its own choice would not be a
   * rule at all. Read from the board, so it survives a reconnect.
   */
  lockedColor(room: RuntimeRoom): number | null {
    if (!this.rulesFor(room).singleColor) return null;

    const first = room.board.strokes.find((stroke) => stroke.t !== 'eraser');
    return first?.c ?? null;
  }

  /** The multiplier every point in this mode is scaled by. */
  scoreMultiplier(room: RuntimeRoom): number {
    return this.rulesFor(room).scoreMultiplier;
  }

  /** Whether this mode's results count towards the global leaderboard. */
  isRanked(room: RuntimeRoom): boolean {
    return this.rulesFor(room).ranked;
  }
}

export const gameModeService = new GameModeService();
