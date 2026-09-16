import {
  BOT_DIFFICULTY,
  BOT_PROFILES,
  type BotDifficultyWire,
} from '@/constants/autoTournament.constants';
import {
  TournamentBotProfile,
  type TournamentBotProfileDocument,
} from '@/models/TournamentBotProfile';
import { logger } from '@/utils/logger';

/**
 * The AI roster: who the bots are, and what identity they play under.
 *
 * ## Why a bot needs a database row at all
 *
 * To be seatable. Every seat in the game engine is keyed by a string id that
 * the room document stores as an ObjectId, and the scoring, turn order and
 * bracket all key off it. A bot therefore needs a stable ObjectId, and a
 * stable one — a bot whose identity changed each boot would orphan the match
 * it was halfway through when the process restarted.
 *
 * ## Why the roster is a constant and the rows are upserted from it
 *
 * The list of bots is a product decision, not configuration, so it lives in
 * `BOT_PROFILES`. The rows exist to give each entry an id and an on/off
 * switch. `ensureSeeded` reconciles the two on boot: new entries are inserted,
 * existing ones keep their id, and an entry removed from the constant simply
 * stops being seated without breaking the brackets that name it.
 *
 * ## Why nothing here is reachable from a request
 *
 * `resolve` is called by the tournament fill service and by the match service.
 * No route and no socket handler imports this module. A client that sent
 * `botId: "scribbler"` in any payload would be sending a field nothing reads —
 * which is a stronger guarantee than validating it would be.
 */

/** A bot, ready to be seated. */
export interface BotIdentity {
  /** The stable profile key: `scribbler`, `doodler`, and so on. */
  botId: string;
  /** The ObjectId this bot plays under. Stable across restarts. */
  playerId: string;
  displayName: string;
  avatarId: number;
  avatarColorIndex: number;
  difficulty: BotDifficultyWire;
}

/**
 * The resolved roster, cached for the life of the process.
 *
 * Read on every roster fill and on every match seating, which is often enough
 * that a query per read would be noise in the logs and a round trip in the
 * middle of opening a match. The rows are effectively immutable — only
 * `active` ever changes, and that is an operator action — so the cache is
 * dropped by `refresh` rather than expiring on a timer nobody is watching.
 */
let cache: BotIdentity[] | null = null;

export class BotProfileService {
  /**
   * Creates any missing bot rows and loads the roster.
   *
   * Idempotent by construction: each write is an upsert keyed on `botId`, so
   * booting twenty instances at once produces one row per bot rather than
   * twenty, and re-running after a deploy changes nothing.
   *
   * Called at boot and again lazily by `all()`, so a deployment that skipped
   * the boot hook — a Next.js route handler in the split deployment, say —
   * still finds a roster rather than an empty list.
   */
  async ensureSeeded(): Promise<BotIdentity[]> {
    if (cache) return cache;

    await Promise.all(
      BOT_PROFILES.map((profile) =>
        TournamentBotProfile.updateOne(
          { botId: profile.botId },
          {
            // Only on insert: an operator who switched a bot off, or changed
            // its difficulty, should not have that undone by the next boot.
            $setOnInsert: {
              botId: profile.botId,
              displayName: profile.displayName,
              avatarId: profile.avatarId,
              avatarColorIndex: profile.avatarColorIndex,
              difficulty: BOT_DIFFICULTY.normal,
              active: true,
            },
          },
          { upsert: true },
        ).exec(),
      ),
    );

    const rows = (await TournamentBotProfile.find({ active: true })
      .sort({ botId: 1 })
      .lean()
      .exec()) as TournamentBotProfileDocument[];

    cache = rows.map((row) => ({
      botId: row.botId,
      playerId: String(row._id),
      displayName: row.displayName,
      avatarId: row.avatarId ?? 0,
      avatarColorIndex: row.avatarColorIndex ?? 0,
      difficulty: (row.difficulty ?? BOT_DIFFICULTY.normal) as BotDifficultyWire,
    }));

    logger.info('bot roster ready', { bots: cache.length });
    return cache;
  }

  /** Every bot that may be seated. */
  async all(): Promise<BotIdentity[]> {
    return this.ensureSeeded();
  }

  /**
   * Picks `count` bots for a tournament, at the given difficulty.
   *
   * Distinct by construction — it slices a list — so a roster can never hold
   * the same bot twice. `count` above the roster size yields the whole roster
   * rather than failing: a tournament short of players is better off with four
   * bots than with an error, and the caller's own `maxBots` already bounds the
   * ask.
   *
   * The order rotates on the tournament id rather than being random, so two
   * tournaments running at once do not both field Scribbler and Sketcher while
   * the other four never play.
   */
  async take(input: {
    count: number;
    difficulty: BotDifficultyWire;
    rotationKey: string;
  }): Promise<BotIdentity[]> {
    if (input.count <= 0) return [];

    const roster = await this.all();
    if (roster.length === 0) return [];

    // A cheap, stable hash of the key: same tournament, same starting bot.
    let offset = 0;
    for (const char of input.rotationKey) offset = (offset * 31 + char.charCodeAt(0)) % 997;
    const start = offset % roster.length;

    const picked: BotIdentity[] = [];
    for (let i = 0; i < Math.min(input.count, roster.length); i++) {
      const identity = roster[(start + i) % roster.length];
      if (identity) picked.push({ ...identity, difficulty: input.difficulty });
    }

    return picked;
  }

  /**
   * One bot by its profile key, or null.
   *
   * Used when a stored registration is turned back into a seat. Returning null
   * rather than throwing is deliberate: a bracket that names a bot which has
   * since been deactivated must still be readable, and the caller decides
   * whether the missing seat is a walkover or a hole in the listing.
   */
  async byBotId(botId: string, difficulty?: BotDifficultyWire): Promise<BotIdentity | null> {
    const roster = await this.all();
    const found = roster.find((entry) => entry.botId === botId);
    if (!found) return null;
    return difficulty ? { ...found, difficulty } : found;
  }

  /**
   * Whether an id belongs to a bot.
   *
   * The engine asks this on the end-of-match path to decide whose lifetime
   * stats move, and the seat's own `isBot` flag is the answer it uses. This is
   * the out-of-band check, for code holding an id and no seat — the bracket's
   * result writer, mostly. It reads the cached roster, so it costs a list scan
   * over six entries and no query.
   */
  async isBotPlayerId(playerId: string): Promise<boolean> {
    const roster = await this.all();
    return roster.some((entry) => entry.playerId === playerId);
  }

  /** Drops the cache. Used by tests and after an operator changes a row. */
  refresh(): void {
    cache = null;
  }
}

export const botProfileService = new BotProfileService();
