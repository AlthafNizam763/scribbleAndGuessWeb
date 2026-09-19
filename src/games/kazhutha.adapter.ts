import { randomInt } from 'node:crypto';

import {
  BaseAdapter, blunders, nextTurn, notices, pick, record, strings, turn,
  type Hands, type State,
} from '@/games/adapter.base';
import { cardOf, rankOf, shuffle, standardDeck, type CardId, type Rank } from '@/games/cards';
import type { BotPersonality, PlatformPlayerState } from '@/games/game.types';
import { errors } from '@/utils/errors';

/**
 * Kazhutha — the donkey — played the way it is played at a table.
 *
 * ## The deck, and why it is a real one
 *
 * Fifty-two cards with three queens taken out: forty-nine, which is
 * twenty-four pairs and the **queen of spades**, alone and unpairable. She is
 * the donkey. Everybody knows *which* card it is from the first deal — that is
 * not hidden information and never was, at a table or here — and nobody knows
 * who is holding her, which is the entire game.
 *
 * The previous engine dealt `sun-1` and `jade-7`. That is a perfectly good
 * abstract ruleset and a hopeless card game: somebody who has held cards
 * before expects to see the queen of spades looking back at them, and the
 * brief for this game is that it be recognisable on sight.
 *
 * ## The one house rule
 *
 * Strict Old Maid makes you draw from the player on your left, which means the
 * game contains no decisions at all — every turn plays itself. Kazhutha as
 * commonly played lets you raid *any* player still holding cards, and that is
 * what this implements. It is also what the previous engine accepted, so a
 * client that already spoke this protocol does not have to change.
 *
 * ## What a draw actually costs
 *
 * Worth writing down, because it drives the bot and it is not obvious. The
 * chance of pulling the donkey is the same whoever you pick: a hand of `n`
 * cards holds her with probability proportional to `n`, and you then take one
 * card out of those `n`. The two cancel exactly. Every target is as dangerous
 * as every other, so the choice is about two other things —
 *
 *   - a **big hand** pairs better, because more cards means a better chance
 *     that one of them matches something already in your hand; and
 *   - emptying somebody is a **gift to them**, because a player with no cards
 *     is out and safe, and every seat that leaves shortens the odds that the
 *     donkey finishes in your hand.
 *
 * Both are visible in the public projection, which is why the bot can reason
 * about them without being shown anything a person at the table cannot see.
 */

/** The card that cannot be paired, and everybody knows it. */
export const DONKEY_CARD: CardId = cardOf('Q', 'S');

/**
 * Forty-nine cards: the standard deck less the other three queens.
 *
 * Queens rather than any other rank because it is the traditional choice and
 * the legible one — a lone black queen reads as the donkey at a glance, where
 * a lone seven of clubs reads as a dealing error.
 */
export function kazhuthaDeck(): CardId[] {
  const removed = new Set<CardId>([cardOf('Q', 'H'), cardOf('Q', 'D'), cardOf('Q', 'C')]);
  return standardDeck().filter((card) => !removed.has(card));
}

/** One publicly-laid pair. Discards go face up at a table, so they are public. */
interface Discard {
  playerId: string;
  rank: Rank;
  cards: [CardId, CardId];
  atMs: number;
}

export class KazhuthaGameAdapter extends BaseAdapter {
  readonly gameId = 'KAZHUTHA' as const;

  override createMatch(players: PlatformPlayerState[]): State {
    const state = super.createMatch(players);
    const seats = players.map((player) => player.playerId);
    const deck = shuffle(kazhuthaDeck());

    // Dealt one at a time round the table, so hands differ by at most one
    // card. Forty-nine into five seats is 10/10/10/10/9, exactly as it falls
    // when it is dealt by hand.
    const hands: Hands = Object.fromEntries(seats.map((id) => [id, [] as CardId[]]));
    deck.forEach((card, index) => {
      hands[seats[index % seats.length]!]!.push(card);
    });

    // The opening discard, before anybody has taken a turn: a real deal ends
    // with everybody laying their pairs down at once, in front of everybody.
    const atMs = Date.now();
    const discards: Discard[] = [];
    for (const seatId of seats) {
      for (const laid of discardPairs(hands[seatId]!)) {
        discards.push({ playerId: seatId, ...laid, atMs });
      }
    }

    return {
      ...state,
      status: 'waiting',
      hands,
      discards,
      finishOrder: [] as string[],
      lastAction: null,
      donkeyCard: DONKEY_CARD,
    };
  }

