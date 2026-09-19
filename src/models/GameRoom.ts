import { Schema, Types, model, models, type HydratedDocument, type InferSchemaType, type Model } from 'mongoose';

import { BOT_DIFFICULTY } from '@/constants/autoTournament.constants';
import { GAME_IDS } from '@/games/game.types';

const playerSchema = new Schema({
  playerId: { type: String, required: true },
  userId: { type: Schema.Types.ObjectId, ref: 'User', default: null },
  username: { type: String, required: true },
  avatarId: { type: Number, default: 0 },
  avatarColorIndex: { type: Number, default: 0 },
  isBot: { type: Boolean, default: false },
  /**
   * Which Stupid this is — `smugcat`, `lazycat`, and so on. Null for a person.
   *
   * The roster key rather than the display name, because it is what selects a
   * personality: how often this seat blunders and how bold it plays is looked
   * up from here on every turn it takes. Renaming Smug Dave must not change
   * how Smug Dave plays.
   */
  botId: { type: String, default: null },
  botDifficulty: { type: String, enum: [...Object.values(BOT_DIFFICULTY), null], default: null },
  isReady: { type: Boolean, default: false },
  connected: { type: Boolean, default: true },
  joinedAtMs: { type: Number, required: true },
}, { _id: false });

/**
 * An open offer to play the same table again.
 *
 * Lives on the room rather than in a separate collection because it *is* a
 * property of the room: there can only ever be one open at a time, it dies
 * with the room, and every question anybody asks about it — who has said yes,
 * how long is left — is answered by reading the room they are already looking
 * at.
 *
 * `outcome` is kept after the offer closes rather than clearing the field. A
 * client that was backgrounded when the deadline passed needs to be told the
 * rematch failed, and a null rematch is indistinguishable from one that was
 * never asked for.
 */
const rematchSchema = new Schema({
  requestedBy: { type: String, required: true },
  requestedAtMs: { type: Number, required: true },
  deadlineAtMs: { type: Number, required: true },
  /** Player ids who said yes. Bots are added on creation; they always play. */
  accepted: { type: [String], default: [] },
  /** Player ids who said no. They are also removed from the room. */
  declined: { type: [String], default: [] },
  outcome: {
    type: String,
    enum: ['open', 'started', 'failed', 'cancelled'],
    default: 'open',
  },
}, { _id: false });

const gameRoomSchema = new Schema({
  roomCode: { type: String, required: true, uppercase: true, trim: true },
  gameId: { type: String, enum: GAME_IDS, required: true, index: true },
  ownerId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  status: { type: String, enum: ['waiting', 'playing', 'completed', 'closed'], default: 'waiting', index: true },
  isPrivate: { type: Boolean, default: false },
  maxPlayers: { type: Number, required: true },
  players: { type: [playerSchema], default: [] },
  matchId: { type: Schema.Types.ObjectId, ref: 'GameMatch', default: null },
  closedAt: { type: Date, default: null },
  rematch: { type: rematchSchema, default: null },
}, { timestamps: true, collection: 'gameRooms' });

gameRoomSchema.index({ roomCode: 1 }, { unique: true, partialFilterExpression: { closedAt: null } });
gameRoomSchema.index({ gameId: 1, status: 1, isPrivate: 1, createdAt: 1 });
gameRoomSchema.index({ 'players.userId': 1, status: 1 });

export type GameRoomDocument = InferSchemaType<typeof gameRoomSchema> & { _id: Types.ObjectId };

/**
 * A room still attached to the session that loaded it.
 *
 * `GameRoomDocument` is the *shape* of a room — what a serialiser needs, and
 * what a `.lean()` read hands back. It deliberately carries no document
 * methods. Any path that mutates a room in place and then calls `.save()`
 * must name this type instead, which is what `find`/`findOne` actually
 * return; annotating such a path as `GameRoomDocument` compiles everywhere
 * except the `.save()` itself, which is how the five errors here arose.
 */
export type GameRoomHydrated = HydratedDocument<GameRoomDocument>;
export const GameRoom: Model<GameRoomDocument> =
  (models.GameRoom as Model<GameRoomDocument>) ?? model('GameRoom', gameRoomSchema);
