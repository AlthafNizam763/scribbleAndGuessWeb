import { randomInt } from 'node:crypto';

import {
  BaseAdapter, blunders, notices, pick, record, strings, turn, type State,
} from '@/games/adapter.base';
import { JOKERS, SUITS, cardOf, isJoker, rankOf, shuffle, type CardId, type Rank } from '@/games/cards';
import type { BotPersonality, PlatformPlayerState } from '@/games/game.types';
import { errors } from '@/utils/errors';

/**
 * Bluff Bar — a back-room claim-and-challenge game for a dark table.
 *
 * ## The shape of a round
 *
 * The barkeep calls a rank. Everybody gets five cards. On your turn you put
 * one, two or three cards **face down** and say they are all that rank —
 * whether they are or not — or you call the last player a liar. A call turns
 * the cards over in front of everybody, and one of you is wrong. Whoever is
 * wrong goes to the bar.
 *
 * That is the whole game, and the tension is entirely in the arithmetic:
 * there are only so many of any rank in the shoe, everybody can count what has
 * been claimed, and once the claims exceed the supply somebody at that table
 * is lying. Working out *who* is the part that cannot be automated away, which
 * is why this is a good game and why the bot below is written the way it is.
 *
 * ## The house shot
 *
 * The penalty is ours, not borrowed. The barkeep lines up six glasses in front
 * of anybody who loses a call. You drink one. Five of them are exactly what
 * you ordered and the sixth is the one the house does not talk about, and
 * because the glasses are never refilled, the second shot is one in five, the
 * third one in four, and the sixth is not a gamble at all. It is a fair coin
 * that gets less fair every time you lose, which is the risk-and-reward the
 * game is built around: a call you are not sure about is cheap on your first
 * shot and unthinkable on your fifth.
 *
 * It also guarantees the match ends. Every player can lose at most six calls,
 * so a table of six cannot run past thirty-six shots however badly everyone
 * plays.
 *
 * ## The shoe, and why cards repeat
 *
 * Only three ranks are in play, and a table of six needs thirty cards, so the
 * shoe holds more than one of some faces — the same way a casino deals out of
 * six decks at once. Every card therefore carries an instance id alongside its
 * face, so a client can animate *this* ace rather than guessing which of two
 * identical aces moved.
 */

/** The three ranks a round can be called on. Nothing else is ever dealt. */
export const TABLE_RANKS: readonly Rank[] = ['A', 'K', 'Q'] as const;

/** Cards dealt to each player at the start of a round. */
const HAND_SIZE = 5;

/** Glasses the barkeep lines up. The last one is not a gamble. */
export const TRAY_SIZE = 6;

/** What a player may throw across the table. Flavour; never affects the rules. */
export const REACTIONS = ['stare', 'smirk', 'sweat', 'laugh', 'drink', 'shrug'] as const;
export type Reaction = (typeof REACTIONS)[number];

/** One card in play: a face, and an identity that survives two of the same face. */
interface DealtCard {
  id: string;
  card: CardId;
}

type Tables = Record<string, DealtCard[]>;

export class BluffBarGameAdapter extends BaseAdapter {
  readonly gameId = 'BLUFF_BAR' as const;

  override createMatch(players: PlatformPlayerState[]): State {
    const state = super.createMatch(players);
    const seats = players.map((player) => player.playerId);

    return {
      ...state,
      status: 'waiting',
      hands: {} as Tables,
      // Six glasses each, and they are never refilled for the rest of the
      // match. This is the only thing that carries between rounds, and it is
      // what makes a late call frightening.
      glasses: Object.fromEntries(seats.map((id) => [id, TRAY_SIZE])),
      shotsTaken: Object.fromEntries(seats.map((id) => [id, 0])),
      eliminated: [] as string[],
      roundNumber: 0,
      tableRank: null,
      deckComposition: {},
      pile: [] as DealtCard[],
      claims: [] as { playerId: string; count: number }[],
      lastClaim: null,
      lastChallenge: null,
      lastShot: null,
      lastReaction: null,
    };
  }

