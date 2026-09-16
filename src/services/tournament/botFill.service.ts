import {
  PLAYER_TYPE,
  REGISTRATION_STATUS,
  type BotDifficultyWire,
} from '@/constants/autoTournament.constants';
import {
  AutoTournament,
  TournamentRegistration,
  type AutoTournamentDocument,
} from '@/models/AutoTournament';
import { botProfileService } from '@/services/bot/botProfile.service';
import { announceTournament } from '@/services/tournament/notify';
import { logger } from '@/utils/logger';

/**
 * Deciding how many AI players a tournament needs, and adding them.
 *
 * ## The rule, stated once
 *
 * Bots exist to make a tournament that real people joined *playable*. They do
 * not exist to fill a tournament nobody joined, and they do not exist to take
 * seats a person could have had. That single sentence produces every branch
 * below:
 *
 * - **Nobody joined** → cancel. There is no number of bots that makes an
 *   empty tournament worth running, and a bot-only bracket would be the server
 *   playing against itself and announcing a winner to nobody.
 * - **Enough people joined** → add none. Four humans is a four-player
 *   tournament; adding a bot to make it five would push it to an eight-player
 *   bracket with three byes, which is worse in every way.
 * - **Some people joined, but too few** → add exactly the shortfall, capped by
 *   `maxBots`, capped again by `maxPlayers`.
 *
 * Note what is *not* here: there is no path that fills a sixteen-player
 * tournament with sixteen bots because it was configured to hold sixteen. The
 * target is always the *minimum*, never the maximum — the maximum is a ceiling
 * on how many people may join, not a quota to meet.
 *
 * ## Why this runs at check-in rather than at registration close
 *
 * Because the number that matters is how many humans are actually *present*,
 * not how many pressed a button ten minutes ago. Filling at registration close
 * would size the bracket to people who then never checked in, and the bye
 * count would absorb the difference — a four-player bracket where two of the
 * four are asleep. Counting after check-in means the bots make up a real
 * shortfall.
 */

/** What a fill decided, and why. */
export interface FillOutcome {
  humans: number;
  botsBefore: number;
  botsAdded: number;
  /** Total players the bracket will be drawn from. */
  total: number;
  /** Set when the tournament cannot run at all. */
  cancelReason: string | null;
}

export class TournamentBotFillService {
  /**
   * Works out the shortfall, without touching anything.
   *
   * Pure, and exported separately from the write below, because this is the
   * part worth pinning in tests: every example in the brief — four humans and
   * no bots, one human and three bots, zero humans and a cancellation — is a
   * call to this function and an assertion on what it returns.
   */
  plan(input: {
    humans: number;
    botsAlready: number;
    minPlayers: number;
    maxPlayers: number;
    minHumanPlayers: number;
    maxBots: number;
    allowBots: boolean;
  }): FillOutcome {
    const { humans, botsAlready, minPlayers, maxPlayers, minHumanPlayers, maxBots, allowBots } =
      input;

    const base: FillOutcome = {
      humans,
      botsBefore: botsAlready,
      botsAdded: 0,
      total: humans + botsAlready,
      cancelReason: null,
    };

    // The rule that makes a bot-only tournament impossible. Checked before
    // anything else, so no arithmetic below can route around it.
    if (humans < minHumanPlayers) {
      return {
        ...base,
        cancelReason:
          humans === 0
            ? 'Nobody checked in for this tournament.'
            : `A tournament needs at least ${minHumanPlayers} real player${
                minHumanPlayers === 1 ? '' : 's'
              }.`,
      };
    }

    const current = humans + botsAlready;

    // Enough people turned up. Humans first, always — a bot never takes a seat
    // that was not otherwise going to be empty.
    if (current >= minPlayers) return base;

    if (!allowBots) {
      return {
        ...base,
        cancelReason: `Only ${current} player${current === 1 ? '' : 's'} checked in.`,
      };
    }

    const shortfall = minPlayers - current;
    const botBudget = Math.max(0, maxBots - botsAlready);
    const seatBudget = Math.max(0, maxPlayers - current);

    const botsAdded = Math.min(shortfall, botBudget, seatBudget);
    const total = current + botsAdded;

    // The bots ran out before the shortfall did. A three-player tournament
    // cannot be played as a knockout — the bracket would be one match and one
    // very long bye — so it is cancelled rather than run badly.
    if (total < minPlayers) {
      return {
        ...base,
        botsAdded: 0,
        cancelReason: `Only ${total} player${total === 1 ? '' : 's'} available; ${minPlayers} are needed.`,
      };
    }

    return { ...base, botsAdded, total };
  }

