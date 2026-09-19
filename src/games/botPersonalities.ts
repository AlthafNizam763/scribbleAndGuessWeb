import { BOT_DIFFICULTY, type BotDifficultyWire } from '@/constants/autoTournament.constants';
import type { BotPersonality } from '@/games/game.types';

/**
 * Who the Stupids are, mechanically.
 *
 * One entry per bot in `BOT_PROFILES`, keyed by the same `botId`, so the name
 * a player sees and the way that name plays are the same decision. Smug Dave
 * going for the throat every time is a character trait, not a difficulty
 * setting, and somebody who plays three matches should start to recognise it.
 *
 * ## The numbers are deliberately not "good"
 *
 * `blunderChance` runs from 0.12 to 0.55. Even the sharpest of them throws
 * away roughly one move in eight, and the worst is close to a coin flip. That
 * is the product: a bot that plays well is a bot nobody laughs at, and nothing
 * here is trying to be a worthy opponent.
 *
 * What none of them can do is cheat. Every dial only chooses between moves the
 * adapter already generated as legal, and the engine validates the result
 * regardless — see `GameAdapter.suggestBotAction`.
 */
export const BOT_PERSONALITIES: Readonly<Record<string, BotPersonality>> = Object.freeze({
  /** Mr Whiskers: the closest thing to competent, and still not close. */
  scribbler: { botId: 'scribbler', blunderChance: 0.12, boldness: 0.5, thinkMs: 1400, read: 0.88, difficulty: BOT_DIFFICULTY.normal },

  /** Sir Naps: slow, passive, frequently wrong. Plays like it is half asleep. */
  sketcher: { botId: 'sketcher', blunderChance: 0.45, boldness: 0.2, thinkMs: 2600, read: 0.55, difficulty: BOT_DIFFICULTY.normal },

  /** Chaos Kitty: fast and almost random. The reason the app is called this. */
  doodler: { botId: 'doodler', blunderChance: 0.55, boldness: 0.9, thinkMs: 700, read: 0.45, difficulty: BOT_DIFFICULTY.normal },

  /** Professor Paws: thinks for ages, then does something indefensible. */
  guessmaster: { botId: 'guessmaster', blunderChance: 0.3, boldness: 0.4, thinkMs: 3200, read: 0.7, difficulty: BOT_DIFFICULTY.normal },

  /** Lord Fluff: moderately bold, moderately silly. */
  pixeler: { botId: 'pixeler', blunderChance: 0.28, boldness: 0.65, thinkMs: 1600, read: 0.72, difficulty: BOT_DIFFICULTY.normal },

  /** Captain Zoom: acts before anybody has finished reading the board. */
  quickdrawer: { botId: 'quickdrawer', blunderChance: 0.4, boldness: 0.8, thinkMs: 450, read: 0.6, difficulty: BOT_DIFFICULTY.normal },

  /** Smug Dave: always takes the aggressive line, whether or not it is wise. */
  smugcat: { botId: 'smugcat', blunderChance: 0.22, boldness: 1, thinkMs: 1200, read: 0.78, difficulty: BOT_DIFFICULTY.normal },

  /** Confused Gary: the highest blunder rate on the roster. */
  confusedcat: { botId: 'confusedcat', blunderChance: 0.55, boldness: 0.35, thinkMs: 2100, read: 0.45, difficulty: BOT_DIFFICULTY.normal },

  /** Nervous Nancy: avoids every risk, including the ones worth taking. */
  scaredcat: { botId: 'scaredcat', blunderChance: 0.35, boldness: 0.05, thinkMs: 2400, read: 0.65, difficulty: BOT_DIFFICULTY.normal },

  /** Big Yawn: slowest on the roster, and barely engaged. */
  lazycat: { botId: 'lazycat', blunderChance: 0.48, boldness: 0.1, thinkMs: 3600, read: 0.52, difficulty: BOT_DIFFICULTY.normal },
});

/**
 * What each difficulty does to a character, as multipliers rather than values.
 *
 * ## Why this is a modifier and not a second table
 *
 * A difficulty that replaced the personality would make every hard bot the
 * same bot, and the roster would stop meaning anything the moment a player
 * chose Hard. Smug Dave on Hard should still be the one who goes for the
 * throat — just the one who is right about it more often. So difficulty scales
 * the two dials that describe competence, leaves [BotPersonality.boldness]
 * alone entirely, because boldness is the character, and nudges the clock.
 *
 * ## Why Hard is not "plays perfectly"
 *
 * It caps well short. A bot that never errs is a wall, and the whole product
 * is bots you can beat and laugh at. Hard is a player who is paying attention;
 * it is not an engine.
 */
const DIFFICULTY_MODIFIERS: Readonly<Record<BotDifficultyWire, {
  blunder: number;
  read: number;
  think: number;
}>> = Object.freeze({
  // Barely tracking the game. Blunders more than half the time at the top of
  // the roster, and uses almost none of what it can see.
  [BOT_DIFFICULTY.easy]: { blunder: 1.7, read: 0.35, think: 1.35 },

  // The roster as written. Normal is the identity row on purpose, so a
  // character's numbers in the table above are the numbers it plays with.
  [BOT_DIFFICULTY.normal]: { blunder: 1, read: 1, think: 1 },

  // Attentive. Still blunders — Chaos Kitty on Hard lands near one move in
  // four — and still takes long enough to look like it thought about it.
  [BOT_DIFFICULTY.hard]: { blunder: 0.42, read: 1.45, think: 0.7 },
});

/** Keeps a scaled dial inside the range the adapters assume. */
function clamp(value: number, low: number, high: number): number {
  return Math.min(high, Math.max(low, value));
}

/**
 * The traits for one bot at one difficulty, or a middling default.
 *
 * Falls back rather than throwing: a bot seated from a roster row that has no
 * personality yet should play like an average Stupid, not stall the match it
 * is sitting in. The same goes for a difficulty the roster does not know —
 * an unseated `null` from an older room document reads as Normal, which is
 * how every room behaved before difficulty reached this layer at all.
 */
export function personalityFor(
  botId: string,
  difficulty: BotDifficultyWire | null = null,
): BotPersonality {
  const base = BOT_PERSONALITIES[botId] ?? {
    botId,
    blunderChance: 0.35,
    boldness: 0.5,
    thinkMs: 1500,
    read: 0.6,
    difficulty: BOT_DIFFICULTY.normal,
  };

  const level = difficulty ?? BOT_DIFFICULTY.normal;
  const modifier = DIFFICULTY_MODIFIERS[level] ?? DIFFICULTY_MODIFIERS[BOT_DIFFICULTY.normal];

  return {
    ...base,
    difficulty: level,
    // Floors and ceilings, not raw products: an easy Confused Gary would
    // otherwise pass 0.9 and stop taking a turn that resembles play at all,
    // and a hard Mr Whiskers would drop under 0.05 and become the wall.
    blunderChance: clamp(base.blunderChance * modifier.blunder, 0.05, 0.75),
    read: clamp(base.read * modifier.read, 0.1, 0.95),
    // Easy bots are slower because they are meant to look like they are
    // struggling, and because a fast wrong answer reads as a bug.
    thinkMs: Math.round(clamp(base.thinkMs * modifier.think, 350, 6000)),
  };
}