  override startMatch(state: State): State {
    state.status = 'playing';
    deal(state, null);
    return state;
  }

  validateAction(state: State, playerId: string, action: State): void {
    if (state.status !== 'playing') throw errors.gameNotStarted();
    if (strings(state.eliminated).includes(playerId)) {
      throw errors.invalidAction('You are out. Watch the rest of it from the bar.');
    }

    // A reaction is table talk. It is legal at any moment, from anybody still
    // at the table, and it touches no rule — so it is checked and returns
    // before the turn gate below.
    if (action.type === 'react') {
      if (!REACTIONS.includes(action.reaction as Reaction)) {
        throw errors.validation('That is not something you can do at this table.');
      }
      return;
    }

    if (turn(state) !== playerId) throw errors.invalidAction('It is not your turn.');

    if (action.type === 'challenge') {
      const claim = record(state.lastClaim);
      if (typeof claim.playerId !== 'string') throw errors.invalidAction('Nobody has claimed anything yet.');
      if (claim.playerId === playerId) throw errors.invalidAction('You cannot call your own bluff.');
      return;
    }

    if (action.type !== 'declare') throw errors.validation('Unsupported Bluff Bar action.');

    const ids = strings(action.cardIds);
    const hand = asHands(state)[playerId] ?? [];
    const held = new Set(hand.map((entry) => entry.id));

    if (ids.length < 1 || ids.length > 3) throw errors.invalidAction('Put down one, two or three cards.');
    if (new Set(ids).size !== ids.length) throw errors.invalidAction('That is the same card twice.');
    if (!ids.every((id) => held.has(id))) throw errors.invalidAction('Those are not your cards.');
  }

  handlePlayerAction(state: State, playerId: string, action: State): State {
    this.validateAction(state, playerId, action);

    if (action.type === 'react') {
      state.lastReaction = { playerId, reaction: action.reaction, atMs: Date.now() };
      return state;
    }

    if (action.type === 'challenge') return resolveChallenge(state, playerId);

    const ids = new Set(strings(action.cardIds));
    const hands = asHands(state);
    const hand = hands[playerId] ?? [];

    const played = hand.filter((entry) => ids.has(entry.id));
    hands[playerId] = hand.filter((entry) => !ids.has(entry.id));

    state.pile = [...asPile(state), ...played];
    state.claims = [...asClaims(state), { playerId, count: played.length }];
    state.lastClaim = {
      playerId,
      count: played.length,
      // The cards themselves are held back until somebody pays to see them.
      // They live in `pile`, which is server state and is never projected.
      atMs: Date.now(),
    };
    if (typeof action.reaction === 'string' && REACTIONS.includes(action.reaction as Reaction)) {
      state.lastReaction = { playerId, reaction: action.reaction, atMs: Date.now() };
    }

    // A player who has just put their last card down is finished with this
    // round — but is still on the hook for the claim they made, which the next
    // player may call. That is the whole reason `lastClaim` outlives the hand.
    if (remainingHolders(state).length <= 1) {
      // Everybody but one has emptied out, and nobody called the last claim.
      // The round dies quietly and the shoe is reshuffled: no shot, no drama,
      // which is the right outcome for a round everybody played straight.
      state.lastChallenge = null;
      deal(state, playerId);
      return state;
    }

    passTurn(state, playerId);
    return state;
  }

