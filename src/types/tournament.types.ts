import type {
  AutoTournamentStatusWire,
  BotDifficultyWire,
  DailySlotWire,
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

  /**
   * The calendar day this tournament belongs to, `YYYY-MM-DD`, in the
   * deployment's timezone rather than the reader's.
   *
   * Sent so a client can say "today" without doing its own midnight
   * arithmetic against a clock that might be in another zone — the day the
   * schedule belongs to is a server fact.
   */
  tournamentDate: string;

  /** Which of the day's three this is. */
  dailySlot: DailySlotWire;

  /** The same thing as a number, 1 to 3, for ordering. */
  slotNumber: number;

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
  /** When bots begin taking the empty seats. Null once they have. */
  botFillAtMs: number | null;
  /** When the start countdown ends, or null when none is running. */
  countdownEndsAtMs: number | null;
  /**
   * Whichever deadline this tournament is actually counting down to.
   *
   * ## Why the server picks it rather than the client
   *
   * Because "which clock do I show" is a question about the lifecycle, and the
   * lifecycle is server state. A client deriving it would need to know that
   * `STARTING` means the countdown, that `REGISTRATION` means the bot fill
   * unless it has passed, and that a missing bot-fill time means the
   * registration close — three rules that would have to be reimplemented in
   * Flutter and in the web client and kept in step with this file.
   *
   * One number, always the next thing that will happen, always absolute so a
   * client that was backgrounded renders the right remaining time.
   */
  phaseEndsAtMs: number | null;
  /** Whether the caller must confirm before the bracket is drawn. */
  checkInRequired: boolean;
  checkInOpenAtMs: number;
  checkInCloseAtMs: number;
  startAtMs: number;

  totalRounds: number;
  currentRound: number;

  /** Free entry, always. Sent so the UI does not hardcode a product decision. */
  entryFee: number;

  /** Why a cancelled tournament was cancelled. Null otherwise. */
  cancelReason: string | null;

  /** When it finished, or null while it has not. */
  completedAtMs: number | null;

  /** The caller's own state in this tournament. */
  viewer: ViewerTournamentStateDto;

  /**
   * Who won this tournament, or null until one has.
   *
   * A snapshot taken when the final was decided, so the name and avatar are
   * the ones they won under even if the person has since renamed themselves.
   * Scoped to this tournament and no other: a client drawing three cards gets
   * three independent answers, and two of them are usually null.
   */
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
   * Almost always null now. It carried "you are already in another tournament"
   * under the old one-at-a-time rule, which no longer exists — a player may be
   * in all three of a day's tournaments. What is left is the tournament's own
   * state, which the status and the clock on the card already say, so there is
   * usually nothing here worth a sentence.
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
