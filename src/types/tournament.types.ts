import type {
  AutoTournamentStatusWire,
  BotDifficultyWire,
  MatchOutcomeWire,
  MatchStatusWire,
  PlayerTypeWire,
  RegistrationStatusWire,
} from '@/constants/autoTournament.constants';

/**
 * What the three clients see of a tournament.
 *
 * ## Why the counts are split three ways
 *
 * `totalPlayers` alone would let a client draw "4 / 4" on a tournament that is
 * one person and three robots, which is exactly the thing the product decided
 * must never be hidden. Sending humans and bots separately means the honest
 * rendering — "1 player, 3 AI" — is the easy one, and a client would have to
 * work to draw the misleading version.
 *
 * ## Why every timestamp is epoch milliseconds
 *
 * Because the client renders countdowns from them against a server clock it
 * has already measured its offset against (`c:time:ping`). A formatted string
 * would be a number the client could not count down from, and a status alone
 * goes stale the moment the screen is left open.
 */
export interface AutoTournamentDto {
  id: string;
  slotNumber: number;
  tournamentNumber: number;
  name: string;
  description: string;
  status: AutoTournamentStatusWire;
  format: string;

  minPlayers: number;
  maxPlayers: number;
  minHumanPlayers: number;
  maxBots: number;
  allowBots: boolean;
  botDifficulty: BotDifficultyWire;

  /** People registered. Never includes bots. */
  humanPlayerCount: number;
  /** AI players on the roster. */
  botPlayerCount: number;
  /** The two above, added up. What a "3 / 4" chip is drawn from. */
  totalPlayers: number;

  registrationOpenAtMs: number;
  registrationCloseAtMs: number;
  checkInOpenAtMs: number;
  checkInCloseAtMs: number;
  startAtMs: number;

  totalRounds: number;
  currentRound: number;

  /** Free entry, always. Sent so the UI does not hardcode a product decision. */
  entryFee: number;

  /** Why a cancelled tournament was cancelled. Null otherwise. */
  cancelReason: string | null;

  /** The caller's own state in this tournament. */
  viewer: ViewerTournamentStateDto;

  winner: TournamentParticipantDto | null;
}

/**
 * Everything the caller needs to decide which button to draw.
 *
 * Computed server-side rather than left to the client, because the rules it
 * encodes — one tournament at a time, check-in only for the registered, no
 * entry after the window — are server rules. A client deriving them would be a
 * second implementation that could disagree, and the disagreement would look
 * like a button that does nothing.
 */
export interface ViewerTournamentStateDto {
  isRegistered: boolean;
  isCheckedIn: boolean;
  /** Whether `POST /register` would succeed right now. */
  canRegister: boolean;
  /** Whether `POST /check-in` would succeed right now. */
  canCheckIn: boolean;
  /** Whether `DELETE /register` would succeed right now. */
  canWithdraw: boolean;
  /**
   * Why the caller cannot join, in a sentence they can act on.
   *
   * Null when they can. The common case is "you are already in Daily Scribble
   * Cup #4", which is the one refusal a player would otherwise find baffling.
   */
  blockedReason: string | null;
  /** The match this caller should be entering, if any. */
  activeMatch: ViewerMatchDto | null;
}

/** A match the caller is in and may enter. */
export interface ViewerMatchDto {
  matchId: string;
  roundNumber: number;
  matchNumber: number;
  status: MatchStatusWire;
  roomCode: string | null;
  /** When entry closes and the match is decided without them. */
  entryDeadlineMs: number | null;
}

/** One entrant, human or AI. */
export interface TournamentParticipantDto {
  registrationId: string;
  /** The user id for a person, or the bot's play id. Never null. */
  playerId: string;
  displayName: string;
  avatarId: number;
  avatarColorIndex: number;
  playerType: PlayerTypeWire;
  /** The flag every client draws its badge from. */
  isBot: boolean;
  botDifficulty: BotDifficultyWire | null;
  status: RegistrationStatusWire;
  seed: number | null;
  /** Whether this row is the caller. False for every bot. */
  isSelf: boolean;
}

/** One pairing, as the bracket draws it. */
export interface TournamentMatchDto {
  matchId: string;
  roundNumber: number;
  matchNumber: number;
  status: MatchStatusWire;
  outcome: MatchOutcomeWire | null;
  playerA: TournamentParticipantDto | null;
  playerB: TournamentParticipantDto | null;
  scoreA: number;
  scoreB: number;
  winnerRegistrationId: string | null;
  /** Only ever sent to a participant of this match. Null for everybody else. */
  roomCode: string | null;
  entryDeadlineMs: number | null;
}

/** One round of a bracket. */
export interface TournamentRoundDto {
  roundNumber: number;
  name: string;
  matches: TournamentMatchDto[];
}

/** The whole bracket. */
export interface TournamentBracketDto {
  tournamentId: string;
  totalRounds: number;
  currentRound: number;
  rounds: TournamentRoundDto[];
}
