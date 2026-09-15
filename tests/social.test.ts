import { describe, expect, it } from 'vitest';

import { PAGE_LIMITS, RELATION } from '@/constants/social.constants';
import { pairOf, isDuplicateKeyError } from '@/repositories/friend.repository';
import { localityKeyOf, normalizePlace } from '@/repositories/user.repository';
import { paging } from '@/services/leaderboard.service';
import { listPaging } from '@/services/friend.service';
import {
  toLeaderboardRow,
  toLocality,
  toUserStats,
  toUserSummary,
  type RankableUser,
} from '@/services/profile.serialize';
import {
  localitySchema,
  objectIdSchema,
  pageQuerySchema,
  searchQuerySchema,
  sendFriendRequestSchema,
} from '@/validators/social.validator';

/**
 * The friends, blocks and leaderboard rules that need no database.
 *
 * Pair normalisation, ranking arithmetic, locality keys, serialisation and
 * paging bounds are all pure, and they are where the subtle mistakes live: an
 * ordering that is not total, a locality key that puts two spellings of one
 * town in different places, a win rate that disagrees between two screens.
 *
 * The parts that genuinely need Mongo — the partial unique index that refuses
 * a mirrored pending request, the `status: pending` guard that makes a double
 * Accept a no-op — are exercised by the manual steps in the README rather than
 * simulated here, because simulating an index is a test of the simulation.
 */

function user(overrides: Partial<RankableUser> & { _id: string }): RankableUser {
  return {
    username: 'Ada',
    avatarId: 1,
    avatarColorIndex: 2,
    totalScore: 0,
    gamesPlayed: 0,
    gamesWon: 0,
    bestRoundScore: 0,
    ...overrides,
  };
}

describe('pair normalisation', () => {
  it('produces the same key whichever way round the ids arrive', () => {
    // This is the whole reason a mirrored request can be refused by an index.
    const forward = pairOf('aaaaaaaaaaaaaaaaaaaaaaa1', 'bbbbbbbbbbbbbbbbbbbbbbb2');
    const backward = pairOf('bbbbbbbbbbbbbbbbbbbbbbb2', 'aaaaaaaaaaaaaaaaaaaaaaa1');

    expect(forward.key).toBe(backward.key);
    expect(forward.low).toBe(backward.low);
    expect(forward.high).toBe(backward.high);
  });

  it('puts the lexicographically smaller id first', () => {
    const pair = pairOf('ffffffffffffffffffffffff', '000000000000000000000000');
    expect(pair.low).toBe('000000000000000000000000');
    expect(pair.high).toBe('ffffffffffffffffffffffff');
  });

  it('separates the two halves so no two pairs can collide', () => {
    // Without the separator, ("ab","cd") and ("abc","d") would share a key.
    expect(pairOf('ab', 'cd').key).not.toBe(pairOf('abc', 'd').key);
  });

  it('recognises the duplicate-key error the index throws', () => {
    expect(isDuplicateKeyError({ code: 11000 })).toBe(true);
    expect(isDuplicateKeyError(new Error('boom'))).toBe(false);
    expect(isDuplicateKeyError(null)).toBe(false);
  });
});

