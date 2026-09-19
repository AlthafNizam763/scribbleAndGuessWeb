import { Types } from 'mongoose';
import { describe, expect, it } from 'vitest';

import { personalityFor, BOT_PERSONALITIES } from '@/games/botPersonalities';
import { discardPairs } from '@/games/kazhutha.adapter';
import { gameAdapters } from '@/games/adapters';
import { BOT_DIFFICULTY, BOT_PROFILES, type BotDifficultyWire } from '@/constants/autoTournament.constants';
import { GameRoom } from '@/models/GameRoom';
import type { BotPersonality, PlatformPlayerState } from '@/games/game.types';

/**
 * The Stupids that play the platform games.
 *
 * ## What actually needs proving
 *
 * Not that they play *well* — they are designed not to. Three things:
 *
 * 1. **Every suggestion is legal.** The engine validates anyway, so an illegal
 *    suggestion is a refused turn rather than a broken rule — but a bot whose
 *    turns are refused is a bot that never moves, and the match stalls.
 * 2. **They cannot see anything a player could not.** The suggestion is given
 *    the seat's own projection, and the assertions below feed it exactly that
 *    and nothing else, so a future adapter that started reading hidden state
 *    would fail here rather than in production.
 * 3. **They are distinguishable.** A roster of ten characters that all play
 *    identically is one character with ten names.
 */

type State = Record<string, unknown>;

/**
 * A bot that never blunders and notices everything, so the *reasoning* is what
 * is under test rather than the dice sitting on top of it.
 */
const SHARP: BotPersonality = {
  botId: 'test', blunderChance: 0, boldness: 0.5, thinkMs: 0,
  read: 1, difficulty: BOT_DIFFICULTY.hard,
};

/** Always blunders, for the "still legal when random" assertions. */
const CHAOS: BotPersonality = {
  botId: 'test', blunderChance: 1, boldness: 0.5, thinkMs: 0,
  read: 0.5, difficulty: BOT_DIFFICULTY.easy,
};

/** Never notices anything, for the assertions about what `read` actually buys. */
const OBLIVIOUS: BotPersonality = { ...SHARP, read: 0, difficulty: BOT_DIFFICULTY.easy };

function seat(playerId: string): PlatformPlayerState {
  return {
    playerId, userId: playerId, username: playerId, avatarId: 0, avatarColorIndex: 0,
    isBot: false, botDifficulty: null, isReady: true, connected: true, joinedAtMs: 0,
  };
}

describe('the roster and its personalities', () => {
  it('gives every Stupid on the roster a personality', () => {
    // A bot seated from a roster row with no entry would fall back to a
    // middling default and play like nobody in particular.
    for (const profile of BOT_PROFILES) {
      expect(BOT_PERSONALITIES[profile.botId], profile.displayName).toBeDefined();
    }
  });

  it('falls back rather than throwing for an unknown bot', () => {
    const fallback = personalityFor('a-bot-that-does-not-exist');

    // Stalling the match it is sitting in would be worse than playing average.
    expect(fallback.blunderChance).toBeGreaterThan(0);
    expect(fallback.thinkMs).toBeGreaterThan(0);
  });

  it('makes them actually different from one another', () => {
    const blunders = Object.values(BOT_PERSONALITIES).map((p) => p.blunderChance);
    const boldness = Object.values(BOT_PERSONALITIES).map((p) => p.boldness);

    // Ten characters that play identically are one character with ten names.
    expect(new Set(blunders).size).toBeGreaterThan(5);
    expect(Math.max(...boldness) - Math.min(...boldness)).toBeGreaterThan(0.5);
  });

  it('keeps every Stupid recognisably stupid', () => {
    for (const [botId, personality] of Object.entries(BOT_PERSONALITIES)) {
      // The product is bots that do funny things. A sharp one would be a bug.
      expect(personality.blunderChance, botId).toBeGreaterThan(0.1);
      expect(personality.blunderChance, botId).toBeLessThan(0.7);
    }
  });
});

