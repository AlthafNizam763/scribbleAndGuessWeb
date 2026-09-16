import { Schema, model, models, type InferSchemaType, type Model } from 'mongoose';

import { INPUT_LIMITS } from '@/constants/game.constants';
import {
  LOCALITY_LIMITS,
  PROFILE_LIMITS,
  USER_ROLE,
  USER_ROLES,
} from '@/constants/social.constants';

/**
 * A player account (brief section 5).
 *
 * Guests get a row here too. They are real users with a real `_id` — that id
 * is what rooms, scores and reports reference — they simply have no
 * credentials yet. Keeping guests in the same collection is what lets section
 * 6's "upgrade to Google/Apple/email later" happen by adding a provider to an
 * existing row rather than migrating anybody's history.
 */

const userSchema = new Schema(
  {
    username: {
      type: String,
      required: true,
      trim: true,
      minlength: INPUT_LIMITS.minNameLength,
      maxlength: INPUT_LIMITS.maxNameLength,
    },

    /**
     * Which of the 18 procedural doodle avatars this player draws as.
     *
     * Stored as the client's `avatarId`/`avatarColorIndex` pair rather than an
     * image: the app draws avatars with a `CustomPainter`, so there is no asset
     * to store and nothing to serve.
     */
    avatarId: { type: Number, required: true, default: 0, min: 0, max: INPUT_LIMITS.avatarCount - 1 },
    avatarColorIndex: {
      type: Number,
      required: true,
      default: 0,
      min: 0,
      max: INPUT_LIMITS.avatarColorCount - 1,
    },

    /**
     * Optional, and only set once an account is linked.
     *
     * Uniqueness is enforced by the partial index declared below rather than
     * by `unique: true` here — see the note on that index for why neither a
     * plain nor a sparse unique index works for this field.
     */
    email: { type: String, trim: true, lowercase: true, default: undefined },

    /** Password hash. Never selected by default; only the auth service asks. */
    passwordHash: { type: String, default: null, select: false },

    /**
     * What this account may do beyond playing.
     *
     * There is deliberately no endpoint that writes this. A self-service path
     * to moderator is a self-service path to reading everybody's reports, so
     * the field is changed in the database and nowhere else — and it is read
     * from the row on every privileged request rather than carried in a token,
     * so revoking access takes effect on the next call instead of in thirty
     * days when the token expires.
     */
    role: {
      type: String,
      enum: USER_ROLES,
      default: USER_ROLE.player,
      required: true,
    },

    authProvider: {
      type: String,
      enum: ['guest', 'google', 'apple', 'email'],
      required: true,
      default: 'guest',
    },

    /**
     * A short self-description, shown on the profile.
     *
     * Masked rather than refused if it contains profanity — see
     * `user.service.ts`. Bounded hard because it is the one free-text field an
     * account carries, and the only one a stranger can read.
     */
    bio: { type: String, trim: true, maxlength: PROFILE_LIMITS.maxBioLength, default: '' },

    /**
     * Cosmetic choices, stored as keys rather than as colours or assets.
     *
     * A client that could store its own hex value would be storing arbitrary
     * strings on a public profile; a key can only ever name something this
     * build ships. Unknown keys render as the default, so retiring a frame
     * does not break the accounts wearing it.
     */
    profileFrame: { type: String, trim: true, maxlength: 32, default: 'none' },
    profileTheme: { type: String, trim: true, maxlength: 32, default: 'paper' },

    /**
     * The category this player has drawn or guessed most.
     *
     * Denormalised because working it out means grouping every round they
     * appeared in — an aggregation across the whole `rounds` collection to
     * render one line on a profile.
     */
    favoriteCategory: { type: String, trim: true, maxlength: 32, default: null },

    lastSeenAt: { type: Date, default: Date.now },

    /**
     * Lifetime statistics.
     *
     * Written only by the game engine at the end of a match. The `PATCH
     * /api/users/me` handler explicitly refuses these fields (brief section 8)
     * — a client that could set its own `totalScore` would make the
     * leaderboard meaningless.
     */
    gamesPlayed: { type: Number, default: 0, min: 0 },
    gamesWon: { type: Number, default: 0, min: 0 },
    totalScore: { type: Number, default: 0, min: 0 },
    bestRoundScore: { type: Number, default: 0, min: 0 },

    /**
     * The counters the achievement catalogue watches.
     *
     * ## Why they live here and not in their own collection
     *
     * Every one of them is read together, on the same path, for the same
     * player: the end-of-match evaluation needs all of them at once and would
     * otherwise be a join. They are also all monotonic — each only ever goes
     * up — which is what makes re-evaluating an achievement safe. A threshold
     * once crossed stays crossed, so a repeated evaluation awards nothing new,
     * and the unique index on `achievements` catches the race where two
     * evaluations run at once.
     *
     * Written the same way the stats above are: by the game engine, with
     * `$inc`, and refused outright by `PATCH /api/users/me`. A client that
     * could set its own `correctGuesses` could award itself every achievement
     * in the catalogue.
     */
    correctGuesses: { type: Number, default: 0, min: 0 },
    /** Correct guesses that were the *first* of their turn. */
    firstGuesses: { type: Number, default: 0, min: 0 },
    /** Correct guesses inside the opening fraction of a turn. */
    fastGuesses: { type: Number, default: 0, min: 0 },
    /** Turns drawn where every eligible guesser got it. */
    perfectDrawings: { type: Number, default: 0, min: 0 },
    /** Turns taken as the drawer, finished rather than abandoned. */
    drawingTurns: { type: Number, default: 0, min: 0 },

    /**
     * Consecutive wins.
     *
     * `currentWinStreak` is the only field in this block that can go *down* —
     * a loss resets it to zero — which is exactly why the achievement watches
     * `bestWinStreak` instead. An achievement keyed on a resettable counter
     * could be lost after being earned, and re-earned, and awarded twice.
     */
    currentWinStreak: { type: Number, default: 0, min: 0 },
    bestWinStreak: { type: Number, default: 0, min: 0 },

    /** Counters for achievements whose features are not built yet. */
    dailyChallengesCompleted: { type: Number, default: 0, min: 0 },
    tournamentsWon: { type: Number, default: 0, min: 0 },

    /**
     * Experience, and the level derived from it.
     *
     * `xp` is the authority; `level` is denormalised from it by
     * `levelForXp` on every award. Storing both looks redundant and is not:
     * the leaderboard and the profile list need to sort and filter by level
     * without recomputing a power function per row, and the two cannot drift
     * because nothing writes `level` except the one service that writes `xp`.
     */
    xp: { type: Number, default: 0, min: 0 },
    level: { type: Number, default: 1, min: 1 },

    /**
     * Where the player plays from, for the locality leaderboard.
     *
     * ## Why these three fields and no more
     *
     * A locality board only needs to answer "who else is near me", and a town
     * name answers it. A street address, a postcode or a coordinate pair would
     * answer a different and far more dangerous question, so none of them is a
     * field here: there is no schema path by which an address could be stored,
     * whatever a client sends. This is the same argument as the stats above —
     * a write that cannot be expressed cannot be made.
     *
     * Every field is optional. A player who never fills them in simply has no
     * locality board, which is the empty state the client renders.
     */
    city: { type: String, trim: true, maxlength: LOCALITY_LIMITS.maxCityLength, default: null },
    region: { type: String, trim: true, maxlength: LOCALITY_LIMITS.maxRegionLength, default: null },
    /** ISO 3166-1 alpha-2, upper case. */
    country: {
      type: String,
      trim: true,
      uppercase: true,
      maxlength: LOCALITY_LIMITS.countryLength,
      default: null,
    },

    /**
     * The grouping key for the locality board, derived from the fields above.
     *
     * Written by `userRepository.updateLocality` and never accepted from a
     * caller. It exists because "same locality" has to be an equality match on
     * one indexed field: comparing `city` and `country` separately would mean
     * a compound index whose leading field is low-cardinality, and comparing
     * display strings directly would put `Kochi` and `kochi ` in different
     * towns.
     */
    localityKey: { type: String, default: null },
  },
  {
    timestamps: true,
    collection: 'users',
  },
);

