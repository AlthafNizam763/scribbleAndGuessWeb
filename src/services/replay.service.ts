import { roundRepository } from '@/repositories/round.repository';
import type { StrokeDto } from '@/types/drawing.types';
import type { ReplayDto, ReplayListDto, ReplaySummaryDto } from '@/types/replay.types';
import { wasCompacted } from '@/utils/compactSnapshot';
import { errors } from '@/utils/errors';

/**
 * Drawing replays (brief section: Drawing Replay).
 *
 * ## Where the replay data comes from
 *
 * It was already being stored. `roundRepository.finish` writes the finished
 * board to `rounds.snapshot` in one write at turn end — live strokes never
 * touch Mongo — so this feature adds no cost to the drawing path at all. What
 * it adds is a budget on that write, and a way to read it back.
 *
 * ## The one rule
 *
 * A replay carries the drawing *and* the word. Both are built only for a turn
 * whose `endedAt` is set, and every path below checks it. That is the same
 * rule `roundService.history` follows, and it is why the replay types are
 * separate from the live round types — so a future caller cannot reach for the
 * wrong one and publish a live answer.
 */

/**
 * The slice of a round document this service actually reads.
 *
 * Declared structurally rather than as `RoundDocument` because these rows
 * arrive from `.lean()`, whose type is a `FlattenMaps<...>` of Mongoose
 * subdocument machinery that does not cast cleanly — and casting through
 * `unknown` to get around that would throw away the checking this is for. The
 * same narrowing `syncIndexes.ts` does, and for the same reason: name the
 * handful of fields used, and the compiler still verifies them.
 */
interface ReplayableRound {
  turnNumber: number;
  roundNumber: number;
  drawerId: unknown;
  drawerName: string;
  word?: string | null;
  turnStartMs: number;
  turnEndMs: number;
  correctGuesses?: readonly unknown[];
  snapshot?: readonly unknown[];
  endedAt?: Date | null;
}

/** Whether a round is finished, and therefore safe to expose. */
function isPlayable(round: { endedAt?: Date | null }): boolean {
  return round.endedAt != null;
}

function toSummary(round: ReplayableRound): ReplaySummaryDto {
  const snapshot = (round.snapshot ?? []) as StrokeDto[];

  return {
    turnNumber: round.turnNumber,
    roundNumber: round.roundNumber,
    drawerId: String(round.drawerId),
    drawerName: round.drawerName,
    word: round.word ?? '',
    durationMs: Math.max(0, round.turnEndMs - round.turnStartMs),
    correctGuessers: round.correctGuesses?.length ?? 0,
    strokeCount: snapshot.length,
    // Recomputed rather than stored: the budget is a constant, so asking
    // whether this drawing is at it is cheaper than a schema field that would
    // go stale the day the constant changed.
    compacted: wasCompacted(snapshot),
    endedAtMs: (round.endedAt ?? new Date()).getTime(),
  };
}

export class ReplayService {
  /**
   * Every finished turn of a match, without the strokes.
   *
   * Metadata only, because the list is a menu: a twelve-turn match's drawings
   * together are megabytes, and a player opening the replay screen wants to
   * choose one, not download all of them.
   */
  async list(gameId: string): Promise<ReplayListDto> {
    const rounds = await roundRepository.findByGame(gameId);

    return {
      gameId,
      items: rounds
        .filter(isPlayable)
        .map((round) => toSummary(round as unknown as ReplayableRound)),
    };
  }

  /**
   * One finished turn, with its strokes.
   *
   * Refuses a turn that has not ended — that is the check protecting the word,
   * and it is made here rather than in the controller so both the REST route
   * and any future caller go through it.
   */
  async get(gameId: string, turnNumber: number): Promise<ReplayDto> {
    const round = await roundRepository.findByGameTurn(gameId, turnNumber);

    if (!round) throw errors.notFound('That round does not exist.');
    if (!isPlayable(round)) {
      // Deliberately the same message a missing round gets. "That round is
      // still running" would confirm which turn is live to a caller probing
      // for it, and the word is exactly what they would be probing for.
      throw errors.notFound('That round does not exist.');
    }

    const document = round as unknown as ReplayableRound;

    return {
      ...toSummary(document),
      strokes: (document.snapshot ?? []) as StrokeDto[],
    };
  }
}

export const replayService = new ReplayService();
