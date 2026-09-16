import { Schema, Types, model, models, type InferSchemaType, type Model } from 'mongoose';

import {
  AUTO_TOURNAMENT_DEFAULTS,
  AUTO_TOURNAMENT_FORMAT,
  AUTO_TOURNAMENT_LIMITS,
  AUTO_TOURNAMENT_STATUS,
  BOT_DIFFICULTY,
  CREATED_BY_TYPE,
  PLAYER_TYPE,
  REGISTRATION_STATUS,
  SLOT_HOLDING_STATUSES,
  TOURNAMENT_SLOT_COUNT,
} from '@/constants/autoTournament.constants';

/**
 * An automatically organised knockout tournament, and who is in it.
 *
 * ## Why this is not the `Tournament` model next door
 *
 * `models/Tournament.ts` describes a points event whose status is derived from
 * three timestamps and which nothing has to run. This one has a bracket, and a
 * bracket needs somebody to decide pairings at a moment — so it has a stored
 * status, a scheduler that advances it, and rows the scheduler owns. The two
 * share no fields worth merging and merging them would mean one model where
 * half the columns are meaningless for half the rows.
 *
 * Both collections are live at once and the REST layer resolves an id against
 * this one first. Nothing about the points feature changes.
 *
 * ## The slot invariant
 *
 * "Exactly three tournaments, never four" is enforced by the partial unique
 * index on `slotNumber` below, restricted to the statuses that hold a slot.
 * That makes a duplicate a *write failure* rather than something a scheduler
 * has to notice: two processes racing to fill slot 2 both insert, one wins,
 * the loser gets a duplicate-key error and moves on. No count is read, so
 * there is no window between reading it and acting on it.
 */

const autoTournamentSchema = new Schema(
  {
    /**
     * Which of the three slots this tournament occupies.
     *
     * The unique index below is on this field, so it is also the concurrency
     * control: a slot holds one unfinished tournament and the database says so.
     */
    slotNumber: {
      type: Number,
      required: true,
      min: 1,
      max: TOURNAMENT_SLOT_COUNT,
    },

    /**
     * A monotonically increasing number across every tournament ever created,
     * used to build the public name.
     *
     * Global rather than per slot so two tournaments never share a display
     * name — "Daily Scribble Cup #7" refers to one event for all time, which is
     * what makes a result announcement mean something afterwards.
     */
    tournamentNumber: { type: Number, required: true },

    name: { type: String, required: true, trim: true, maxlength: AUTO_TOURNAMENT_LIMITS.maxNameLength },
    description: {
      type: String,
      trim: true,
      maxlength: AUTO_TOURNAMENT_LIMITS.maxDescriptionLength,
      default: '',
    },

    status: {
      type: String,
      enum: Object.values(AUTO_TOURNAMENT_STATUS),
      default: AUTO_TOURNAMENT_STATUS.upcoming,
      required: true,
    },

    format: { type: String, default: AUTO_TOURNAMENT_FORMAT },

    /**
     * The rules this tournament was created under.
     *
     * Copied from configuration at creation rather than read live, so a
     * tournament already taking registrations keeps the size and bot policy it
     * advertised even if the deployment is reconfigured mid-window.
     */
    minPlayers: { type: Number, default: AUTO_TOURNAMENT_DEFAULTS.minPlayers, min: 2 },
    maxPlayers: {
      type: Number,
      default: AUTO_TOURNAMENT_DEFAULTS.maxPlayers,
      max: AUTO_TOURNAMENT_LIMITS.maxBracketSize,
    },
    minHumanPlayers: { type: Number, default: AUTO_TOURNAMENT_DEFAULTS.minHumanPlayers, min: 1 },
    maxBots: { type: Number, default: AUTO_TOURNAMENT_DEFAULTS.maxBots, min: 0 },
    allowBots: { type: Boolean, default: AUTO_TOURNAMENT_DEFAULTS.allowBots },
    botDifficulty: {
      type: String,
      enum: Object.values(BOT_DIFFICULTY),
      default: AUTO_TOURNAMENT_DEFAULTS.botDifficulty,
    },

    /**
     * Denormalised roster counts.
     *
     * The authoritative answer is always a count over `tournament_registrations`
     * — and the registration paths use `countDocuments` for their own checks,
     * because a cached number is exactly the wrong thing to enforce a limit
     * with. These exist so the three-slot listing, which is the most-read
     * screen in the feature, does not fan out into a count per slot per
     * viewer. They are rewritten from the real count whenever the roster
     * changes, so they converge rather than drift.
     */
    registeredCount: { type: Number, default: 0, min: 0 },
    humanPlayerCount: { type: Number, default: 0, min: 0 },
    botPlayerCount: { type: Number, default: 0, min: 0 },

    /** The lifecycle deadlines the scheduler acts on. */
    registrationOpenAt: { type: Date, required: true },
    registrationCloseAt: { type: Date, required: true },
    checkInOpenAt: { type: Date, required: true },
    checkInCloseAt: { type: Date, required: true },
    /** When play begins. Equal to `checkInCloseAt` unless a start is delayed. */
    startAt: { type: Date, required: true },

    /** How many bracket rounds this tournament has, once seeded. Zero before. */
    totalRounds: { type: Number, default: 0, min: 0 },
    /** The round being played, 1-based. Zero before the bracket is drawn. */
    currentRound: { type: Number, default: 0, min: 0 },

    /**
     * Who won. A registration id rather than a user id, because a bot can win
     * a match and a bot has no user row.
     */
    winnerRegistrationId: {
      type: Schema.Types.ObjectId,
      ref: 'TournamentRegistration',
      default: null,
    },
    completedAt: { type: Date, default: null },
    /** Why a cancelled tournament was cancelled, for the listing to explain. */
    cancelReason: { type: String, default: null },

    /**
     * Provenance. Both fields are constants, and that is the point: there is
     * no code path that writes anything else, so "users cannot create
     * tournaments" is visible in the schema rather than only in a route that
     * does not exist.
     */
    createdByType: {
      type: String,
      enum: Object.values(CREATED_BY_TYPE),
      default: CREATED_BY_TYPE.systemBot,
    },
    createdByUserId: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    isAutomatic: { type: Boolean, default: true },
  },
  { timestamps: true, collection: 'auto_tournaments' },
);