describe('locality keys', () => {
  it('folds case, spacing and punctuation into one town', () => {
    const a = localityKeyOf({ city: 'Kochi', region: 'Kerala', country: 'IN' });
    const b = localityKeyOf({ city: '  kochi ', region: 'kerala', country: 'in' });
    expect(a).toBe(b);
  });

  it('keeps same-named towns in different countries apart', () => {
    const india = localityKeyOf({ city: 'Springfield', region: null, country: 'IN' });
    const states = localityKeyOf({ city: 'Springfield', region: null, country: 'US' });
    expect(india).not.toBe(states);
  });

  it('keeps same-named towns in different regions apart', () => {
    const one = localityKeyOf({ city: 'Springfield', region: 'Illinois', country: 'US' });
    const two = localityKeyOf({ city: 'Springfield', region: 'Missouri', country: 'US' });
    expect(one).not.toBe(two);
  });

  it('refuses to group by country alone', () => {
    // A country-wide "locality" board is just a worse world board, so a
    // profile with only a country has no locality at all.
    expect(localityKeyOf({ city: null, region: null, country: 'IN' })).toBeNull();
  });

  it('is null when nothing is set, which is the empty-state signal', () => {
    expect(localityKeyOf({ city: null, region: null, country: null })).toBeNull();
    expect(localityKeyOf({ city: '   ', region: null, country: null })).toBeNull();
  });

  it('keeps non-latin place names distinguishable', () => {
    expect(normalizePlace('കൊച്ചി')).not.toBe('');
    expect(normalizePlace('കൊച്ചി')).not.toBe(normalizePlace('തൃശൂർ'));
  });
});

describe('stats serialisation', () => {
  it('reports a zero win rate for a player who has never finished a game', () => {
    expect(toUserStats(user({ _id: 'a' })).winRate).toBe(0);
  });

  it('computes the win rate to one decimal place', () => {
    const stats = toUserStats(user({ _id: 'a', gamesPlayed: 3, gamesWon: 1 }));
    expect(stats.winRate).toBe(33.3);
  });

  it('reports a perfect record as 100', () => {
    expect(toUserStats(user({ _id: 'a', gamesPlayed: 4, gamesWon: 4 })).winRate).toBe(100);
  });

  it('never exposes anything but the public card', () => {
    const summary = toUserSummary(user({ _id: 'a' }));
    // The shape is the security boundary: there is nowhere to put an email.
    expect(Object.keys(summary).sort()).toEqual([
      'avatarColorIndex',
      'avatarId',
      'id',
      'username',
    ]);
  });
});

describe('locality serialisation', () => {
  it('is null when the player has said nothing', () => {
    expect(toLocality(user({ _id: 'a' }))).toBeNull();
  });

  it('builds one display line from whatever is set', () => {
    const locality = toLocality(user({ _id: 'a', city: 'Kochi', region: null, country: 'IN' }));
    expect(locality?.label).toBe('Kochi, IN');
  });

  it('treats a blank field as absent', () => {
    const locality = toLocality(user({ _id: 'a', city: 'Kochi', region: '  ', country: null }));
    expect(locality?.region).toBeNull();
    expect(locality?.label).toBe('Kochi');
  });
});

describe('leaderboard rows', () => {
  it('flags the caller so the client need not compare ids', () => {
    const row = toLeaderboardRow(user({ _id: 'me' }), { rank: 4, selfId: 'me' });
    expect(row.isSelf).toBe(true);
    expect(row.rank).toBe(4);
  });

  it('flags nobody when the reader is anonymous', () => {
    expect(toLeaderboardRow(user({ _id: 'me' }), { rank: 1, selfId: null }).isSelf).toBe(false);
  });

  it('reports no rank movement, because no history is recorded', () => {
    // The field is on the wire so a future snapshot job is a server-only
    // change. Until then it must not be a number the server invented.
    expect(toLeaderboardRow(user({ _id: 'a' }), { rank: 1, selfId: null }).rankChange).toBeNull();
  });

  it('omits locality unless the board is the locality board', () => {
    const withCity = user({ _id: 'a', city: 'Kochi', country: 'IN' });

    expect(toLeaderboardRow(withCity, { rank: 1, selfId: null }).locality).toBeNull();
    expect(
      toLeaderboardRow(withCity, { rank: 1, selfId: null, includeLocality: true })?.locality?.city,
    ).toBe('Kochi');
  });
});