  override startMatch(state: State): State {
    state.status = 'playing';

    // A seat that paired its entire hand on the deal is already out, and was
    // out before the first turn. Rare, but it happens with two players and a
    // kind shuffle, and a match whose opening turn belongs to somebody holding
    // nothing is a match that stalls on move one.
    for (const seatId of strings(state.order)) {
      if ((asHands(state)[seatId] ?? []).length === 0) retire(state, seatId);
    }
    resolve(state);
    return state;
  }

  validateAction(state: State, playerId: string, action: State): void {
    if (state.status !== 'playing') throw errors.gameNotStarted();
    if (turn(state) !== playerId) throw errors.invalidAction('It is not your turn.');
    if (action.type !== 'draw_card') throw errors.validation('Unsupported Kazhutha action.');

    const targetId = typeof action.targetPlayerId === 'string' ? action.targetPlayerId : '';
    if (targetId === playerId) throw errors.invalidAction('Draw from somebody else.');
    if (!strings(state.order).includes(targetId)) {
      throw errors.invalidAction('That player is already out.');
    }

    const target = asHands(state)[targetId] ?? [];
    if (target.length === 0) throw errors.invalidAction('That player has no cards to draw.');

    // The index is a position in a fan, not a card. It still has to be a real
    // position: a client that sends 40 is a broken one, not a clever one.
    const index = action.cardIndex;
    if (
      index !== undefined
      && (typeof index !== 'number' || !Number.isInteger(index) || index < 0 || index >= target.length)
    ) {
      throw errors.invalidAction('Pick a card that is actually in their hand.');
    }
  }

  handlePlayerAction(state: State, playerId: string, action: State): State {
    this.validateAction(state, playerId, action);

    const hands = asHands(state);
    const targetId = action.targetPlayerId as string;

    /**
     * The fan is reshuffled the instant before it is picked from.
     *
     * This is what lets a player choose a *position* — which is most of what
     * holding a hand of cards feels like — without the position carrying
     * information. The target knows their own card order, so an agreed "third
     * from the left" would otherwise hand the donkey to anybody willing to
     * collude over voice chat. After the shuffle, the third from the left is a
     * card neither of them has ever seen in that slot.
     */
    const target = shuffle(hands[targetId]!);
    hands[targetId] = target;

    const index = typeof action.cardIndex === 'number' ? action.cardIndex : randomInt(target.length);
    const drawn = target.splice(index, 1)[0]!;

    const own = hands[playerId] ??= [];
    own.push(drawn);
    const laid = discardPairs(own);
    const atMs = Date.now();
    if (laid.length > 0) {
      state.discards = [...asDiscards(state), ...laid.map((pair) => ({ playerId, ...pair, atMs }))];
    }

    state.lastAction = {
      type: 'draw',
      playerId,
      targetId,
      cardIndex: index,
      // Whether it paired is public — the pair goes face up — but the card
      // itself is not, unless it paired, in which case it is lying on the
      // table where everybody can count it.
      paired: laid.length > 0,
      pairedRanks: laid.map((pair) => pair.rank),
      atMs,
    };

    // Order matters. The target may have been emptied by the draw, and the
    // drawer may have been emptied by the pair they have just laid down. Both
    // are out, and both are *safe*: going out is how this game is won.
    if ((hands[targetId] ?? []).length === 0) retire(state, targetId);
    if ((hands[playerId] ?? []).length === 0) retire(state, playerId);

    resolve(state);
    if (state.status === 'playing') advanceFrom(state, playerId);
    return state;
  }