describe('Kazhutha', () => {
  const adapter = gameAdapters.KAZHUTHA;

  /** A match in progress, viewed from `bot`'s seat. */
  function view(overrides: State = {}): State {
    return {
      gameId: 'KAZHUTHA', status: 'playing', currentPlayerId: 'bot',
      donkeyCard: 'QS',
      players: [
        { playerId: 'bot', cardCount: 4, out: false },
        { playerId: 'nearly-out', cardCount: 1, out: false },
        { playerId: 'middling', cardCount: 4, out: false },
        { playerId: 'loaded', cardCount: 9, out: false },
      ],
      hand: ['AS', 'AH', '7D', 'QS'],
      discards: [],
      ...overrides,
    };
  }

  it('deals a real deck with exactly one unpairable card', () => {
    const state = adapter.startMatch(adapter.createMatch([seat('a'), seat('b'), seat('c')]));
    const hands = Object.values((state as { hands: Record<string, string[]> }).hands);
    const all = hands.flat();

    // Real cards, not an abstract deck: this is a game people have played.
    expect(all.every((card) => /^[2-9TJQKA][SHDC]$/.test(card))).toBe(true);

    // Whatever survived the opening discard, the queen of spades is in
    // somebody's hand and there is no other queen left to pair her with.
    expect(all.filter((card) => card === 'QS')).toHaveLength(1);
    expect(all.filter((card) => card.startsWith('Q'))).toEqual(['QS']);
  });

  it('lays down pairs by rank, and never the donkey', () => {
    const hand = ['9S', '9H', 'QS', '4D', '4C', '4H', '4S'];
    const laid = discardPairs(hand);

    // Four of a kind is two pairs and goes down entirely.
    expect(laid.map((pair) => pair.rank).sort()).toEqual(['4', '4', '9']);
    expect(hand).toEqual(['QS']);
  });

  it('draws from another player, never itself', () => {
    const action = adapter.suggestBotAction!(view(), 'bot', SHARP);

    expect(action?.type).toBe('draw_card');
    expect(action?.targetPlayerId).not.toBe('bot');
  });

  it('never targets a player who is out or holding nothing', () => {
    const empty = view({
      players: [
        { playerId: 'bot', cardCount: 3, out: false },
        { playerId: 'gone', cardCount: 0, out: true },
        { playerId: 'in', cardCount: 2, out: false },
      ],
    });

    // The engine refuses these outright, so a bot that chose one would
    // simply never take its turn and the match would stall.
    for (let attempt = 0; attempt < 40; attempt++) {
      expect(adapter.suggestBotAction!(empty, 'bot', CHAOS)?.targetPlayerId).toBe('in');
    }
  });

  it('leaves a one-card hand alone, because emptying it is a gift', () => {
    // The strongest idea in the game: a player who runs out is out and
    // *safe*, and every seat that leaves shortens the odds that the donkey
    // finishes in your hand.
    for (let attempt = 0; attempt < 40; attempt++) {
      expect(adapter.suggestBotAction!(view(), 'bot', SHARP)?.targetPlayerId).not.toBe('nearly-out');
    }
  });

  it('hands out that exit when it is not paying attention', () => {
    // Two opponents, one of them a single card from being out and safe. A
    // timid character takes the quieter of the two — so the *only* thing
    // standing between it and handing over that exit is whether it noticed
    // the hand was down to one. That is the whole of what `read` buys here,
    // and it is why Easy is genuinely easier rather than merely slower.
    const table = view({
      players: [
        { playerId: 'bot', cardCount: 4, out: false },
        { playerId: 'loaded', cardCount: 9, out: false },
        { playerId: 'nearly-out', cardCount: 1, out: false },
      ],
    });
    const timid = { boldness: 0.1 };

    expect(adapter.suggestBotAction!(table, 'bot', { ...SHARP, ...timid })?.targetPlayerId)
      .toBe('loaded');
    expect(adapter.suggestBotAction!(table, 'bot', { ...OBLIVIOUS, ...timid })?.targetPlayerId)
      .toBe('nearly-out');
  });

  it('raids the biggest hand when bold, for the better pair odds', () => {
    const action = adapter.suggestBotAction!(view(), 'bot', { ...SHARP, boldness: 0.9 });
    expect(action?.targetPlayerId).toBe('loaded');
  });

  it('takes the quiet middle of the table when timid', () => {
    const action = adapter.suggestBotAction!(view(), 'bot', { ...SHARP, boldness: 0.1 });
    expect(action?.targetPlayerId).not.toBe('loaded');
  });

  it('reaches for a position that is actually in the target hand', () => {
    const seats = view().players as { playerId: string; cardCount: number }[];
    for (let attempt = 0; attempt < 60; attempt++) {
      const action = adapter.suggestBotAction!(view(), 'bot', CHAOS)!;
      const target = seats.find((row) => row.playerId === action.targetPlayerId)!;
      expect(action.cardIndex).toBeGreaterThanOrEqual(0);
      expect(action.cardIndex).toBeLessThan(target.cardCount);
    }
  });

  it('does nothing when it is not its turn', () => {
    expect(
      adapter.suggestBotAction!(view({ currentPlayerId: 'somebody-else' }), 'bot', SHARP),
    ).toBeNull();
  });

  it('plays a whole match against itself without an illegal move', () => {
    const players = [seat('a'), seat('b'), seat('c'), seat('d')];
    let state = adapter.startMatch(adapter.createMatch(players));

    for (let turn = 0; turn < 3000 && state.status === 'playing'; turn++) {
      const onTurn = String(adapter.getPublicState(state).currentPlayerId);
      const action = adapter.suggestBotAction!(
        adapter.getPrivatePlayerState(state, onTurn), onTurn, personalityFor('doodler'),
      );
      if (!action) break;

      // The real validator. An illegal suggestion throws here.
      expect(() => adapter.validateAction(state, onTurn, action)).not.toThrow();
      state = adapter.handlePlayerAction(state, onTurn, action);
    }

    expect(state.status).toBe('completed');

    // Somebody is holding her, and she is the only card they have left.
    const result = adapter.getResult(state)!;
    expect(result.heldCards).toEqual(['QS']);
    expect(result.winnerIds).toHaveLength(players.length - 1);
  });
});
describe('Ludo', () => {
  const adapter = gameAdapters.LUDO;

  function view(overrides: State = {}): State {
    return {
      gameId: 'LUDO', status: 'playing', currentPlayerId: 'bot', dice: null,
      order: ['bot', 'rival'],
      positions: { bot: [-1, -1, -1, -1], rival: [-1, -1, -1, -1] },
      ...overrides,
    };
  }

  it('rolls when there is no dice on the table', () => {
    expect(adapter.suggestBotAction!(view(), 'bot', SHARP)?.type).toBe('roll');
  });

  it('only ever moves a token the roll can legally move', () => {
    // A three: the token on 10 can move, the ones in the yard cannot.
    const state = view({ dice: 3, positions: { bot: [-1, 10, -1, 56], rival: [-1, -1, -1, -1] } });

    for (let i = 0; i < 40; i++) {
      // Even at a blunder rate of one, the random pick is from the *legal*
      // moves — which is the difference between silly and broken.
      const action = adapter.suggestBotAction!(state, 'bot', CHAOS);
      expect(action?.type).toBe('move');
      expect(action?.tokenIndex).toBe(1);
    }
  });

  it('brings a token out on a six', () => {
    const action = adapter.suggestBotAction!(
      view({ dice: 6, positions: { bot: [-1, 20, -1, -1], rival: [] } }), 'bot', SHARP,
    );

    // Leaving the yard is nearly always right, and a six is the only roll
    // that can do it.
    expect(action?.tokenIndex).toBe(0);
  });

  it('takes the exact-home move over board position', () => {
    const action = adapter.suggestBotAction!(
      view({ dice: 2, positions: { bot: [54, 10, -1, -1], rival: [] } }), 'bot', SHARP,
    );

    expect(action?.tokenIndex).toBe(0);
  });

  it('a bold Stupid takes a capture a timid one declines', () => {
    // A capture is decided on the shared board cell, not on the raw position:
    // each player counts from their own start square. `bot` starts at cell 0,
    // so its token 0 moving 1 -> 5 lands on cell 5; `rival` starts at cell 13,
    // so its token on 44 is also on cell 5 — (13 + 44) % 52. Token 1 moving
    // 30 -> 34 is the quiet alternative, and 34 is a safe square.
    const board = view({
      dice: 4,
      order: ['bot', 'rival'],
      positions: { bot: [1, 30, 56, 56], rival: [44, -1, -1, -1] },
    });

    const bold = adapter.suggestBotAction!(board, 'bot', { ...SHARP, boldness: 1 });
    const timid = adapter.suggestBotAction!(board, 'bot', { ...SHARP, boldness: 0 });

    expect(bold?.tokenIndex).toBe(0);
    expect(timid?.tokenIndex).not.toBe(0);
  });

  it('does nothing when it is not its turn', () => {
    expect(
      adapter.suggestBotAction!(view({ currentPlayerId: 'rival' }), 'bot', SHARP),
    ).toBeNull();
  });

  it('plays a whole match against itself without an illegal move', () => {
    // The strongest statement available without a database: two Stupids play
    // to completion, and every action passes the real validator. A stall or an
    // illegal move shows up here as a hang or a throw.
    const players = [seat('a'), seat('b')];
    let state = adapter.startMatch(adapter.createMatch(players));

    for (let turn = 0; turn < 4000 && state.status === 'playing'; turn++) {
      const seen = adapter.getPrivatePlayerState(state, 'a');
      const onTurn = String(seen.currentPlayerId);
      const action = adapter.suggestBotAction!(
        adapter.getPrivatePlayerState(state, onTurn), onTurn, personalityFor('doodler'),
      );
      if (!action) break;

      expect(() => adapter.validateAction(state, onTurn, action)).not.toThrow();
      state = adapter.handlePlayerAction(state, onTurn, action);
    }

    // Ludo with two players and random dice finishes well inside the cap.
    expect(state.status).toBe('completed');
  });
});