/**
 * One unfinished tournament per slot. The whole "never a fourth" rule.
 *
 * Partial rather than plain unique: a slot is reused for ever, so a plain
 * index would reserve it against every tournament that ever ran in it. Only
 * the statuses in `SLOT_HOLDING_STATUSES` constrain, which is exactly the set
 * that occupies a slot.
 */
autoTournamentSchema.index(
  { slotNumber: 1 },
  {
    unique: true,
    name: 'one_live_tournament_per_slot',
    partialFilterExpression: { status: { $in: [...SLOT_HOLDING_STATUSES] } },
  },
);

/** The display number is unique for all time, so a name names one event. */
autoTournamentSchema.index({ tournamentNumber: 1 }, { unique: true });

/** The scheduler's own sweep: everything still holding a slot, by deadline. */
autoTournamentSchema.index({ status: 1, registrationCloseAt: 1 });
autoTournamentSchema.index({ status: 1, checkInCloseAt: 1 });
autoTournamentSchema.index({ status: 1, startAt: 1 });

/** The listing: the three slots, newest tournament per slot first. */
autoTournamentSchema.index({ isAutomatic: 1, status: 1, slotNumber: 1 });
autoTournamentSchema.index({ startAt: 1 });

/**
 * One player's place in one tournament.
 *
 * ## Why `userId` and `botId` are two nullable fields rather than one id
 *
 * They point at different things. A `userId` is a real `users` row with a
 * profile, a leaderboard standing and an owner; a `botId` names a profile in
 * `tournament_bot_profiles` that exists only so the server can seat something.
 * Collapsing them into one column would mean every read had to consult
 * `playerType` before it knew which collection to look in — and the one that
 * forgot would be the one that put a bot on the world leaderboard.
 *
 * Exactly one is set. The two unique indexes below are sparse for that reason:
 * a human row has a null `botId` and must not collide with every other human
 * row in the tournament.
 */