  getPublicState(state: State): State {
    const hands = asHands(state);
    const active = new Set(strings(state.order));
    const finished = strings(state.finishOrder);

    return {
      gameId: this.gameId,
      status: state.status,
      currentPlayerId: turn(state),

      // Which card is the donkey is common knowledge at a real table. Who is
      // holding her is not, and so is not here.
      donkeyCard: state.donkeyCard ?? DONKEY_CARD,

      players: strings(state.players).map((playerId) => ({
        playerId,
        cardCount: hands[playerId]?.length ?? 0,
        out: !active.has(playerId),
        /** 1 for the first player to go out; 0 while still holding cards. */
        finishPosition: finished.indexOf(playerId) + 1,
      })),

      // Every pair anybody has laid down, in order. Face up at a table, so
      // face up here — and the only thing in the game a sharp player can
      // genuinely count.
      discards: asDiscards(state).map((pair) => ({
        playerId: pair.playerId, rank: pair.rank, cards: pair.cards, atMs: pair.atMs,
      })),

      finishOrder: finished,
      lastAction: state.lastAction ?? null,

      // Only ever set once the match is over, and then it is the point of the
      // entire thing: somebody has to be shown holding her.
      kazhuthaId: state.status === 'completed' ? (record(state.result).loserId ?? null) : null,
    };
  }

  getPrivatePlayerState(state: State, playerId: string): State {
    return {
      ...this.getPublicState(state),
      /** Sorted, because a hand you are holding is a hand you have arranged. */
      hand: sortHand(asHands(state)[playerId] ?? []),
    };
  }

  /**
   * Picks whom to raid, and where in their fan to reach.
   *
   * The reasoning, in the order it is applied. Every input is a field of the
   * seat's own projection — there is nothing here a person at the table could
   * not also work out.
   *
   * 1. **Do not empty anybody.** A player who runs out is out and safe, and
   *    every seat that leaves makes the donkey likelier to finish with you. So
   *    a bot that is paying attention will not pull the last card out of a
   *    one-card hand unless that is all there is. This is the strongest idea
   *    in the game, and it is gated on [BotPersonality.read] — which is what
   *    makes an easy Stupid genuinely easier rather than merely clumsier: it
   *    cheerfully hands its opponents the exit.
   * 2. **Raid the biggest hand.** Donkey risk is flat across targets (see the
   *    class comment), so the only thing left to optimise is the chance of
   *    pairing, and that rises with the size of the hand being reached into.
   * 3. **Unless timid.** A low-[BotPersonality.boldness] character takes the
   *    quiet middle of the table instead. It is not better. It is a character.
   */
  override suggestBotAction(view: State, botId: string, personality: BotPersonality): State | null {
    if (view.status !== 'playing' || view.currentPlayerId !== botId) return null;

    const candidates = seatRows(view.players)
      .filter((seat) => seat.playerId !== botId && seat.cardCount > 0 && !seat.out);
    if (candidates.length === 0) return null;

    if (blunders(personality)) {
      const wild = pick(candidates);
      return draw(wild.playerId, randomInt(wild.cardCount));
    }

    // (1) Leave the one-card hands alone — if it noticed them.
    const survivable = candidates.filter((seat) => seat.cardCount > 1);
    const pool = notices(personality) && survivable.length > 0 ? survivable : candidates;

    // (2) and (3): the biggest hand, or the quiet middle of the table.
    const sorted = [...pool].sort((a, b) => b.cardCount - a.cardCount);
    const choice = personality.boldness >= 0.5
      ? sorted[0]!
      : sorted[Math.floor(sorted.length / 2)]!;

    // The fan is reshuffled before the pick lands, so the position is flavour.
    // It is still chosen rather than omitted: a Stupid that always reached for
    // the leftmost card would read as a script from across the room.
    return draw(choice.playerId, randomInt(choice.cardCount));
  }
}

function draw(targetPlayerId: string, cardIndex: number): State {
  return { type: 'draw_card', targetPlayerId, cardIndex };
}

function asHands(state: State): Hands {
  return (state.hands ??= {}) as Hands;
}

function asDiscards(state: State): Discard[] {
  return Array.isArray(state.discards) ? state.discards as Discard[] : [];
}

