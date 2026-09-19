import { randomInt } from 'node:crypto';

/**
 * A real deck of playing cards, shared by Kazhutha and Bluff Bar.
 *
 * ## Why this is not per-game
 *
 * Both games previously invented their own abstract deck — `sun-1`, `jade-7` —
 * which is fine for a rules engine and useless for a client that has to *draw*
 * a card. A player who has held a hand of cards before expects to see the ace
 * of spades, not a cobalt 7, and the brief for both games is that they be
 * immediately recognisable as card games. So the wire format is the card.
 *
 * ## The wire format
 *
 * `<rank><suit>`, rank first, both single characters except the ten: `AS` is
 * the ace of spades, `TD` the ten of diamonds, `KH` the king of hearts. A
 * joker is `X1` / `X2`. Fixed width by construction, so a client can index
 * into a sprite sheet without parsing, and sortable without a lookup table.
 *
 * Nothing here knows about a game. Dealing, pairing and scoring live in the
 * adapters, because those are rules and this is a deck.
 */

export const SUITS = ['S', 'H', 'D', 'C'] as const;
export type Suit = (typeof SUITS)[number];

/**
 * Low to high, which is the order a hand is fanned in.
 *
 * `T` rather than `10` keeps every card id two characters wide. That is worth
 * one moment of surprise here to avoid a parser everywhere else.
 */
export const RANKS = ['2', '3', '4', '5', '6', '7', '8', '9', 'T', 'J', 'Q', 'K', 'A'] as const;
export type Rank = (typeof RANKS)[number];

/** A card id as it travels on the wire. Not validated as a type; see [isCard]. */
export type CardId = string;

/** The two jokers, for the games that want a wild. */
export const JOKERS: readonly CardId[] = ['X1', 'X2'] as const;

export function cardOf(rank: Rank, suit: Suit): CardId {
  return `${rank}${suit}`;
}

export function isJoker(card: CardId): boolean {
  return card.charCodeAt(0) === 88 /* 'X' */;
}

/** The rank half of a card id, or `null` for a joker. */
export function rankOf(card: CardId): Rank | null {
  if (isJoker(card)) return null;
  const rank = card[0] as Rank;
  return RANKS.includes(rank) ? rank : null;
}

/** The suit half of a card id, or `null` for a joker. */
export function suitOf(card: CardId): Suit | null {
  if (isJoker(card)) return null;
  const suit = card[1] as Suit;
  return SUITS.includes(suit) ? suit : null;
}

export function isCard(value: unknown): value is CardId {
  if (typeof value !== 'string' || value.length !== 2) return false;
  if (JOKERS.includes(value)) return true;
  return rankOf(value) !== null && suitOf(value) !== null;
}

/** All fifty-two, in a fixed order. Shuffle before dealing. */
export function standardDeck(): CardId[] {
  const deck: CardId[] = [];
  for (const suit of SUITS) for (const rank of RANKS) deck.push(cardOf(rank, suit));
  return deck;
}

/**
 * A Fisher–Yates shuffle over `crypto.randomInt`.
 *
 * `Math.random` would be indistinguishable to a player and is still the wrong
 * call: this decides who ends up holding the donkey, and a deal a client could
 * predict from a seed is a deal somebody will eventually predict.
 */
export function shuffle<T>(items: readonly T[]): T[] {
  const copy = [...items];
  for (let index = copy.length - 1; index > 0; index--) {
    const target = randomInt(index + 1);
    const value = copy[index]!;
    copy[index] = copy[target]!;
    copy[target] = value;
  }
  return copy;
}

/** A uniformly random element. The caller guarantees a non-empty list. */
export function pick<T>(items: readonly T[]): T {
  return items[randomInt(items.length)]!;
}