/**
 * One account per email — but only among rows that actually have one.
 *
 * A plain unique index would reject the second guest ever created, since every
 * guest has no email and they would all collide. A *sparse* unique index does
 * not fix it either: sparse skips documents where the field is **absent**, and
 * a schema default of `null` makes the field present-and-null on every guest,
 * so they collide just the same.
 *
 * A partial index keyed on the field being a string is the version that works:
 * guests are not indexed at all, and two linked accounts still cannot share an
 * address.
 */
userSchema.index(
  { email: 1 },
  { unique: true, partialFilterExpression: { email: { $type: 'string' } } },
);

/**
 * The world leaderboard's ordering, served straight from the index.
 *
 * All three keys, in the order the query sorts by. `_id` is the tie-break that
 * makes the ranking stable between requests, and it has to be *in* the index:
 * with only the first two keys Mongo can walk the index for the first two
 * fields but must then sort the ties in memory, which is both slower and, past
 * the 32MB sort limit, an outright error on a large board.
 *
 * It is also what makes `countDocuments({gamesPlayed: {$gt: 0}})` and the
 * "how many players are above me" rank query index-only.
 */
userSchema.index({ totalScore: -1, gamesWon: -1, _id: 1 });

/**
 * The same ordering, scoped to one town.
 *
 * `localityKey` leads because it is the equality predicate; the sort keys
 * follow. This is the shape an index has to have to serve equality-then-sort
 * without a blocking sort stage.
 */
userSchema.index({ localityKey: 1, totalScore: -1, gamesWon: -1, _id: 1 });

/**
 * User search.
 *
 * Search is an anchored, case-insensitive regex over this field. An anchored
 * regex with the `i` flag cannot *seek* in the index the way a case-sensitive
 * one can, so this is an index scan rather than a range scan — but it stays
 * inside the index instead of touching documents, and every search endpoint
 * is both hard-limited and rate-limited. The alternative, a denormalised
 * lower-case column, would need a backfill for every account that already
 * exists and would go stale on any write that forgot it.
 */
userSchema.index({ username: 1 });

// Lets the sweeper find stale guest accounts without a collection scan.
userSchema.index({ lastSeenAt: -1 });

export type UserDocument = InferSchemaType<typeof userSchema>;

/**
 * `models.User ?? model(...)` rather than a bare `model(...)`.
 *
 * Next.js re-evaluates this module on every hot reload, and registering the
 * same model name twice makes Mongoose throw `OverwriteModelError`.
 */
export const User: Model<UserDocument> =
  (models.User as Model<UserDocument>) ?? model<UserDocument>('User', userSchema);