const tournamentRegistrationSchema = new Schema(
  {
    tournamentId: {
      type: Schema.Types.ObjectId,
      ref: 'AutoTournament',
      required: true,
    },

    userId: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    botId: { type: String, default: null },

    /** Copied at registration, so a bracket reads without a join per seat. */
    displayName: { type: String, required: true, trim: true },
    avatarId: { type: Number, default: 0 },
    avatarColorIndex: { type: Number, default: 0 },

    playerType: {
      type: String,
      enum: Object.values(PLAYER_TYPE),
      required: true,
    },
    /**
     * Redundant with `playerType`, and deliberately so.
     *
     * Every serialiser that reaches a client sends this, and every client
     * renders a badge from it. A boolean is harder to get wrong in a template
     * than a string comparison, and the cost of getting it wrong is showing an
     * AI as a person.
     */
    isBot: { type: Boolean, required: true },
    botDifficulty: {
      type: String,
      enum: [...Object.values(BOT_DIFFICULTY), null],
      default: null,
    },

    status: {
      type: String,
      enum: Object.values(REGISTRATION_STATUS),
      default: REGISTRATION_STATUS.registered,
    },

    /** Position in the bracket, assigned at seeding. Null before. */
    seed: { type: Number, default: null },

    joinedAt: { type: Date, default: Date.now },
    checkedInAt: { type: Date, default: null },
    /** Which round they went out in, for the results table. */
    eliminatedInRound: { type: Number, default: null },
  },
  { timestamps: true, collection: 'tournament_registrations' },
);

/**
 * No duplicate human registrations, and no duplicate bot registrations.
 *
 * ## Why these are partial and not sparse
 *
 * Because `sparse` does not do what it looks like it does on a *compound*
 * index. A sparse compound index skips a document only when it has none of the
 * indexed fields — and every row here has a `tournamentId`, so every row is
 * indexed, nulls and all. A tournament with four people would then have four
 * rows whose key is `{tournamentId, botId: null}`, and the second registration
 * would be rejected as a duplicate of the first.
 *
 * That is not a hypothetical: it is what these indexes did before the
 * integration suite caught it, and the symptom was a tournament that silently
 * admitted exactly one player and one bot.
 *
 * `partialFilterExpression` indexes only the rows that actually have the
 * field, which is what was meant. The human index covers rows with a real
 * `userId`; the bot index covers rows with a real `botId`; and since exactly
 * one of the two is ever set, each row is in exactly one index.
 */
tournamentRegistrationSchema.index(
  { tournamentId: 1, userId: 1 },
  {
    unique: true,
    name: 'one_registration_per_user',
    partialFilterExpression: { userId: { $type: 'objectId' } },
  },
);
tournamentRegistrationSchema.index(
  { tournamentId: 1, botId: 1 },
  {
    unique: true,
    name: 'one_registration_per_bot',
    partialFilterExpression: { botId: { $type: 'string' } },
  },
);

/** Counting humans and bots separately, which the fill logic does constantly. */
tournamentRegistrationSchema.index({ tournamentId: 1, playerType: 1, status: 1 });

/**
 * "Is this user already in a live tournament?"
 *
 * Asked on every registration attempt and on every tournament listing, against
 * a filter of the user plus a status set. The user leads because it is the
 * selective half.
 */
tournamentRegistrationSchema.index({ userId: 1, status: 1 });

/** The bracket read: one tournament's roster in seed order. */
tournamentRegistrationSchema.index({ tournamentId: 1, seed: 1 });

export type AutoTournamentDocument = InferSchemaType<typeof autoTournamentSchema> & {
  _id: Types.ObjectId;
};
export type TournamentRegistrationDocument = InferSchemaType<
  typeof tournamentRegistrationSchema
> & { _id: Types.ObjectId };

export const AutoTournament: Model<AutoTournamentDocument> =
  (models.AutoTournament as Model<AutoTournamentDocument>) ??
  model<AutoTournamentDocument>('AutoTournament', autoTournamentSchema);

export const TournamentRegistration: Model<TournamentRegistrationDocument> =
  (models.TournamentRegistration as Model<TournamentRegistrationDocument>) ??
  model<TournamentRegistrationDocument>(
    'TournamentRegistration',
    tournamentRegistrationSchema,
  );
