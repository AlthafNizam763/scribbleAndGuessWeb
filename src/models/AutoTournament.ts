import { Schema, Types, model, models, type InferSchemaType, type Model } from 'mongoose';

import {
  AUTO_TOURNAMENT_DEFAULTS,
  AUTO_TOURNAMENT_FORMAT,
  AUTO_TOURNAMENT_LIMITS,
  AUTO_TOURNAMENT_STATUS,
  BOT_DIFFICULTY,
  CREATED_BY_TYPE,
  DAILY_SLOT,
  PLAYER_TYPE,
  REGISTRATION_STATUS,
  TOURNAMENTS_PER_DAY,
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
 * ## The daily invariant
 *
 * "Exactly three tournaments a day, never four" is enforced by the unique
 * index on `{tournamentDate, dailySlot, isAutomatic}` below. That makes a
 * duplicate a *write failure* rather than something a scheduler has to notice:
 * two processes racing to create this evening's tournament both insert, one
 * wins, the loser gets a duplicate-key error and moves on. No count is read,
 * so there is no window between reading it and acting on it.
 *
 * The constraint holds for every status, which is the difference from the
 * rolling model it replaced. A completed morning tournament still owns
 * `{2026-09-16, MORNING}` for ever, so nothing can be created in its place —
 * and nothing should be, because the afternoon one was always going to happen
 * on its own.
 */

const autoTournamentSchema = new Schema(
  {
    /**
     * The calendar day this tournament belongs to, as `YYYY-MM-DD`.
     *
     * In the deployment's configured timezone, not UTC and not the host's —
     * see `utils/dayKey.ts` for why a string rather than a `Date`. Half of the
     * identity of a tournament, and half of the unique index.
     */
    tournamentDate: {
      type: String,
      required: true,
      match: /^\d{4}-\d{2}-\d{2}$/,
    },

    /**
     * Which of the day's three tournaments this is.
     *
     * The other half of the identity. Named rather than timed so that moving
     * the evening tournament by an hour is a configuration change and every
     * row already stamped `EVENING` stays correct.
     */
    dailySlot: {
      type: String,
      enum: Object.values(DAILY_SLOT),
      required: true,
    },

    /**
     * The slot's position in the day, 1 to 3.
     *
     * Denormalised from `dailySlot` purely so the listing sorts in the
     * database: Mongo cannot order by a hand-written sequence of strings, and
     * MORNING, AFTERNOON, EVENING is not alphabetical. Never written by hand —
     * see `DAILY_SLOT_ORDER`.
     */
    slotNumber: {
      type: Number,
      required: true,
      min: 1,
      max: TOURNAMENTS_PER_DAY,
    },

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
    /**
     * When bots may begin taking the empty seats.
     *
     * Stored on the row rather than derived from `registrationOpenAt` plus the
     * current configuration, for the same reason every other rule here is
     * copied onto the row: a tournament people are already sitting in keeps
     * the timings it advertised when they joined.
     *
     * Optional in the schema so a row written before this field existed still
     * loads. `openRegistration` sets it on every tournament it opens, and the
     * scheduler treats a missing value as "fill immediately", which is the
     * safe reading for a row that has been waiting through a deploy.
     */
    botFillAt: { type: Date, default: null },
    /**
     * When the start countdown ends, or null outside `STARTING`.
     *
     * Cleared when a tournament leaves the phase, so the field answers "is a
     * countdown running, and until when" on its own rather than only in
     * combination with the status.
     */
    countdownEndsAt: { type: Date, default: null },
    checkInOpenAt: { type: Date, required: true },
    checkInCloseAt: { type: Date, required: true },
    /** When play begins. Rewritten to the real moment as the bracket is drawn. */
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

    /**
     * The winner, copied out at the moment they won.
     *
     * ## Why a snapshot and not a join
     *
     * Because a result is a historical fact and a profile is not. Somebody who
     * wins Ink Royale on Tuesday and renames themselves on Thursday did not
     * retroactively win it under the new name — and a results card that
     * re-read the profile would say they did, silently rewriting every
     * tournament they have ever been in.
     *
     * So the name, the avatar and the user id are written once, here, and
     * every reader shows what was written. `winnerRegistrationId` still points
     * at the live row for anything that needs the current person; these
     * fields are what the card draws.
     *
     * `winnerUserId` is null when a bot won, which is a thing that can happen
     * and has to be able to be told apart from "not finished yet" —
     * `completedAt` is what answers that.
     */
    winnerUserId: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    winnerDisplayName: { type: String, default: null },
    winnerAvatarId: { type: Number, default: null },
    winnerAvatarColorIndex: { type: Number, default: null },
    winnerIsBot: { type: Boolean, default: false },

    /**
     * The final placement table, frozen at completion.
     *
     * Same reasoning as the winner snapshot, applied to everybody else: a
     * player who came third is third for ever under the name they played
     * under. Stored on the tournament rather than assembled from registration
     * rows on every read, so a finished tournament's result is one document
     * and cannot drift as those rows are edited.
     *
     * Empty until the final is decided. A tournament that was cancelled never
     * gets one, because it has no result to freeze.
     */
    finalRankings: {
      type: [
        new Schema(
          {
            registrationId: { type: Schema.Types.ObjectId, required: true },
            userId: { type: Schema.Types.ObjectId, ref: 'User', default: null },
            displayName: { type: String, required: true },
            avatarId: { type: Number, default: 0 },
            avatarColorIndex: { type: Number, default: 0 },
            isBot: { type: Boolean, default: false },
            placement: { type: Number, required: true, min: 1 },
            eliminatedInRound: { type: Number, default: null },
          },
          { _id: false },
        ),
      ],
      default: [],
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
 * One tournament per slot per day. The whole "never a fourth" rule.
 *
 * ## Why this one is not partial
 *
 * Because a daily slot is never reused. `{2026-09-16, MORNING}` names one
 * event for all time, so the constraint should hold for all time — including
 * after it has finished, which is precisely when a scheduler that had lost
 * track might try to create "today's morning tournament" a second time.
 *
 * That is the opposite of the index this replaced, which had to be restricted
 * to live statuses because a rolling slot came free the moment its occupant
 * ended. Under the daily model nothing comes free, and an unrestricted unique
 * index is both simpler and stricter.
 *
 * `isAutomatic` is in the key because the product rule is about *automatic*
 * tournaments. Nothing else creates one today — there is no route that could —
 * so in practice the key is the date and the slot.
 *
 * **This index replaces `one_live_tournament_per_slot`, which must be
 * dropped.** `npm run sync-indexes` does both.
 */
autoTournamentSchema.index(
  { tournamentDate: 1, dailySlot: 1, isAutomatic: 1 },
  { unique: true, name: 'one_tournament_per_slot_per_day' },
);

/** The scheduler's own sweep: everything unfinished, by deadline. */
autoTournamentSchema.index({ status: 1, registrationOpenAt: 1 });
autoTournamentSchema.index({ status: 1, registrationCloseAt: 1 });
autoTournamentSchema.index({ status: 1, checkInCloseAt: 1 });
autoTournamentSchema.index({ status: 1, startAt: 1 });
/** The two fast-start deadlines, for the same sweep. */
autoTournamentSchema.index({ status: 1, botFillAt: 1 });
autoTournamentSchema.index({ status: 1, countdownEndsAt: 1 });

/**
 * The listing: one day's tournaments, in the order they happen.
 *
 * The most-read query in the feature — it is what the tournament screen asks
 * for — and it is fully covered by this index, including the sort, so drawing
 * three cards never scans.
 */
autoTournamentSchema.index({ tournamentDate: 1, slotNumber: 1 });
autoTournamentSchema.index({ isAutomatic: 1, tournamentDate: 1, status: 1 });
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
    /**
     * Why they went out, when it was not simply losing.
     *
     * Only `'disconnected'` is written today, by the stand-in service. It is a
     * string rather than a boolean because the results table shows it to the
     * player, and "you were disconnected" is a different sentence from "you
     * lost" — conflating the two makes the tournament look like it cheated.
     */
    eliminatedReason: { type: String, default: null },
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
 * "Which of today's tournaments is this user in?"
 *
 * Asked once per listing, for a set of tournament ids at a time rather than
 * one at a time — a player may hold a place in all three of a day's
 * tournaments, so this is a per-row answer and the listing would otherwise be
 * a query per card.
 *
 * The user leads because it is the selective half. It also answers "is this
 * user in a match right now", which is the one remaining cross-tournament
 * rule: registrations are unlimited, but two matches at the same moment are
 * not.
 */
tournamentRegistrationSchema.index({ userId: 1, status: 1 });
tournamentRegistrationSchema.index({ userId: 1, tournamentId: 1 });

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