  getPublicState(state: State): State {
    const hands = asHands(state);
    const glasses = record(state.glasses);
    const shots = record(state.shotsTaken);
    const eliminated = strings(state.eliminated);

    return {
      gameId: this.gameId,
      status: state.status,
      currentPlayerId: turn(state),

      /** The rank everybody at this table is claiming to hold. */
      tableRank: state.tableRank ?? null,
      roundNumber: state.roundNumber ?? 0,

      /**
       * Exactly how many of each face went into this round's shoe.
       *
       * Public on purpose, and the single most important number on the screen:
       * once the claims add up to more than the shoe can hold, somebody is
       * lying and the arithmetic says so. A game where you cannot count is a
       * game where calling is a coin toss.
       */
      deckComposition: record(state.deckComposition),

      players: strings(state.players).map((playerId) => ({
        playerId,
        cardCount: hands[playerId]?.length ?? 0,
        alive: !eliminated.includes(playerId),
        /** Glasses still on the tray. Six is untouched; one is a certainty. */
        glassesRemaining: Number(glasses[playerId] ?? TRAY_SIZE),
        shotsTaken: Number(shots[playerId] ?? 0),
        outOfRound: (hands[playerId]?.length ?? 0) === 0,
      })),

      pileCount: asPile(state).length,
      /** Every claim made this round, in order, so the table can count along. */
      claims: asClaims(state),
      lastClaim: state.lastClaim ?? null,

      /**
       * The last call, with the cards it turned over.
       *
       * Revealed deliberately: a call is paid for with a shot, and what it
       * bought is that everybody got to see those cards.
       */
      lastChallenge: state.lastChallenge ?? null,
      lastShot: state.lastShot ?? null,
      lastReaction: state.lastReaction ?? null,
      eliminated,
    };
  }

  getPrivatePlayerState(state: State, playerId: string): State {
    return {
      ...this.getPublicState(state),
      hand: [...(asHands(state)[playerId] ?? [])],
    };
  }

  /**
   * Decides whether to call the last player a liar, and what to put down.
   *
   * ## What it is allowed to know
   *
   * Its own five cards, the shoe's composition, and every claim made this
   * round — all of which are in the projection it is handed, and all of which
   * a person at the table has too. It does **not** see the pile, which is why
   * a call is a judgement here rather than a lookup.
   *
   * ## The call
   *
   * One piece of real arithmetic and two soft reads.
   *
   * The arithmetic: subtract the table rank it is holding from the shoe's
   * supply of that rank, add the jokers, and that is the most that could
   * honestly have been claimed this round. Once the claims pass it, somebody
   * has lied — and the most recent claim is the one it can still punish. A bot
   * that notices this is playing properly; one that does not is why Easy is
   * easy, because [notices] is what gates it.
   *
   * The soft reads: a claim of three is a stretch, and a player dumping their
   * last cards is a player with nothing left to lose. Both nudge the odds.
   *
   * [BotPersonality.boldness] then sets how much doubt is enough — a bold
   * character calls on a hunch, a timid one wants proof — and, separately, how
   * many cards it is willing to put down when it is the one lying.
   */
  override suggestBotAction(view: State, botId: string, personality: BotPersonality): State | null {
    if (view.status !== 'playing' || view.currentPlayerId !== botId) return null;

    const hand = handOf(view);
    if (hand.length === 0) return null;

    const tableRank = typeof view.tableRank === 'string' ? view.tableRank : null;
    if (tableRank === null) return null;

    const honest = hand.filter((entry) => playsAs(entry.card, tableRank as Rank));
    const liars = hand.filter((entry) => !playsAs(entry.card, tableRank as Rank));

    const claim = record(view.lastClaim);
    const canCall = typeof claim.playerId === 'string' && claim.playerId !== botId;

    if (blunders(personality)) {
      // Daft, but never illegal: either a call out of nowhere or a random
      // fistful of cards.
      if (canCall && randomInt(3) === 0) return { type: 'challenge', reaction: pick(REACTIONS) };
      const size = 1 + randomInt(Math.min(3, hand.length));
      return declare(shuffle(hand).slice(0, size), pick(REACTIONS));
    }

    if (canCall && this.shouldCall({ view, botId, hand, tableRank: tableRank as Rank, personality, claim })) {
      return { type: 'challenge', reaction: personality.boldness >= 0.5 ? 'smirk' : 'stare' };
    }

    // Nothing honest left: it has to lie, and the only question is how much.
    if (honest.length === 0) {
      // A big lie clears more junk but is far more likely to be called. Bold
      // characters overreach; timid ones dribble out one card at a time.
      const appetite = personality.boldness >= 0.75 ? 3 : personality.boldness >= 0.35 ? 2 : 1;
      const size = Math.max(1, Math.min(appetite, liars.length));
      return declare(shuffle(liars).slice(0, size), size >= 3 ? 'smirk' : 'sweat');
    }

    // It can play straight. A bold character still slips a bad card in
    // alongside a good one — which is the best lie in the game, because the
    // count is right and only one card is wrong.
    const salted = personality.boldness >= 0.6
      && liars.length > 0
      && honest.length >= 1
      && randomInt(100) < Math.round(personality.boldness * 45);

    if (salted) {
      return declare([honest[0]!, pick(liars)], 'shrug');
    }

    const size = Math.max(1, Math.min(honest.length, personality.boldness >= 0.7 ? 3 : 2));
    return declare(honest.slice(0, size), 'shrug');
  }