/**
 * The seat a Stupid is written into, as Mongo will actually accept it.
 *
 * `addStupids` copies `BotIdentity.difficulty` straight onto a `GameRoom`
 * player and saves. Nothing above this line touches that schema, which is how
 * a roster handing out the wire value `NORMAL` ran for as long as it did
 * against a room schema that only allowed `normal` — every seat validated
 * fine in the unit tests and every POST 500'd. `validateSync` needs no
 * connection, so the schema is checked here rather than in an integration run.
 */
describe('a seated Stupid against the room schema', () => {
  function roomWith(botDifficulty: BotDifficultyWire | null) {
    return new GameRoom({
      roomCode: 'ABCDEF',
      gameId: 'KAZHUTHA',
      ownerId: new Types.ObjectId(),
      maxPlayers: 4,
      players: [{
        playerId: 'bot-0', userId: null, username: 'Smug Dave',
        isBot: true, botId: 'smugcat', botDifficulty, isReady: true, joinedAtMs: 0,
      }],
    });
  }

  it.each(Object.values(BOT_DIFFICULTY))('accepts the wire difficulty %s', (difficulty) => {
    expect(roomWith(difficulty).validateSync()).toBeUndefined();
  });

  it('accepts a human seat, which carries no difficulty', () => {
    expect(roomWith(null).validateSync()).toBeUndefined();
  });

  it('still refuses a difficulty that is not on the roster', () => {
    // The enum is worth having only if it rejects something.
    const invalid = roomWith('MEDIUM' as BotDifficultyWire).validateSync();

    expect(invalid?.errors['players.0.botDifficulty']).toBeDefined();
  });
});
