import {
  BOT_DIFFICULTY,
  REGISTRATION_STATUS,
  type BotDifficultyWire,
} from '@/constants/autoTournament.constants';
import { AutoTournament, TournamentRegistration } from '@/models/AutoTournament';
import { TournamentMatch } from '@/models/TournamentMatch';
import { botProfileService } from '@/services/bot/botProfile.service';
import { announceToPlayer, announceTournament } from '@/services/tournament/notify';
import type { RuntimeRoom } from '@/types/socket.types';
import { logger } from '@/utils/logger';

/**
 * Taking over the seat of a player who left a bracket match.
 *
 * ## The problem this solves
 *
 * A knockout match has two people in it. When one of them drops — a phone
 * locking, a train entering a tunnel — the other is left drawing for an
 * audience of nobody, and behind them a bracket, a tournament and a slot all
 * stop until something resolves it. The old answer was to wait forty-five
 * seconds and then award a walkover, which resolves the bracket but gives the
 * player who stayed nothing to play.
 *
 * So after a much shorter grace — fifteen seconds, see
 * `TIMING.tournamentReconnectGraceMs` — a bot takes the empty seat and the
 * match plays out. The remaining player gets their game.
 *
 * ## What the bot is, and what it is not
 *
 * It is a *stand-in*. It draws, it guesses, it scores, and its score is
 * recorded honestly on the match — but it is not in the bracket and it cannot
 * advance through one. The seat it took is marked `forfeitedRegistrationId` on
 * the match, and the result reporter hands the round to the player who stayed
 * regardless of the final scores.
 *
 * That asymmetry is deliberate and it is the whole design. A bot that could
 * advance would mean a human knocked out of a tournament by a robot standing
 * in for somebody else — strictly worse than the walkover this replaced. A bot
 * that plays to lose would be obvious and insulting. A bot that plays properly
 * and cannot win the bracket is the only combination that is fair to the
 * person still holding their phone.
 *
 * ## Why the disconnected player is eliminated rather than left pending
 *
 * Because they are out either way — a walkover would have eliminated them too
 * — and leaving the row `active` would make them look, to every other query in
 * the system, like somebody still in a tournament. That is the state that
 * stops them joining the next one.
 */