  /** The call decision, split out because it is the interesting half. */
  private shouldCall(input: {
    view: State;
    botId: string;
    hand: DealtCard[];
    tableRank: Rank;
    personality: BotPersonality;
    claim: State;
  }): boolean {
    const { view, botId, hand, tableRank, personality, claim } = input;

    const composition = record(view.deckComposition);
    const supply = Number(composition[tableRank] ?? 0) + Number(composition.JOKER ?? 0);
    const mine = hand.filter((entry) => playsAs(entry.card, tableRank)).length;

    // The most that could honestly have been claimed by everybody else.
    const honestCeiling = Math.max(0, supply - mine);
    const claimedSoFar = asClaims(view).reduce((total, row) => total + row.count, 0);

    // Proof, not suspicion: more has been claimed than the shoe can hold.
    if (claimedSoFar > honestCeiling && notices(personality)) return true;

    const claimCount = Number(claim.count ?? 1);

    // A base rate that already assumes a fair amount of lying, because this is
    // a game about lying.
    let suspicion = 0.3;

    if (notices(personality)) {
      // How close the table is to the ceiling, which is the honest signal.
      if (honestCeiling > 0) suspicion += 0.45 * Math.min(1, claimedSoFar / honestCeiling);
      // Three at once is a stretch at any point in a round.
      suspicion += (claimCount - 1) * 0.12;
      // Somebody emptying their hand is somebody who ran out of real cards.
      const claimant = seatRows(view.players).find((seat) => seat.playerId === claim.playerId);
      if (claimant && claimant.cardCount === 0) suspicion += 0.15;
    }

    // What it costs to be wrong. A bot on its last glass stops calling on
    // hunches, exactly as a person would — this is the risk half of the game,
    // and it is the same number the player is looking at.
    // By seat id, not by character: `personality.botId` names which Stupid
    // this is, and several seats at one table can be the same character.
    const own = seatRows(view.players).find((seat) => seat.playerId === botId);
    const glasses = own ? own.glassesRemaining : TRAY_SIZE;
    const nerve = glasses <= 2 ? 0.22 : glasses <= 3 ? 0.1 : 0;

    // Bold characters call on less. Timid ones want the arithmetic.
    const threshold = 0.75 - personality.boldness * 0.35 + nerve;
    return suspicion >= threshold;
  }
}

function declare(cards: readonly DealtCard[], reaction: Reaction): State {
  return { type: 'declare', cardIds: cards.map((entry) => entry.id), reaction };
}

/** A joker is whatever the table is calling. That is what makes it worth holding. */
function playsAs(card: CardId, tableRank: Rank): boolean {
  return isJoker(card) || rankOf(card) === tableRank;
}

function asHands(state: State): Tables {
  return (state.hands ??= {}) as Tables;
}

function asPile(state: State): DealtCard[] {
  return Array.isArray(state.pile) ? state.pile as DealtCard[] : [];
}

function asClaims(state: State): { playerId: string; count: number }[] {
  if (!Array.isArray(state.claims)) return [];
  return state.claims.flatMap((row) => {
    const claim = record(row);
    return typeof claim.playerId === 'string'
      ? [{ playerId: claim.playerId, count: Number(claim.count) || 0 }]
      : [];
  });
}

