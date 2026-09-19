import { describe, expect, it } from 'vitest';

import { BOT_DIFFICULTY } from '@/constants/autoTournament.constants';
import { gameAdapters } from '@/games/adapters';
import { personalityFor } from '@/games/botPersonalities';
import { TRAY_SIZE, buildShoe } from '@/games/bluffBar.adapter';
import { isCard, rankOf, standardDeck, suitOf } from '@/games/cards';
import type { BotPersonality, PlatformPlayerState } from '@/games/game.types';
import { DONKEY_CARD, kazhuthaDeck } from '@/games/kazhutha.adapter';

/**
 * The two card games, as rulesets rather than as bots.
 *
 * `platformBots.test.ts` covers what the Stupids *choose*. This covers what
 * the engine will *allow*, which is a different question and the one that
 * decides whether a modified client can cheat: the bots go through the same
 * validator as everybody else, so a rule that is only enforced in the bot is
 * not enforced at all.
 */

type State = Record<string, unknown>;

function seat(id: string): PlatformPlayerState {
  return {
    playerId: id, userId: id, username: id, avatarId: 0, avatarColorIndex: 0,
    isBot: false, botDifficulty: null, isReady: true, connected: true, joinedAtMs: 0,
  };
}

const SHARP: BotPersonality = {
  botId: 'test', blunderChance: 0, boldness: 0.5, thinkMs: 0,
  read: 1, difficulty: BOT_DIFFICULTY.hard,
};

describe('the deck', () => {
  it('is fifty-two distinct, well-formed cards', () => {
    const deck = standardDeck();
    expect(deck).toHaveLength(52);
    expect(new Set(deck).size).toBe(52);
    expect(deck.every(isCard)).toBe(true);
  });

  it('reads a rank and a suit back out of every card', () => {
    // The wire format is `<rank><suit>` and a ten is `T`, so that every id is
    // two characters wide and no client needs a parser.
    expect(rankOf('TD')).toBe('T');
    expect(suitOf('TD')).toBe('D');
    expect(rankOf('X1')).toBeNull();
    expect(isCard('10D')).toBe(false);
  });
});

describe('Kazhutha, as a ruleset', () => {
  const adapter = gameAdapters.KAZHUTHA;

  it('removes three queens and leaves forty-nine cards', () => {
    const deck = kazhuthaDeck();
    expect(deck).toHaveLength(49);
    expect(deck.filter((card) => card.startsWith('Q'))).toEqual([DONKEY_CARD]);
  });

  function started(count: number): State {
    return adapter.startMatch(adapter.createMatch(
      Array.from({ length: count }, (_, index) => seat(`p${index}`)),
    ));
  }

  it('deals every card to somebody', () => {
    const state = started(4);
    const dealt = Object.values((state as { hands: Record<string, string[]> }).hands).flat();
    const laid = (state.discards as { cards: string[] }[]).flatMap((pair) => pair.cards);

    // Forty-nine, split between what is still in hands and what went face up
    // on the opening discard. A card that is in neither has been lost.
    expect(dealt.length + laid.length).toBe(49);
  });

  it('never shows one player another player’s hand', () => {
    const state = started(4);
    const seen = adapter.getPrivatePlayerState(state, 'p0');

    // The seat rows carry a count and nothing else. This is the projection the
    // bots are handed too, which is why a bot cannot find the donkey.
    for (const row of seen.players as State[]) {
      if (row.playerId === 'p0') continue;
      expect(Object.keys(row)).toEqual(['playerId', 'cardCount', 'out', 'finishPosition']);
    }
  });

  it('refuses a draw from yourself, from somebody out, or from thin air', () => {
    const state = started(3);
    const onTurn = String(adapter.getPublicState(state).currentPlayerId);

    expect(() => adapter.validateAction(state, onTurn, {
      type: 'draw_card', targetPlayerId: onTurn,
    })).toThrow();
    expect(() => adapter.validateAction(state, onTurn, {
      type: 'draw_card', targetPlayerId: 'nobody',
    })).toThrow();
    expect(() => adapter.validateAction(state, onTurn, { type: 'shuffle' })).toThrow();
  });

  it('refuses a card index that is not in the target’s hand', () => {
    const state = started(3);
    const onTurn = String(adapter.getPublicState(state).currentPlayerId);
    const target = (adapter.getPublicState(state).players as { playerId: string; cardCount: number }[])
      .find((row) => row.playerId !== onTurn)!;

    // A client reaching past the end of a fan is broken, not clever.
    expect(() => adapter.validateAction(state, onTurn, {
      type: 'draw_card', targetPlayerId: target.playerId, cardIndex: target.cardCount,
    })).toThrow();
    expect(() => adapter.validateAction(state, onTurn, {
      type: 'draw_card', targetPlayerId: target.playerId, cardIndex: -1,
    })).toThrow();
  });

  it('refuses a player who is not on turn', () => {
    const state = started(3);
    const onTurn = String(adapter.getPublicState(state).currentPlayerId);
    const other = ['p0', 'p1', 'p2'].find((id) => id !== onTurn)!;

    expect(() => adapter.validateAction(state, other, {
      type: 'draw_card', targetPlayerId: onTurn,
    })).toThrow();
  });

  it('places everybody who went out, and nobody who did not', () => {
    const adapterState = (() => {
      let state = started(3);
      for (let turn = 0; turn < 2000 && state.status === 'playing'; turn++) {
        const onTurn = String(adapter.getPublicState(state).currentPlayerId);
        const action = adapter.suggestBotAction!(
          adapter.getPrivatePlayerState(state, onTurn), onTurn, personalityFor('scribbler'),
        );
        if (!action) break;
        state = adapter.handlePlayerAction(state, onTurn, action);
      }
      return state;
    })();

    const result = adapter.getResult(adapterState)!;
    const finishOrder = result.finishOrder as string[];

    // Going out is winning, so the finishing order is the podium and the one
    // player not on it is the donkey.
    expect(finishOrder).toHaveLength(2);
    expect(finishOrder).not.toContain(result.loserId);

    const scores = adapter.calculateScore(adapterState);
    expect(scores[String(result.loserId)]).toBe(0);
    expect(scores[finishOrder[0]!]).toBeGreaterThan(scores[finishOrder[1]!]!);
  });
});