  /**
   * Counts the roster, plans the fill, and writes the bot registrations.
   *
   * ## Why the counts are read rather than taken from the denormalised fields
   *
   * Because this decision is a limit, and enforcing a limit against a cached
   * number is how a limit gets exceeded. The counters on the tournament row
   * exist so the listing screen does not fan out into a count per slot; they
   * are not what any rule is checked against.
   */
  async fill(tournament: AutoTournamentDocument): Promise<FillOutcome> {
    const tournamentId = String(tournament._id);

    const [humans, botsAlready] = await Promise.all([
      TournamentRegistration.countDocuments({
        tournamentId,
        playerType: PLAYER_TYPE.human,
        // Checked in, specifically. Somebody who registered and vanished is
        // not a player this tournament has.
        status: REGISTRATION_STATUS.checkedIn,
      }).exec(),
      TournamentRegistration.countDocuments({
        tournamentId,
        playerType: PLAYER_TYPE.aiBot,
      }).exec(),
    ]);

    const outcome = this.plan({
      humans,
      botsAlready,
      minPlayers: tournament.minPlayers,
      maxPlayers: tournament.maxPlayers,
      minHumanPlayers: tournament.minHumanPlayers,
      maxBots: tournament.maxBots,
      allowBots: tournament.allowBots,
    });

    logger.info('tournament bot fill planned', { tournamentId, ...outcome });

    if (outcome.cancelReason || outcome.botsAdded === 0) return outcome;

    const added = await this.addBots({
      tournamentId,
      count: outcome.botsAdded,
      difficulty: tournament.botDifficulty as BotDifficultyWire,
    });

    // What was actually written, not what was planned. A concurrent fill — two
    // schedulers reaching check-in close at the same instant — has its bot
    // inserts rejected by the unique index, and the caller must size the
    // bracket to the rows that exist rather than to the ones it hoped for.
    return { ...outcome, botsAdded: added, total: humans + botsAlready + added };
  }

  /**
   * Creates the bot registration rows.
   *
   * Each insert is its own call rather than one `insertMany`, so a duplicate —
   * the same bot already added by a racing scheduler — costs that one row
   * instead of the batch. The unique index on `{tournamentId, botId}` is what
   * makes the duplicate a refusal rather than a second Doodler in the draw.
   */
  private async addBots(input: {
    tournamentId: string;
    count: number;
    difficulty: BotDifficultyWire;
  }): Promise<number> {
    const identities = await botProfileService.take({
      count: input.count,
      difficulty: input.difficulty,
      rotationKey: input.tournamentId,
    });

    let added = 0;

    for (const bot of identities) {
      try {
        await TournamentRegistration.create({
          tournamentId: input.tournamentId,
          userId: null,
          botId: bot.botId,
          displayName: bot.displayName,
          avatarId: bot.avatarId,
          avatarColorIndex: bot.avatarColorIndex,
          playerType: PLAYER_TYPE.aiBot,
          isBot: true,
          botDifficulty: bot.difficulty,
          // A bot is present by definition, so it skips the registered state
          // entirely. Nothing is waiting for it to confirm.
          status: REGISTRATION_STATUS.checkedIn,
          checkedInAt: new Date(),
        });

        added += 1;

        announceTournament('botAdded', {
          tournamentId: input.tournamentId,
          botId: bot.botId,
          displayName: bot.displayName,
          difficulty: bot.difficulty,
          isBot: true,
        });
      } catch (error) {
        if ((error as { code?: number }).code === 11000) {
          logger.info('bot already registered for this tournament', {
            tournamentId: input.tournamentId,
            botId: bot.botId,
          });
          continue;
        }
        throw error;
      }
    }

    if (added > 0) {
      await this.refreshCounts(input.tournamentId);
    }

    return added;
  }

  /**
   * Rewrites the denormalised counts from the real rows.
   *
   * Called after anything that changes a roster. Recomputed rather than
   * incremented: an increment that was lost or applied twice drifts for ever,
   * while a recount converges the next time anything happens.
   */
  async refreshCounts(tournamentId: string): Promise<{ humans: number; bots: number }> {
    const [humans, bots] = await Promise.all([
      TournamentRegistration.countDocuments({
        tournamentId,
        playerType: PLAYER_TYPE.human,
        status: {
          $nin: [REGISTRATION_STATUS.withdrawn, REGISTRATION_STATUS.noShow],
        },
      }).exec(),
      TournamentRegistration.countDocuments({
        tournamentId,
        playerType: PLAYER_TYPE.aiBot,
      }).exec(),
    ]);

    await AutoTournament.updateOne(
      { _id: tournamentId },
      {
        $set: {
          humanPlayerCount: humans,
          botPlayerCount: bots,
          registeredCount: humans + bots,
        },
      },
    ).exec();

    return { humans, bots };
  }
}

export const tournamentBotFillService = new TournamentBotFillService();