function handOf(view: State): DealtCard[] {
  if (!Array.isArray(view.hand)) return [];
  return view.hand.flatMap((row) => {
    const entry = record(row);
    return typeof entry.id === 'string' && typeof entry.card === 'string'
      ? [{ id: entry.id, card: entry.card }]
      : [];
  });
}

function seatRows(value: unknown): {
  playerId: string; cardCount: number; alive: boolean; glassesRemaining: number;
}[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((row) => {
    const seat = record(row);
    return typeof seat.playerId === 'string'
      ? [{
          playerId: seat.playerId,
          cardCount: Number(seat.cardCount) || 0,
          alive: seat.alive !== false,
          glassesRemaining: Number(seat.glassesRemaining ?? TRAY_SIZE),
        }]
      : [];
  });
}

/** Players still alive and still holding cards this round. */
function remainingHolders(state: State): string[] {
  const hands = asHands(state);
  const eliminated = new Set(strings(state.eliminated));
  return strings(state.players)
    .filter((id) => !eliminated.has(id) && (hands[id]?.length ?? 0) > 0);
}

/**
 * Turns the last claim face up and sends somebody to the bar.
 *
 * The claim is honest when **every** card under it is the table rank or a
 * joker. One wrong card out of three makes the whole claim a lie, which is why
 * salting a good claim with one bad card is a real tactic and a real risk.
 */
function resolveChallenge(state: State, challengerId: string): State {
  const claim = record(state.lastClaim);
  const claimantId = String(claim.playerId);
  const count = Number(claim.count) || 0;
  const tableRank = state.tableRank as Rank;

  // The claim is the last `count` cards on the pile, which is where they went.
  const pile = asPile(state);
  const revealed = pile.slice(Math.max(0, pile.length - count));
  const honest = revealed.length > 0 && revealed.every((entry) => playsAs(entry.card, tableRank));

  const loserId = honest ? challengerId : claimantId;
  state.lastChallenge = {
    challengerId,
    claimantId,
    honest,
    revealed: revealed.map((entry) => ({ id: entry.id, card: entry.card })),
    loserId,
    atMs: Date.now(),
  };

  pourShot(state, loserId);

  // The round is over either way — a call ends it. If the match is still
  // running, the shoe is reshuffled and the loser leads, because the table
  // wants to watch the player who just drank.
  if (state.status === 'playing') deal(state, loserId);
  return state;
}

/**
 * One glass off the tray.
 *
 * Eliminating with probability `1/glassesRemaining` and then removing a glass
 * is exactly a hidden bad glass among the ones still standing — the same
 * distribution, without a secret the server has to keep. The client draws the
 * tray from `glassesRemaining`, so the shrinking row on screen and the odds
 * being rolled here are the same object.
 */
function pourShot(state: State, playerId: string): void {
  const glasses = record(state.glasses);
  const shots = record(state.shotsTaken);
  const before = Math.max(1, Number(glasses[playerId] ?? TRAY_SIZE));

  const eliminated = randomInt(before) === 0;
  glasses[playerId] = Math.max(0, before - 1);
  shots[playerId] = Number(shots[playerId] ?? 0) + 1;
  state.glasses = glasses;
  state.shotsTaken = shots;

  state.lastShot = {
    playerId,
    glassesBefore: before,
    glassesRemaining: glasses[playerId],
    eliminated,
    atMs: Date.now(),
  };

  if (!eliminated) return;

  state.eliminated = [...strings(state.eliminated), playerId];
  state.order = strings(state.order).filter((id) => id !== playerId);
  resolve(state);
}

/**
 * Shuffles a fresh shoe and deals a new round.
 *
 * [leadId] is whoever should act first — the player who just took a shot, or
 * the last one holding cards. Dramatically the right choice, and mechanically
 * irrelevant, which is the best kind of decision to be able to make freely.
 */
