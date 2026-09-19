import type { GameDefinitionDto, GameId } from '@/games/game.types';

/**
 * Exactly the five games in the product brief. Keep all UI/API metadata here.
 *
 * `supportsBots` means **PLAY WITH STUPID works today**, not that it is
 * planned. A client renders that button straight from this flag, so a game
 * that claims bots it cannot play ships a button that does nothing.
 *
 * All five now qualify, and the two that did not are worth a note, because the
 * argument for leaving them out was a real one and it is what the work had to
 * answer.
 *
 * Bluff Bar was held back on the grounds that a bluffing bot with no read on
 * the table is either an oracle or a coin toss. Both halves of that are true
 * and neither is the only option: the shoe's composition and every claim made
 * this round are *public*, so a bot can prove somebody is lying by arithmetic
 * that any player at the table could do — and get it wrong when it is not
 * paying attention, which is what its `read` dial decides.
 *
 * Space Mystery was held back on the grounds that social deduction is the
 * conversation, which a bot cannot have. It still cannot, properly. What it
 * can do is walk the ship, do its tasks, notice who was standing over the
 * body, say so in the meeting and vote on it — from its own line of sight and
 * nothing else. That is a player, if not a good one, and it is enough to fill
 * a lobby that would otherwise never start.
 */
export const GAME_CATALOG: readonly GameDefinitionDto[] = [
  {
    gameId: 'SCRIBBLE_GUESS',
    displayName: 'Scribble & Guess',
    description: 'Draw the secret word while friends race to guess it.',
    icon: 'brush', banner: 'assets/games/scribble_guess_banner.png',
    minPlayers: 2, maxPlayers: 12, supportsBots: true, supportsVoice: true,
    supportsTextChat: true, route: '/games/SCRIBBLE_GUESS', status: 'live', version: 1,
    rules: ['One player draws each turn.', 'Guess quickly for more points.'],
  },
  {
    gameId: 'KAZHUTHA',
    displayName: 'Kazhutha',
    description: 'Lay down your pairs. Whoever is left with the queen is the donkey.',
    icon: 'playing_cards', banner: 'assets/games/kazhutha_banner.png',
    minPlayers: 2, maxPlayers: 6, supportsBots: true, supportsVoice: true,
    supportsTextChat: true, route: '/games/KAZHUTHA', status: 'live', version: 1,
    rules: ['Draw a card from another hand.', 'Lay down every pair.', 'Do not be left with the queen of spades.'],
  },
  {
    gameId: 'BLUFF_BAR',
    displayName: 'Bluff Bar',
    description: 'Read the table, make a claim, or call somebody’s bluff.',
    icon: 'local_bar', banner: 'assets/games/bluff_bar_banner.png',
    minPlayers: 2, maxPlayers: 6, supportsBots: true, supportsVoice: true,
    supportsTextChat: true, route: '/games/BLUFF_BAR', status: 'live', version: 1,
    rules: ['Claim the called rank.', 'Call a liar and turn the cards over.', 'Whoever is wrong drinks.'],
  },
  {
    gameId: 'SPACE_MYSTERY',
    displayName: 'Space Mystery',
    description: 'Repair the station, uncover sabotage, and vote with care.',
    icon: 'rocket_launch', banner: 'assets/games/space_mystery_banner.png',
    minPlayers: 4, maxPlayers: 10, supportsBots: true, supportsVoice: true,
    supportsTextChat: true, route: '/games/SPACE_MYSTERY', status: 'live', version: 1,
    rules: ['Finish the repairs, or stop whoever is not helping.', 'Report a body to call a meeting.', 'Your role is yours alone.'],
  },
  {
    gameId: 'LUDO',
    displayName: 'Ludo',
    description: 'Roll, race home, capture tokens, and keep the turn moving.',
    icon: 'casino', banner: 'assets/games/ludo_banner.png',
    minPlayers: 2, maxPlayers: 4, supportsBots: true, supportsVoice: true,
    supportsTextChat: true, route: '/games/LUDO', status: 'live', version: 1,
    rules: ['The server rolls the dice.', 'Six enters a token.', 'Get all four home.'],
  },
] as const;

export function gameDefinition(gameId: GameId): GameDefinitionDto {
  const game = GAME_CATALOG.find((item) => item.gameId === gameId);
  if (!game) throw new Error(`Unknown game id: ${gameId}`);
  return game;
}