describe('paging bounds', () => {
  it('clamps an over-large limit rather than refusing it', () => {
    // An optimistic client default is not an attack.
    expect(paging({ page: 1, limit: 5_000 }).limit).toBe(PAGE_LIMITS.maxLimit);
  });

  it('floors the page and the limit at one', () => {
    const result = paging({ page: 0, limit: 0 });
    expect(result.page).toBe(1);
    expect(result.limit).toBe(1);
  });

  it('computes the skip from the clamped values', () => {
    expect(paging({ page: 3, limit: 25 }).skip).toBe(50);
  });

  it('refuses a page past the depth cap instead of clamping it', () => {
    // A skip is O(skip) in Mongo, and silently serving page 400 when page
    // 40000 was asked for would look like missing data.
    expect(() => paging({ page: PAGE_LIMITS.maxPage + 1, limit: 25 })).toThrow();
    expect(() => paging({ page: PAGE_LIMITS.maxPage, limit: 25 })).not.toThrow();
  });

  it('applies the same rules to the friend lists', () => {
    expect(listPaging({ limit: 5_000 }).limit).toBe(PAGE_LIMITS.maxLimit);
    expect(listPaging({}).limit).toBe(PAGE_LIMITS.defaultLimit);
    expect(() => listPaging({ page: PAGE_LIMITS.maxPage + 1 })).toThrow();
  });
});

describe('validators', () => {
  it('refuses an id that is not a Mongo id', () => {
    expect(() => objectIdSchema.parse('nope')).toThrow();
    expect(() => objectIdSchema.parse('')).toThrow();
    expect(objectIdSchema.parse('507f1f77bcf86cd799439011')).toBe('507f1f77bcf86cd799439011');
  });

  it('accepts either spelling of the receiver id', () => {
    const id = '507f1f77bcf86cd799439011';
    expect(sendFriendRequestSchema.parse({ receiverId: id }).receiverId).toBe(id);
    expect(sendFriendRequestSchema.parse({ userId: id }).receiverId).toBe(id);
  });

  it('has no field for a sender', () => {
    // The sender is the token. A body that names one changes nothing.
    const parsed = sendFriendRequestSchema.parse({
      receiverId: '507f1f77bcf86cd799439011',
      senderId: '507f1f77bcf86cd799439012',
    });
    expect(Object.keys(parsed)).toEqual(['receiverId']);
  });

  it('refuses a request with no recipient at all', () => {
    expect(() => sendFriendRequestSchema.parse({})).toThrow();
  });

  it('clamps paging query values instead of refusing them', () => {
    expect(pageQuerySchema.parse({ page: 'x', limit: '9999' })).toEqual({
      page: 1,
      limit: PAGE_LIMITS.maxLimit,
    });
  });

  it('refuses a search term that is too short to narrow anything', () => {
    expect(() => searchQuerySchema.parse({ q: 'a' })).toThrow();
    expect(searchQuerySchema.parse({ q: 'ad' }).q).toBe('ad');
  });

  it('caps search results however many were asked for', () => {
    expect(searchQuerySchema.parse({ q: 'ada', limit: '500' }).limit).toBe(25);
  });

  it('normalises an empty locality field to null', () => {
    const parsed = localitySchema.parse({ city: '  ', region: null, country: null });
    expect(parsed.city).toBeNull();
  });

  it('upper-cases a country code and refuses a country name', () => {
    expect(localitySchema.parse({ city: 'Kochi', country: 'in' }).country).toBe('IN');
    expect(() => localitySchema.parse({ city: 'Kochi', country: 'India' })).toThrow();
  });

  it('has no field for a street address', () => {
    // The schema is the refusal: an address has nowhere to land.
    const parsed = localitySchema.parse({
      city: 'Kochi',
      country: 'IN',
      street: '12 Somewhere Road',
      postcode: '682001',
      latitude: 9.93,
    });
    expect(Object.keys(parsed).sort()).toEqual(['city', 'country', 'region']);
  });
});

describe('relation vocabulary', () => {
  it('has a value for every profile button state the client draws', () => {
    expect(Object.values(RELATION)).toEqual(
      expect.arrayContaining([
        RELATION.self,
        RELATION.none,
        RELATION.requestSent,
        RELATION.requestReceived,
        RELATION.friends,
        RELATION.blocked,
      ]),
    );
  });
});