function deal(state: State, leadId: string | null): void {
  if (state.status !== 'playing') return;

  const eliminated = new Set(strings(state.eliminated));
  const alive = strings(state.players).filter((id) => !eliminated.has(id));
  if (alive.length <= 1) { resolve(state); return; }

  const tableRank = pick(TABLE_RANKS);
  const { deck, composition } = buildShoe(alive.length, tableRank);
  const shuffled = shuffle(deck);

  const hands: Tables = Object.fromEntries(alive.map((id) => [id, [] as DealtCard[]]));
  shuffled.forEach((entry, index) => {
    hands[alive[index % alive.length]!]!.push(entry);
  });

  state.hands = hands;
  state.tableRank = tableRank;
  state.deckComposition = composition;
  state.pile = [];
  state.claims = [];
  state.lastClaim = null;
  state.roundNumber = Number(state.roundNumber ?? 0) + 1;
  state.order = alive;

  const lead = leadId !== null && alive.includes(leadId) ? leadId : alive[0]!;
  state.turnIndex = alive.indexOf(lead);
}

/**
 * A shoe of exactly `5 × players` cards: two jokers and the rest split across
 * the three ranks as evenly as they divide.
 *
 * Dealt out completely on purpose. A round with cards left over is a round
 * where the counting argument stops working, and the counting argument is the
 * game.
 */
export function buildShoe(playerCount: number, _tableRank: Rank): {
  deck: DealtCard[];
  composition: Record<string, number>;
} {
  const total = playerCount * HAND_SIZE;
  const faces = Math.max(TABLE_RANKS.length, total - JOKERS.length);

  const counts: Record<string, number> = {};
  for (let index = 0; index < faces; index++) {
    const rank = TABLE_RANKS[index % TABLE_RANKS.length]!;
    counts[rank] = (counts[rank] ?? 0) + 1;
  }
  counts.JOKER = total - faces;

  const deck: DealtCard[] = [];
  let serial = 0;
  for (const rank of TABLE_RANKS) {
    for (let copy = 0; copy < (counts[rank] ?? 0); copy++) {
      // Suits cycle, so a shoe that needs more than four of a rank repeats a
      // face — which is what a multi-deck shoe does, and why every card here
      // carries an id of its own.
      deck.push({ id: `b${serial++}`, card: cardOf(rank, SUITS[copy % SUITS.length]!) });
    }
  }
  for (let copy = 0; copy < (counts.JOKER ?? 0); copy++) {
    deck.push({ id: `b${serial++}`, card: JOKERS[copy % JOKERS.length]! });
  }

  return { deck, composition: counts };
}

/** Hands the turn to the next player who is alive and still holding cards. */
function passTurn(state: State, fromId: string): void {
  const order = strings(state.order);
  if (order.length === 0) return;

  const hands = asHands(state);
  const eliminated = new Set(strings(state.eliminated));
  const start = Math.max(0, order.indexOf(fromId));

  for (let step = 1; step <= order.length; step++) {
    const index = (start + step) % order.length;
    const candidate = order[index]!;
    if (!eliminated.has(candidate) && (hands[candidate]?.length ?? 0) > 0) {
      state.turnIndex = index;
      return;
    }
  }
}

/** Ends the match once one drinker is left standing. */
function resolve(state: State): void {
  const eliminated = new Set(strings(state.eliminated));
  const alive = strings(state.players).filter((id) => !eliminated.has(id));
  if (alive.length > 1) return;

  const glasses = record(state.glasses);
  state.status = 'completed';
  state.result = {
    winnerId: alive[0] ?? null,
    winnerIds: alive,
    eliminated: strings(state.eliminated),
    /** The order they went out in, worst first, for the end-of-night card. */
    reason: 'last_at_the_bar',
    rounds: Number(state.roundNumber ?? 0),
  };

  // Surviving glasses are the scoreboard: the winner who never lost a call is
  // worth more than the one who limped home on their last glass.
  state.scores = Object.fromEntries(
    strings(state.players).map((playerId) => [
      playerId,
      eliminated.has(playerId) ? 0 : Number(glasses[playerId] ?? 0) + 1,
    ]),
  );
}