describe('Bluff Bar, as a ruleset', () => {
  const adapter = gameAdapters.BLUFF_BAR;

  function started(count: number): State {
    return adapter.startMatch(adapter.createMatch(
      Array.from({ length: count }, (_, index) => seat(`p${index}`)),
    ));
  }

  it('deals the whole shoe, so the counting argument works', () => {
    for (const players of [2, 3, 4, 5, 6]) {
      const { deck, composition } = buildShoe(players, 'A');
      const total = Object.values(composition).reduce((sum, count) => sum + count, 0);

      // Five each and nothing left over. A round with cards outside anybody's
      // hand is a round where "more has been claimed than exists" stops being
      // provable, and that argument is the game.
      expect(deck).toHaveLength(players * 5);
      expect(total).toBe(players * 5);
    }
  });

  it('tells everybody exactly what is in the shoe', () => {
    const state = started(4);
    const seen = adapter.getPublicState(state);

    // Public on purpose, and the most important number on the screen.
    expect(seen.deckComposition).toBeDefined();
    const total = Object.values(seen.deckComposition as Record<string, number>)
      .reduce((sum, count) => sum + count, 0);
    expect(total).toBe(20);
  });

  it('never shows anybody the cards on the pile', () => {
    const state = started(4);
    const onTurn = String(adapter.getPublicState(state).currentPlayerId);
    const hand = (adapter.getPrivatePlayerState(state, onTurn).hand as { id: string }[]);

    const next = adapter.handlePlayerAction(state, onTurn, {
      type: 'declare', cardIds: [hand[0]!.id],
    });
    const seen = adapter.getPrivatePlayerState(next, onTurn);

    // A count, never the faces. Paying to see them is what a call *is*.
    expect(seen.pileCount).toBe(1);
    expect(Object.keys(seen)).not.toContain('pile');
    expect(Object.keys(seen.lastClaim as State)).toEqual(['playerId', 'count', 'atMs']);
  });

  it('refuses a claim of nothing, of four, or of cards you do not hold', () => {
    const state = started(3);
    const onTurn = String(adapter.getPublicState(state).currentPlayerId);
    const hand = (adapter.getPrivatePlayerState(state, onTurn).hand as { id: string }[]);

    expect(() => adapter.validateAction(state, onTurn, { type: 'declare', cardIds: [] })).toThrow();
    expect(() => adapter.validateAction(state, onTurn, {
      type: 'declare', cardIds: hand.slice(0, 4).map((card) => card.id),
    })).toThrow();
    expect(() => adapter.validateAction(state, onTurn, {
      type: 'declare', cardIds: ['a-card-from-another-table'],
    })).toThrow();
    // The same card twice would be a hand of one played as a claim of two.
    expect(() => adapter.validateAction(state, onTurn, {
      type: 'declare', cardIds: [hand[0]!.id, hand[0]!.id],
    })).toThrow();
  });

  it('will not let you call your own claim, or call nothing at all', () => {
    const state = started(3);
    const onTurn = String(adapter.getPublicState(state).currentPlayerId);

    expect(() => adapter.validateAction(state, onTurn, { type: 'challenge' })).toThrow();

    const hand = (adapter.getPrivatePlayerState(state, onTurn).hand as { id: string }[]);
    const next = adapter.handlePlayerAction(state, onTurn, {
      type: 'declare', cardIds: [hand[0]!.id],
    });
    expect(() => adapter.validateAction(next, onTurn, { type: 'challenge' })).toThrow();
  });

  it('sends the liar to the bar, and the wrong accuser too', () => {
    const state = started(3);
    const tableRank = String(adapter.getPublicState(state).tableRank);
    const onTurn = String(adapter.getPublicState(state).currentPlayerId);

    const hand = (adapter.getPrivatePlayerState(state, onTurn).hand as { id: string; card: string }[]);
    const lie = hand.find((entry) => rankOf(entry.card) !== null && rankOf(entry.card) !== tableRank);
    if (!lie) return; // A hand of nothing but the called rank cannot lie.

    const claimed = adapter.handlePlayerAction(state, onTurn, {
      type: 'declare', cardIds: [lie.id],
    });
    const caller = String(adapter.getPublicState(claimed).currentPlayerId);
    const called = adapter.handlePlayerAction(claimed, caller, { type: 'challenge' });

    const challenge = adapter.getPublicState(called).lastChallenge as State;
    expect(challenge.honest).toBe(false);
    expect(challenge.loserId).toBe(onTurn);

    // A call is paid for with a shot, and what it bought is that everybody got
    // to see the cards.
    expect(challenge.revealed).toHaveLength(1);
  });

  it('never refills the tray, so the odds only get worse', () => {
    const state = started(2);
    const glasses = (id: string, from: State) =>
      (adapter.getPublicState(from).players as { playerId: string; glassesRemaining: number }[])
        .find((row) => row.playerId === id)!.glassesRemaining;

    expect(glasses('p0', state)).toBe(TRAY_SIZE);

    let current = state;
    let seen = TRAY_SIZE;
    for (let move = 0; move < 400 && current.status === 'playing'; move++) {
      const onTurn = String(adapter.getPublicState(current).currentPlayerId);
      const action = adapter.suggestBotAction!(
        adapter.getPrivatePlayerState(current, onTurn), onTurn, personalityFor('smugcat'),
      );
      if (!action) break;
      current = adapter.handlePlayerAction(current, onTurn, action);

      const now = glasses('p0', current);
      // It may stay the same for many turns; it must never go up.
      expect(now).toBeLessThanOrEqual(seen);
      seen = now;
    }
  });

  it('proves a lie by arithmetic when the claims outrun the shoe', () => {
    // Nine of the table rank exist and this bot holds five of them, so at most
    // four could honestly have been claimed. Six have been. Somebody is lying,
    // and the most recent claim is the one still worth punishing.
    const view: State = {
      gameId: 'BLUFF_BAR', status: 'playing', currentPlayerId: 'bot',
      tableRank: 'A',
      deckComposition: { A: 9, K: 9, Q: 10, JOKER: 2 },
      players: [
        { playerId: 'bot', cardCount: 5, alive: true, glassesRemaining: 6, outOfRound: false },
        { playerId: 'rival', cardCount: 2, alive: true, glassesRemaining: 6, outOfRound: false },
      ],
      claims: [{ playerId: 'rival', count: 3 }, { playerId: 'rival', count: 3 }],
      lastClaim: { playerId: 'rival', count: 3 },
      hand: [
        { id: 'c0', card: 'AS' }, { id: 'c1', card: 'AH' }, { id: 'c2', card: 'AD' },
        { id: 'c3', card: 'AC' }, { id: 'c4', card: 'X1' },
      ],
    };

    // A bot that is paying attention does the sum. One that is not does not,
    // which is the difference between Hard and Easy in this game.
    expect(adapter.suggestBotAction!(view, 'bot', SHARP)?.type).toBe('challenge');
    expect(adapter.suggestBotAction!(view, 'bot', { ...SHARP, read: 0, boldness: 0 })?.type)
      .toBe('declare');
  });

  it('bluffs when it has nothing honest left', () => {
    const view: State = {
      gameId: 'BLUFF_BAR', status: 'playing', currentPlayerId: 'bot',
      tableRank: 'A',
      deckComposition: { A: 6, K: 6, Q: 6, JOKER: 2 },
      players: [
        { playerId: 'bot', cardCount: 3, alive: true, glassesRemaining: 6, outOfRound: false },
        { playerId: 'rival', cardCount: 5, alive: true, glassesRemaining: 6, outOfRound: false },
      ],
      claims: [],
      lastClaim: null,
      hand: [{ id: 'c0', card: 'KS' }, { id: 'c1', card: 'KH' }, { id: 'c2', card: 'QD' }],
    };

    // There is no honest move, so it has to lie or it cannot play at all.
    const action = adapter.suggestBotAction!(view, 'bot', SHARP)!;
    expect(action.type).toBe('declare');
    expect((action.cardIds as string[]).length).toBeGreaterThanOrEqual(1);
  });

  it('stops calling on hunches when it is down to its last glass', () => {
    const shaky = (glassesRemaining: number): State => ({
      gameId: 'BLUFF_BAR', status: 'playing', currentPlayerId: 'bot',
      tableRank: 'A',
      deckComposition: { A: 6, K: 6, Q: 6, JOKER: 2 },
      players: [
        { playerId: 'bot', cardCount: 3, alive: true, glassesRemaining, outOfRound: false },
        { playerId: 'rival', cardCount: 2, alive: true, glassesRemaining: 6, outOfRound: false },
      ],
      claims: [{ playerId: 'rival', count: 2 }],
      lastClaim: { playerId: 'rival', count: 2 },
      hand: [{ id: 'c0', card: 'AS' }, { id: 'c1', card: 'KH' }, { id: 'c2', card: 'QD' }],
    });

    const bold: BotPersonality = { ...SHARP, boldness: 0.85 };

    // The same read of the same table, with a different amount to lose. This
    // is the risk half of the game, and the bot is looking at the same number
    // the player is.
    expect(adapter.suggestBotAction!(shaky(6), 'bot', bold)?.type).toBe('challenge');
    expect(adapter.suggestBotAction!(shaky(1), 'bot', bold)?.type).toBe('declare');
  });
});