export class TournamentStandInService {
  /**
   * Puts a bot in a departed player's seat.
   *
   * Returns whether a stand-in was actually seated. False covers every
   * ordinary reason not to — not a tournament room, the match already over,
   * the tournament configured against bots, no bot free — and none of them is
   * an error: the caller's fallback is the behaviour that existed before this
   * did.
   *
   * ## Why `seatBot` is passed in
   *
   * `roomService` imports the presence service, which is what calls this, so
   * importing `roomService` here would close a cycle. The one function this
   * needs is handed over by the caller instead — the same technique the bot
   * player service uses for the game engine, and for the same reason.
   */
  async replace(input: {
    room: RuntimeRoom;
    userId: string;
    username: string;
    seatBot: (room: RuntimeRoom, bot: SeatBotInput) => void;
  }): Promise<boolean> {
    const { room, userId, username, seatBot } = input;

    const binding = room.tournament;
    if (!binding) return false;
    if (room.closed) return false;

    const registrationId = binding.registrationIdByPlayerId[userId];
    if (!registrationId) return false;

    const match = await TournamentMatch.findById(binding.matchId).lean().exec();
    // A decided match needs no stand-in: the bracket has already moved on and
    // seating a bot would put a player in a room nothing is reading.
    if (!match || match.completedAt) return false;

    // Somebody already took over this seat — two disconnect timers for the
    // same player, or a restart mid-takeover. One stand-in per seat.
    if (match.forfeitedRegistrationId) return false;

    const tournament = await AutoTournament.findById(binding.tournamentId).lean().exec();
    if (!tournament) return false;

    // A deployment that has turned bots off gets the old behaviour. "Where
    // allowed" is a real configuration, not a figure of speech.
    if (!tournament.allowBots) return false;

    const [identity] = await botProfileService.take({
      count: 1,
      difficulty: (tournament.botDifficulty ?? BOT_DIFFICULTY.normal) as BotDifficultyWire,
      // Keyed on the match rather than the tournament, so the stand-in is not
      // the same character as a bot already seeded into this bracket.
      rotationKey: `${binding.matchId}:standin`,
    });

    if (!identity) return false;

    // Claimed before the seat is taken. The write is conditional on the field
    // still being empty, so of two callers racing here exactly one proceeds
    // and the other returns false above on its next read.
    const claimed = await TournamentMatch.updateOne(
      { _id: binding.matchId, forfeitedRegistrationId: null, completedAt: null },
      { $set: { forfeitedRegistrationId: registrationId } },
    ).exec();

    if ((claimed.modifiedCount ?? 0) === 0) return false;

    // The stand-in sits in the *same* seat id as the player it replaced, so
    // every map that already points at that id — the room's turn order, the
    // match's `registrationIdByPlayerId`, the bracket's slot — keeps pointing
    // at a seat that exists. A new id would mean rewriting all of them, and
    // the one that was missed would be a match that could not report a result.
    seatBot(room, {
      playerId: userId,
      botId: identity.botId,
      displayName: identity.displayName,
      avatarId: identity.avatarId,
      avatarColorIndex: identity.avatarColorIndex,
      difficulty: identity.difficulty,
    });

    await TournamentRegistration.updateOne(
      { _id: registrationId, status: { $in: [REGISTRATION_STATUS.active, REGISTRATION_STATUS.checkedIn] } },
      {
        $set: {
          status: REGISTRATION_STATUS.eliminated,
          eliminatedReason: 'disconnected',
        },
      },
    ).exec();

    const opponentId = this.opponentOf(binding, userId);
    if (opponentId) {
      announceToPlayer(opponentId, 'playerReplacedByBot', {
        tournamentId: binding.tournamentId,
        matchId: binding.matchId,
        replacedDisplayName: username,
        botDisplayName: identity.displayName,
        isBot: true,
      });
    }

    announceTournament('botStatusUpdated', {
      tournamentId: binding.tournamentId,
      matchId: binding.matchId,
      botId: identity.botId,
      displayName: identity.displayName,
      isBot: true,
      standingInFor: username,
    });

    logger.info('a disconnected tournament player was replaced by a bot', {
      roomId: room.roomId,
      matchId: binding.matchId,
      userId,
      botId: identity.botId,
    });

    return true;
  }

  /**
   * Whether this seat's result is already decided by a forfeit.
   *
   * Read by the result reporter. Returns the registration that stayed, or null
   * when nobody forfeited and the scoreboard decides as usual.
   */
  async winnerByForfeit(matchId: string): Promise<{
    winnerRegistrationId: string;
    loserRegistrationId: string;
  } | null> {
    const match = await TournamentMatch.findById(matchId).lean().exec();
    if (!match?.forfeitedRegistrationId) return null;

    const forfeited = String(match.forfeitedRegistrationId);
    const slotA = match.slotA ? String(match.slotA) : null;
    const slotB = match.slotB ? String(match.slotB) : null;

    const stayed = forfeited === slotA ? slotB : forfeited === slotB ? slotA : null;
    if (!stayed) return null;

    return { winnerRegistrationId: stayed, loserRegistrationId: forfeited };
  }

  /** The other seat in a two-player match, as a user id. */
  private opponentOf(
    binding: NonNullable<RuntimeRoom['tournament']>,
    userId: string,
  ): string | null {
    for (const playerId of Object.keys(binding.registrationIdByPlayerId)) {
      if (playerId !== userId) return playerId;
    }
    return null;
  }
}

/** What `roomService.seatBot` needs, named here so the caller can be typed. */
export interface SeatBotInput {
  playerId: string;
  botId: string;
  displayName: string;
  avatarId: number;
  avatarColorIndex: number;
  difficulty: BotDifficultyWire;
}

export const tournamentStandInService = new TournamentStandInService();

