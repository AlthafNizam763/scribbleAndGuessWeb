import { Schema, Types, model, models, type InferSchemaType, type Model } from 'mongoose';

import { ROOM_DEFAULTS } from '@/constants/game.constants';
import {
  LANGUAGES,
  ROOM_STATUS,
  WORD_CATEGORIES,
  WORD_MODES,
  CONNECTION,
  WORD_DIFFICULTIES,
} from '@/constants/room.constants';

/**
 * A room and everyone seated in it (brief sections 9 and 10).
 *
 * ## Why players are embedded rather than their own collection
 *
 * A room is read as a whole on every broadcast — `s:room:state` carries the
 * full player list — and it is never large: twelve players is the ceiling. An
 * embedded array means one read per broadcast and one atomic write per change,
 * where a separate collection would mean a join on the hottest path in the
 * app. The brief's `players` collection is this array.
 *
 * ## What this document is and is not
 *
 * This is the *durable* record: it survives a restart, backs the REST API and
 * is what a reconnecting player is restored from. It is not the thing consulted
 * on every stroke — that is the in-memory runtime in `room.service.ts`, which
 * writes through to here on state changes rather than on every packet.
 */

const roomPlayerSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    username: { type: String, required: true, trim: true },
    avatarId: { type: Number, required: true, default: 0 },
    avatarColorIndex: { type: Number, required: true, default: 0 },

    /** Total across the match. Only the scoring service writes this. */
    score: { type: Number, default: 0, min: 0 },
    /** Points from the current turn, shown as a delta in the UI. */
    roundScore: { type: Number, default: 0, min: 0 },

    isReady: { type: Boolean, default: false },
    isMuted: { type: Boolean, default: false },

    /**
     * Whether this player already got the word this turn.
     *
     * Reset at the start of every turn. This is the flag that makes
     * double-scoring impossible (brief section 32) — it is checked and set in
     * the same synchronous step inside the game service.
     */
    hasGuessed: { type: Boolean, default: false },
    /** 1 for the first correct guesser, 2 for the second, and so on. */
    guessOrder: { type: Number, default: null },

    connection: {
      type: String,
      enum: Object.values(CONNECTION),
      default: CONNECTION.connected,
    },

    joinedAt: { type: Date, default: Date.now },
    lastSeenAt: { type: Date, default: Date.now },
  },
  { _id: false },
);

const roomSettingsSchema = new Schema(
  {
    maxPlayers: { type: Number, default: ROOM_DEFAULTS.maxPlayers },
    rounds: { type: Number, default: ROOM_DEFAULTS.rounds },
    drawTimeSeconds: { type: Number, default: ROOM_DEFAULTS.drawTimeSeconds },
    wordChoiceCount: { type: Number, default: ROOM_DEFAULTS.wordChoiceCount },
    hintCount: { type: Number, default: ROOM_DEFAULTS.hintCount },
    wordSelectSeconds: { type: Number, default: ROOM_DEFAULTS.wordSelectSeconds },
    wordMode: { type: String, enum: WORD_MODES, default: 'normal' },
    language: { type: String, enum: LANGUAGES, default: 'en' },
    categories: { type: [String], enum: WORD_CATEGORIES, default: [] },
    customWords: { type: [String], default: [] },
    allowVoteKick: { type: Boolean, default: ROOM_DEFAULTS.allowVoteKick },
    /**
     * Whether guessers may talk to each other, and whether the text channel
     * is open.
     *
     * Room settings rather than client preferences, because both are things a
     * host decides for everybody — and because a client that could decide its
     * own would be deciding whether the server relays other people's audio to
     * it. `voiceService.assertMayUseVoice` and the chat handler both read
     * these, so turning either off is enforced where it matters rather than
     * only hiding a button.
     *
     * Neither ever affects guessing: a room with chat off still accepts
     * guesses, because guessing is how the game is played.
     */
    voiceEnabled: { type: Boolean, default: ROOM_DEFAULTS.voiceEnabled },
    chatEnabled: { type: Boolean, default: ROOM_DEFAULTS.chatEnabled },

    /**
     * Which rule set the match runs under.
     *
     * A plain string rather than an enum of the current catalogue, for the
     * same reason a stroke's tool is: a room stored under a mode that is later
     * retired must still load. Unknown modes resolve to Classic at read time
     * via modeRules, so an old row plays rather than failing to start.
     */
    gameMode: { type: String, default: ROOM_DEFAULTS.gameMode },

    /** Whether people may watch once every seat is taken. */
    allowSpectators: { type: Boolean, default: ROOM_DEFAULTS.allowSpectators },

    /** Whether only the host's friends may join by code. */
    friendsOnly: { type: Boolean, default: ROOM_DEFAULTS.friendsOnly },

    /** Narrows the word pool. Null lets the mode or the room decide. */
    wordDifficulty: { type: String, enum: [...WORD_DIFFICULTIES, null], default: null },
    isPrivate: { type: Boolean, default: ROOM_DEFAULTS.isPrivate },
  },
  { _id: false },
);

const roomSchema = new Schema(
  {
    /** The shareable five-character code. Unique among *live* rooms. */
    roomCode: { type: String, required: true, uppercase: true, trim: true },

    ownerId: { type: Schema.Types.ObjectId, ref: 'User', required: true },

    status: {
      type: String,
      enum: Object.values(ROOM_STATUS),
      default: ROOM_STATUS.waiting,
      required: true,
    },

    settings: { type: roomSettingsSchema, default: () => ({}) },
    players: { type: [roomPlayerSchema], default: [] },

    /** Room-scoped bans (brief section 42). A ban does not follow a user out. */
    bannedUserIds: { type: [Schema.Types.ObjectId], default: [] },

    currentGameId: { type: Schema.Types.ObjectId, ref: 'Game', default: null },

    /** Set when the room is closed, so the sweeper can find dead rooms. */
    closedAt: { type: Date, default: null },
  },
  { timestamps: true, collection: 'rooms' },
);

/**
 * One live room per code.
 *
 * Partial rather than plain unique: codes are recycled once a room closes, and
 * a plain unique index would keep every closed room's code reserved forever.
 */
roomSchema.index(
  { roomCode: 1 },
  { unique: true, partialFilterExpression: { closedAt: null } },
);

roomSchema.index({ closedAt: 1, updatedAt: 1 });
roomSchema.index({ 'players.userId': 1 });

/**
 * The Quick Play candidate scan.
 *
 * Every key is an equality or set predicate except the last, which is the
 * sort. `closedAt` leads because it is the one filter every room query shares,
 * then the two that narrow hardest — public, and open to joining — and finally
 * `createdAt` so "oldest waiting room first" comes off the index instead of a
 * blocking sort.
 *
 * Only the fallback path in `roomRepository.findJoinablePublic` uses this. In
 * the single-process deployment matchmaking reads the in-memory registry and
 * touches no index at all; this is what keeps the split deployment's REST side
 * from doing a collection scan for every Play tap.
 */
roomSchema.index({ closedAt: 1, 'settings.isPrivate': 1, status: 1, createdAt: 1 });

export type RoomDocument = InferSchemaType<typeof roomSchema> & { _id: Types.ObjectId };
export type RoomPlayerDocument = InferSchemaType<typeof roomPlayerSchema>;
export type RoomSettingsDocument = InferSchemaType<typeof roomSettingsSchema>;

export const Room: Model<RoomDocument> =
  (models.Room as Model<RoomDocument>) ?? model<RoomDocument>('Room', roomSchema);