/** A hand as a player would arrange it: grouped by rank, so pairs sit together. */
function sortHand(hand: readonly CardId[]): CardId[] {
  return [...hand].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/**
 * Lays down every pair in [hand], in place, and returns what was laid.
 *
 * Pairs are by **rank** — two nines, whatever their suits — which is how the
 * game is played, and why the lone queen can never leave a hand. Four of a
 * kind is two pairs and goes down entirely, so the scan repeats until a pass
 * finds nothing left to lay.
 */
export function discardPairs(hand: CardId[]): { rank: Rank; cards: [CardId, CardId] }[] {
  const laid: { rank: Rank; cards: [CardId, CardId] }[] = [];

  for (;;) {
    const seen = new Map<Rank, number>();
    let paired = false;

    for (let index = 0; index < hand.length; index++) {
      const rank = rankOf(hand[index]!);
      if (rank === null) continue;

      const first = seen.get(rank);
      if (first === undefined) { seen.set(rank, index); continue; }

      // Splice the later index first, so the earlier one does not shift.
      const second = hand.splice(index, 1)[0]!;
      const partner = hand.splice(first, 1)[0]!;
      laid.push({ rank, cards: [partner, second] });
      paired = true;
      break;
    }

    if (!paired) return laid;
  }
}

/**
 * Takes a seat out of the rotation, safely.
 *
 * Going out is *winning* at Kazhutha, so this records a finishing position
 * rather than an elimination. The turn index is repaired here too: removing an
 * entry before the current one would otherwise slide the whole table round by
 * one and give somebody two turns in a row.
 */
function retire(state: State, playerId: string): void {
  const order = strings(state.order);
  const index = order.indexOf(playerId);
  if (index < 0) return;

  const current = typeof state.turnIndex === 'number' ? state.turnIndex : 0;
  state.order = order.filter((id) => id !== playerId);
  state.turnIndex = index < current ? Math.max(0, current - 1) : current;
  state.finishOrder = [...strings(state.finishOrder), playerId];
}

/**
 * Hands the turn to the next seat still holding cards, counting from [fromId].
 *
 * Counted from the player who just acted rather than from `turnIndex`, because
 * that player may have gone out during their own turn — laying down the pair
 * they had just drawn — and an index into an array they are no longer in
 * points at whoever shuffled up into their place.
 */
function advanceFrom(state: State, fromId: string): void {
  const order = strings(state.order);
  if (order.length === 0) return;

  const index = order.indexOf(fromId);
  if (index < 0) {
    // The actor retired on their own turn. `retire` already left `turnIndex`
    // pointing at the seat that moved down into their place, which is the next
    // player round the table.
    state.turnIndex = (typeof state.turnIndex === 'number' ? state.turnIndex : 0) % order.length;
    return;
  }

  state.turnIndex = index;
  nextTurn(state);
}

/**
 * Ends the match once one player is left holding cards.
 *
 * That player is holding the queen of spades and nothing else — she is the one
 * card that cannot be paired away — so there is no further play to be had.
 * They are the Kazhutha; everybody else places in the order they went out.
 */
function resolve(state: State): void {
  if (state.status !== 'playing' && state.status !== 'waiting') return;
  const order = strings(state.order);
  if (order.length > 1) return;

  const loser = order[0] ?? null;
  const hands = asHands(state);
  const finished = strings(state.finishOrder);

  state.status = 'completed';
  state.result = {
    loserId: loser,
    /** Everybody who went out, best first. The donkey is not among them. */
    winnerIds: finished,
    finishOrder: finished,
    /** Turned face up on the loser's side of the table when the match ends. */
    donkeyCard: DONKEY_CARD,
    heldCards: loser ? (hands[loser] ?? []) : [],
    reason: 'donkey_remaining',
  };

  // A podium the platform can record without knowing the rules: first out
  // scores highest, and the Kazhutha scores nothing at all.
  state.scores = Object.fromEntries(
    strings(state.players).map((playerId) => {
      const place = finished.indexOf(playerId);
      return [playerId, place < 0 ? 0 : Math.max(1, finished.length + 1 - place)];
    }),
  );
}

/** The public seat rows, with the fields the bot reasons over. */
function seatRows(value: unknown): { playerId: string; cardCount: number; out: boolean }[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((row) => {
    const seat = record(row);
    return typeof seat.playerId === 'string'
      ? [{
          playerId: seat.playerId,
          cardCount: Number(seat.cardCount) || 0,
          out: seat.out === true,
        }]
      : [];
  });
}