describe('difficulty', () => {
  it('keeps the character and changes the competence', () => {
    const easy = personalityFor('smugcat', BOT_DIFFICULTY.easy);
    const normal = personalityFor('smugcat', BOT_DIFFICULTY.normal);
    const hard = personalityFor('smugcat', BOT_DIFFICULTY.hard);

    // Smug Dave on Hard is still the one who goes for the throat. He is just
    // right about it more often. A difficulty that replaced the personality
    // would make every hard bot the same bot.
    expect(easy.boldness).toBe(normal.boldness);
    expect(hard.boldness).toBe(normal.boldness);

    expect(easy.blunderChance).toBeGreaterThan(normal.blunderChance);
    expect(hard.blunderChance).toBeLessThan(normal.blunderChance);
    expect(hard.read).toBeGreaterThan(easy.read);
    expect(hard.thinkMs).toBeLessThan(easy.thinkMs);
  });

  it('leaves Normal as the roster wrote it', () => {
    // The identity row, so a character's numbers in the table are the numbers
    // it plays with.
    for (const botId of ['scribbler', 'doodler', 'lazycat']) {
      const base = personalityFor(botId);
      const normal = personalityFor(botId, BOT_DIFFICULTY.normal);
      expect(normal).toEqual(base);
    }
  });

  it('never produces a wall or a coin', () => {
    for (const botId of ['scribbler', 'doodler', 'lazycat', 'smugcat', 'unknown-character']) {
      for (const difficulty of Object.values(BOT_DIFFICULTY)) {
        const dials = personalityFor(botId, difficulty);

        // A bot that never errs is a wall and the product is bots you can
        // beat; one that always errs is noise.
        expect(dials.blunderChance, `${botId}/${difficulty}`).toBeGreaterThanOrEqual(0.05);
        expect(dials.blunderChance, `${botId}/${difficulty}`).toBeLessThanOrEqual(0.75);
        expect(dials.read).toBeGreaterThanOrEqual(0.1);
        expect(dials.read).toBeLessThanOrEqual(0.95);
        // Still long enough to look like it thought about it.
        expect(dials.thinkMs).toBeGreaterThanOrEqual(350);
      }
    }
  });

  it('treats an unseated difficulty as Normal', () => {
    // Older room documents carry no difficulty on a bot seat, and a match is
    // not the place to discover that.
    expect(personalityFor('smugcat', null)).toEqual(personalityFor('smugcat', BOT_DIFFICULTY.normal));
  });
});
