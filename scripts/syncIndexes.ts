import { connectToDatabase, disconnectFromDatabase } from '@/config/database';
import { env } from '@/config/env';
import { Block } from '@/models/Block';
import { ChatMessage } from '@/models/ChatMessage';
import { FriendRequest } from '@/models/FriendRequest';
import { Friendship } from '@/models/Friendship';
import { Achievement } from '@/models/Achievement';
import { AutoTournament, TournamentRegistration } from '@/models/AutoTournament';
import { Game } from '@/models/Game';
import { Notification } from '@/models/Notification';
import { Report } from '@/models/Report';
import { Room } from '@/models/Room';
import { TournamentBotProfile, TournamentSchedulerLock } from '@/models/TournamentBotProfile';
import { TournamentMatch, TournamentRound } from '@/models/TournamentMatch';
import { RoomInvitation } from '@/models/RoomInvitation';
import { Round } from '@/models/Round';
import { User } from '@/models/User';
import { Word } from '@/models/Word';
import { XpEvent } from '@/models/XpEvent';
import { logger } from '@/utils/logger';

/**
 * Brings the database's indexes in line with the schemas.
 *
 * Mongoose creates missing indexes on its own, but it never *changes* one that
 * already exists: an index built from an older schema definition stays exactly
 * as it was built. That is a quiet trap — the code says one thing, the database
 * enforces another, and the mismatch only shows up as a confusing runtime
 * error. `syncIndexes()` drops the ones that no longer match and rebuilds them.
 *
 * Run it after any change to an `index()` call:
 *
 *   npm run sync-indexes
 *
 * There is also a development-only reset for wiping play data between test
 * runs, kept behind an explicit flag and refused outright in production:
 *
 *   npm run sync-indexes -- --purge-play-data
 */

/**
 * The slice of a Mongoose model this script actually uses.
 *
 * A heterogeneous array of models is typed as the *union* of their document
 * types, and TypeScript refuses to call a method whose overloads differ across
 * a union — every model's `deleteMany` has a different `FilterQuery`. Narrowing
 * to the two methods needed here sidesteps that without reaching for `any`,
 * and documents exactly how much of the model surface this script touches.
 */
interface SyncableModel {
  collection: { name: string };
  deleteMany(filter: Record<string, never>): { exec(): Promise<{ deletedCount: number }> };
  syncIndexes(): Promise<string[]>;
}

const asSyncable = (model: unknown): SyncableModel => model as SyncableModel;

const MODELS: SyncableModel[] = [
  User,
  Room,
  // The automatic tournament system. Its unique indexes are not an
  // optimisation — they are what enforces "never a fourth tournament", "one
  // registration per player" and "one match per bracket position", so a
  // deployment that skipped them would enforce none of the three.
  AutoTournament,
  TournamentRegistration,
  TournamentRound,
  TournamentMatch,
  TournamentBotProfile,
  TournamentSchedulerLock,
  Game,
  Round,
  Word,
  Notification,
  Achievement,
  XpEvent,
  ChatMessage,
  Report,
  FriendRequest,
  Friendship,
  Block,
  RoomInvitation,
].map(
  asSyncable,
);

/** Collections holding play data. `words` is seeded reference data, not play. */
const PLAY_DATA: SyncableModel[] = [
  User,
  Room,
  AutoTournament,
  TournamentRegistration,
  TournamentRound,
  TournamentMatch,
  TournamentSchedulerLock,
  Game,
  Round,
  ChatMessage,
  Notification,
  Achievement,
  XpEvent,
  Report,
  FriendRequest,
  Friendship,
  Block,
  RoomInvitation,
].map(
  asSyncable,
);

async function main(): Promise<void> {
  const purge = process.argv.includes('--purge-play-data');

  if (purge && env.isProduction) {
    throw new Error('--purge-play-data is refused in production.');
  }

  await connectToDatabase();

  if (purge) {
    for (const model of PLAY_DATA) {
      const { deletedCount } = await model.deleteMany({}).exec();
      logger.info('purged collection', { collection: model.collection.name, deletedCount });
    }
  }

  for (const model of MODELS) {
    // Returns the names of any indexes it had to drop, which is the
    // interesting part: a silent run means nothing had drifted.
    const dropped = await model.syncIndexes();
    logger.info('synced indexes', {
      collection: model.collection.name,
      dropped: dropped.length > 0 ? dropped : undefined,
    });
  }

  await disconnectFromDatabase();
}

main().catch((error: unknown) => {
  logger.exception('syncing indexes failed', error);
  process.exit(1);
});
