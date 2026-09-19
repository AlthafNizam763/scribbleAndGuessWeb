import { BaseAdapter, record, strings, type State } from '@/games/adapter.base';
import type { PlatformPlayerState } from '@/games/game.types';
import { spaceMysteryEngine } from '@/games/spaceMystery/engine';
import { mapDescription } from '@/games/spaceMystery/map';
import { errors } from '@/utils/errors';

/**
 * The durable half of Space Mystery.
 *
 * ## What this file is, and is not
 *
 * It is **not** the game. The game is `spaceMystery/engine.ts`, which runs a
 * twenty-hertz simulation in memory. This is the record of it: the thing that
 * exists in Mongo, that the generic room/match machinery can start, stop and
 * score without knowing that one of the five games in the catalogue happens to
 * be real-time.
 *
 * The split is what keeps the platform honest. `game_platform.service` does
 * not branch on game id to start a ship; it calls [onMatchStarted], which four
 * adapters do not implement and this one does. A sixth game that is also
 * real-time gets the same hook rather than a second special case.
 *
 * ## Why the actions do not come through here
 *
 * `handlePlayerAction` on this adapter throws, deliberately. Every other game
 * routes an action through `gamePlatformService.action`, which loads a match
 * document, folds the action in, and saves. At ten movement messages a second
 * per player that is a database write per player per hundred milliseconds, to
 * store a position that is meaningless four frames later.
 *
 * So the socket layer routes this game's actions straight into the engine, and
 * this method exists to make the wrong path fail loudly rather than quietly
 * persisting something. If you are reading this because it threw, the caller
 * should be talking to `spaceMysteryEngine.input`.
 */
export class SpaceMysteryGameAdapter extends BaseAdapter {
  readonly gameId = 'SPACE_MYSTERY' as const;

  /** Tells the platform this match is driven by a tick, not by turns. */
  override readonly realtime = true;

  override createMatch(players: PlatformPlayerState[]): State {
    const state = super.createMatch(players);

    // Deliberately thin. Roles, positions, who is alive and who saw what all
    // live in the engine and never touch this document — which is the
    // strongest possible guarantee that a stray `.lean()` somewhere cannot
    // leak who the traitor is, because the answer was never written down.
    return {
      ...state,
      status: 'waiting',
      engine: 'space-mystery-realtime-v1',
      usernames: Object.fromEntries(players.map((player) => [player.playerId, player.username])),
    };
  }

  override startMatch(state: State): State {
    state.status = 'playing';
    return state;
  }

  /**
   * Hands the seats to the simulation once the platform has a match id.
   *
   * Called by `game_platform.service` immediately after the match document is
   * created, because the engine keys everything on the match id and there is
   * no id until the document exists.
   */
  onMatchStarted(input: { matchId: string; roomId: string; players: PlatformPlayerState[] }): void {
    spaceMysteryEngine.begin(input);
  }

  /** Drops the ship when the room closes, whether or not the match finished. */
  onMatchEnded(matchId: string): void {
    spaceMysteryEngine.end(matchId);
  }

  validateAction(): void {
    throw errors.invalidAction('Space Mystery actions go to the realtime engine.');
  }

  handlePlayerAction(): State {
    throw errors.invalidAction('Space Mystery actions go to the realtime engine.');
  }

  /**
   * What the durable record can say about a live match: almost nothing.
   *
   * A client gets the real thing over the realtime channel. This is what an
   * API caller sees — a room listing, a match summary — and it is a pointer
   * rather than a snapshot, because a snapshot of a real-time match taken over
   * REST is out of date before it is serialised.
   */
  getPublicState(state: State): State {
    return {
      gameId: this.gameId,
      status: state.status,
      engine: state.engine ?? 'space-mystery-realtime-v1',
      realtime: true,
      /** The floor plan, so a joining client can draw the ship immediately. */
      map: mapDescription(),
      players: strings(state.players).map((playerId) => ({
        playerId,
        username: record(state.usernames)[playerId] ?? playerId,
      })),
      /** Populated only once the engine has reported the match finished. */
      result: state.result ?? null,
    };
  }

  getPrivatePlayerState(state: State, _playerId: string): State {
    // Identical to the public projection on purpose. Everything private about
    // this game — your role, your tasks, who you can see — comes from the
    // engine's own per-viewer projection, which is the one place it is
    // computed and the one place it can be got wrong.
    return this.getPublicState(state);
  }

  /**
   * No turn-based suggestion, because there are no turns.
   *
   * The Stupids on this ship are not missing: they are walking around it. They
   * are driven from inside the tick in `spaceMystery/bots.ts`, on the same
   * per-viewer projection a person gets, because a driver that waits for a
   * turn would wait forever in a game that does not have any.
   */
  override suggestBotAction(): State | null {
    return null;
  }
}
