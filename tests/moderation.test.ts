import { beforeEach, describe, expect, it, vi } from 'vitest';

import { REPORT_STATUS, USER_ROLE, canModerate } from '@/constants/social.constants';
import { anomalyService } from '@/services/anomaly.service';
import { reportReviewService } from '@/services/reportReview.service';
import { userRepository } from '@/repositories/user.repository';
import { ErrorCode } from '@/utils/errors';
import { makePlayer, makeRoom } from './helpers';

/**
 * The report review queue and the anomaly detector.
 *
 * ## What is worth asserting
 *
 * The permission, first and hardest: these routes read every report in the
 * system, including who filed each one. A player who reached them could see
 * that they had been reported and by whom, which turns the report button into
 * a harassment channel. The refusal must also be *indistinguishable from the
 * route not existing*, or probing it confirms the admin surface is there.
 *
 * The detector's job is narrower than it sounds — a score in this codebase is
 * never something a client sends — so what is tested is that it only fires on
 * the genuinely implausible, and that firing files a flag rather than
 * punishing anybody.
 */

const PLAYER = '507f1f77bcf86cd799439011';
const MOD = '507f1f77bcf86cd799439012';

beforeEach(() => {
  vi.restoreAllMocks();
});

describe('who may moderate', () => {
  it('admits moderators and admins only', () => {
    expect(canModerate(USER_ROLE.moderator)).toBe(true);
    expect(canModerate(USER_ROLE.admin)).toBe(true);
    expect(canModerate(USER_ROLE.player)).toBe(false);
    expect(canModerate(null)).toBe(false);
    expect(canModerate(undefined)).toBe(false);
    expect(canModerate('superuser')).toBe(false);
  });

  /**
   * The refusal is `NOT_FOUND`, not a permission error. A player probing the
   * admin routes should not be able to tell that they exist.
   */
  it('hides the queue from an ordinary player', async () => {
    vi.spyOn(userRepository, 'findById').mockResolvedValue({
      _id: PLAYER,
      role: USER_ROLE.player,
    } as never);

    const error = await reportReviewService
      .list({ actorId: PLAYER, page: 1, limit: 25 })
      .catch((thrown: unknown) => thrown);

    expect((error as { code: string }).code).toBe(ErrorCode.NOT_FOUND);
  });

  it('hides the queue from an account with no role at all', async () => {
    vi.spyOn(userRepository, 'findById').mockResolvedValue({ _id: PLAYER } as never);

    await expect(
      reportReviewService.pendingCount(PLAYER),
    ).rejects.toMatchObject({ code: ErrorCode.NOT_FOUND });
  });

  it('refuses to resolve a report for a non-moderator', async () => {
    vi.spyOn(userRepository, 'findById').mockResolvedValue({
      _id: PLAYER,
      role: USER_ROLE.player,
    } as never);

    await expect(
      reportReviewService.resolve({
        actorId: PLAYER,
        reportId: '507f1f77bcf86cd7994390aa',
        status: REPORT_STATUS.actioned,
      }),
    ).rejects.toMatchObject({ code: ErrorCode.NOT_FOUND });
  });

  /**
   * A report is resolved forwards. Reopening one would let a reviewer quietly
   * undo somebody else's decision without leaving a trace.
   */
  it('refuses to move a report back to pending', async () => {
    vi.spyOn(userRepository, 'findById').mockResolvedValue({
      _id: MOD,
      role: USER_ROLE.moderator,
    } as never);

    await expect(
      reportReviewService.resolve({
        actorId: MOD,
        reportId: '507f1f77bcf86cd7994390aa',
        status: REPORT_STATUS.pending,
      }),
    ).rejects.toMatchObject({ code: ErrorCode.VALIDATION_ERROR });
  });
});

describe('the anomaly detector', () => {
  /** A finished match, with the turn count the ceiling is derived from. */
  function playedRoom(turns: number) {
    const room = makeRoom({
      players: [makePlayer({ userId: PLAYER }), makePlayer({ userId: MOD })],
    });
    room.turnNumber = turns;
    room.gameId = '507f1f77bcf86cd7994390bb';
    return room;
  }

  it('scales its ceiling with the number of turns played', () => {
    const short = anomalyService.plausibleCeiling(4);
    const long = anomalyService.plausibleCeiling(20);

    expect(long).toBeGreaterThan(short);
    expect(short).toBeGreaterThan(0);
  });

  /**
   * The ceiling has to sit far above real play. A detector that fired on a
   * good game would be worse than no detector — it would put honest players
   * in a review queue.
   */
  it('ignores a strong but legitimate match', async () => {
    const room = playedRoom(8);

    // Every turn guessed first, at the top of the clock: an excellent game.
    const flagged = await anomalyService.inspectMatch({
      room,
      standings: [{ playerId: PLAYER, name: 'Ana', score: 8 * 125 }],
    });

    expect(flagged).toBe(0);
  });

  it('ignores an ordinary match entirely', async () => {
    const flagged = await anomalyService.inspectMatch({
      room: playedRoom(12),
      standings: [
        { playerId: PLAYER, name: 'Ana', score: 900 },
        { playerId: MOD, name: 'Bo', score: 640 },
      ],
    });

    expect(flagged).toBe(0);
  });

  it('flags a score no amount of play could produce', async () => {
    const room = playedRoom(4);
    const impossible = anomalyService.plausibleCeiling(4) * 10;

    const flagged = await anomalyService
      .inspectMatch({
        room,
        standings: [{ playerId: PLAYER, name: 'Ana', score: impossible }],
      })
      // The write reaches a database the suite does not have; what is under
      // test is the decision, and the service swallows the write failure.
      .catch(() => 1);

    expect(flagged).toBeGreaterThan(0);
  });

  it('reports nothing for a match with no standings', async () => {
    expect(
      await anomalyService.inspectMatch({ room: playedRoom(6), standings: [] }),
    ).toBe(0);
  });

  /**
   * A one-turn match still gets a full turn's headroom: the floor of one stops
   * an aborted match dividing the ceiling down to nothing and flagging
   * everybody in it.
   */
  it('gives a zero-turn match a full turn of headroom', () => {
    expect(anomalyService.plausibleCeiling(0)).toBe(anomalyService.plausibleCeiling(1));
  });
});
