import {
  AUTO_TOURNAMENT_STATUS,
  MATCH_STATUS,
  PLAYER_TYPE,
  REGISTRATION_STATUS,
  type BotDifficultyWire,
  type MatchOutcomeWire,
  type MatchStatusWire,
  type RegistrationStatusWire,
} from '@/constants/autoTournament.constants';
import { env } from '@/config/env';
import type { AutoTournamentDocument, TournamentRegistrationDocument } from '@/models/AutoTournament';
import type { TournamentMatchDocument } from '@/models/TournamentMatch';
import type {
  AutoTournamentDto,
  TournamentMatchDto,
  TournamentParticipantDto,
  ViewerMatchDto,
  ViewerTournamentStateDto,
} from '@/types/tournament.types';

/**
 * Turning stored rows into what a client is allowed to see.
 *
 * ## The one thing this file is careful about
 *
 * A match carries a room code, and that code is the key to a protected room.
 * `toMatchDto` therefore takes a viewer and blanks the code for anybody who is
 * not playing in that match. The room itself refuses outsiders regardless —
 * `roomService.joinRoom` checks `allowedUserIds` before anything else — so
 * this is the second of two locks rather than the only one. Two, because a
 * code handed to a spectator is a code they can share, and the interesting
 * failure is somebody trying it while the match is still being set up.
 *
 * ## Why a bot is never `isSelf`
 *
 * `isSelf` is how a client bolds the reader's own row. A bot has no viewer, so
 * the comparison is against `userId`, which is null on every bot row — and a
 * null-to-null comparison is exactly the bug that would bold every bot for
 * every signed-out reader. The check is written against the *user* id and
 * requires both sides to be present.
 */

/** One entrant. */
export function toParticipantDto(
  row: TournamentRegistrationDocument,
  viewerId: string | null,
): TournamentParticipantDto {
  const userId = row.userId ? String(row.userId) : null;

  return {
    registrationId: String(row._id),
    // A person plays under their user id; a bot under the ObjectId of its
    // profile row, which is the id its seat in the game engine carries.
    playerId: userId ?? String(row.botId ?? ''),
    displayName: row.displayName,
    avatarId: row.avatarId ?? 0,
    avatarColorIndex: row.avatarColorIndex ?? 0,
    playerType: row.playerType as TournamentParticipantDto['playerType'],
    isBot: Boolean(row.isBot),
    botDifficulty: (row.botDifficulty ?? null) as BotDifficultyWire | null,
    status: row.status as RegistrationStatusWire,
    seed: row.seed ?? null,
    // Both sides required: a null viewer must not match a bot's null user id.
    isSelf: Boolean(viewerId && userId && userId === viewerId),
  };
}

/** One tournament, with the caller's own state folded in. */
export function toTournamentDto(input: {
  row: AutoTournamentDocument;
  viewerId: string | null;
  viewer: ViewerTournamentStateDto;
  winner: TournamentRegistrationDocument | null;
}): AutoTournamentDto {
  const { row, viewerId, viewer, winner } = input;

  const humans = row.humanPlayerCount ?? 0;
  const bots = row.botPlayerCount ?? 0;

  return {
    id: String(row._id),
    tournamentDate: row.tournamentDate,
    dailySlot: row.dailySlot as AutoTournamentDto['dailySlot'],
    slotNumber: row.slotNumber,
    name: row.name,
    description: row.description ?? '',
    status: row.status as AutoTournamentDto['status'],
    format: row.format,

    minPlayers: row.minPlayers,
    maxPlayers: row.maxPlayers,
    minHumanPlayers: row.minHumanPlayers,
    maxBots: row.maxBots,
    allowBots: row.allowBots,
    botDifficulty: row.botDifficulty as BotDifficultyWire,

    humanPlayerCount: humans,
    botPlayerCount: bots,
    totalPlayers: humans + bots,

    registrationOpenAtMs: row.registrationOpenAt.getTime(),
    registrationCloseAtMs: row.registrationCloseAt.getTime(),
    botFillAtMs: row.botFillAt ? row.botFillAt.getTime() : null,
    countdownEndsAtMs: row.countdownEndsAt ? row.countdownEndsAt.getTime() : null,
    phaseEndsAtMs: phaseDeadline(row),
    checkInRequired: env.tournament.checkInEnabled,
    checkInOpenAtMs: row.checkInOpenAt.getTime(),
    checkInCloseAtMs: row.checkInCloseAt.getTime(),
    startAtMs: row.startAt.getTime(),

    totalRounds: row.totalRounds ?? 0,
    currentRound: row.currentRound ?? 0,

    // A constant, sent rather than assumed. If entry ever stops being free the
    // clients should learn it from the server rather than from a new build.
    entryFee: 0,

    cancelReason: row.cancelReason ?? null,
    completedAtMs: row.completedAt ? row.completedAt.getTime() : null,
    viewer,

    /**
     * Who won *this* tournament, and nothing about any other.
     *
     * Read from the snapshot on the row, falling back to the live registration
     * only for a tournament that finished before those fields existed. Both
     * are scoped to this document, which is the whole of "do not show
     * tournament 1's winner on tournament 2's card": there is no ambient
     * winner in this codebase to leak, and no serialiser that could reach one.
     */
    winner: winnerSnapshot(row, winner, viewerId),
  };
}

/**
 * The winner block, from the snapshot written when the final was decided.
 *
 * Falls back to the live registration row for a tournament completed before
 * the snapshot fields existed, and to null for one that has not finished —
 * which is every tournament that has not finished, including one whose
 * *bracket* has a leader. A leader is not a winner and the card must not draw
 * one as though they were.
 */
function winnerSnapshot(
  row: AutoTournamentDocument,
  live: TournamentRegistrationDocument | null,
  viewerId: string | null,
): TournamentParticipantDto | null {
  if (row.winnerDisplayName) {
    const userId = row.winnerUserId ? String(row.winnerUserId) : null;

    return {
      registrationId: row.winnerRegistrationId ? String(row.winnerRegistrationId) : '',
      playerId: userId ?? '',
      displayName: row.winnerDisplayName,
      avatarId: row.winnerAvatarId ?? 0,
      avatarColorIndex: row.winnerAvatarColorIndex ?? 0,
      playerType: row.winnerIsBot ? PLAYER_TYPE.aiBot : PLAYER_TYPE.human,
      isBot: Boolean(row.winnerIsBot),
      botDifficulty: null,
      status: REGISTRATION_STATUS.winner,
      seed: null,
      // Both sides required, so a signed-out reader is never told a bot's null
      // user id is their own.
      isSelf: Boolean(viewerId && userId && userId === viewerId),
    };
  }

  return live ? toParticipantDto(live, viewerId) : null;
}

/**
 * The next deadline this tournament is counting down to.
 *
 * ## Why the server picks the clock
 *
 * Because "which clock" is a question about the lifecycle, and a client that
 * answered it would be a second implementation of the lifecycle. One number,
 * always the next thing that will actually happen:
 *
 * - `UPCOMING` — when registration opens. The card for tonight's tournament
 *   shows "joining opens in 4h", which is the next thing a player can *do*.
 *   The start time is on the row separately, because the card shows both.
 * - `REGISTRATION` — when the window shuts, which is when check-in opens.
 * - `CHECK_IN` — when check-in closes, which is the published start.
 * - `STARTING` — the fast-start countdown, on a deployment that has one.
 * - Anything else — no clock. A running tournament's timings belong to its
 *   matches, and a finished one has none.
 */
function phaseDeadline(row: AutoTournamentDocument): number | null {
  if (row.status === AUTO_TOURNAMENT_STATUS.upcoming) {
    return row.registrationOpenAt.getTime();
  }

  if (row.status === AUTO_TOURNAMENT_STATUS.starting) {
    return row.countdownEndsAt ? row.countdownEndsAt.getTime() : null;
  }

  if (row.status === AUTO_TOURNAMENT_STATUS.registration) {
    // The bot fill only gets the clock when it is genuinely the next event —
    // that is, on the fast-start path, where it falls inside the registration
    // window. Under the daily schedule the seats are filled when check-in
    // closes, which is the start; showing that here would put a two-hour clock
    // on a window that shuts in ten minutes.
    const fillAt = row.botFillAt ? row.botFillAt.getTime() : null;
    const closeAt = row.registrationCloseAt.getTime();

    if (fillAt !== null && fillAt < closeAt && fillAt > Date.now()) return fillAt;
    return closeAt;
  }

  if (row.status === AUTO_TOURNAMENT_STATUS.checkIn) return row.checkInCloseAt.getTime();

  return null;
}

/**
 * One pairing.
 *
 * `viewerIsParticipant` is passed in rather than derived here because deciding
 * it needs the registration rows, which the caller has already loaded — and
 * making this function load them would turn a bracket render into a query per
 * match.
 */
export function toMatchDto(input: {
  row: TournamentMatchDocument;
  playerA: TournamentRegistrationDocument | null;
  playerB: TournamentRegistrationDocument | null;
  viewerId: string | null;
  viewerIsParticipant: boolean;
}): TournamentMatchDto {
  const { row, playerA, playerB, viewerId, viewerIsParticipant } = input;

  return {
    matchId: String(row._id),
    roundNumber: row.roundNumber,
    matchNumber: row.matchNumber,
    status: row.status as MatchStatusWire,
    outcome: (row.outcome ?? null) as MatchOutcomeWire | null,
    playerA: playerA ? toParticipantDto(playerA, viewerId) : null,
    playerB: playerB ? toParticipantDto(playerB, viewerId) : null,
    scoreA: row.scoreA ?? 0,
    scoreB: row.scoreB ?? 0,
    winnerRegistrationId: row.winnerRegistrationId ? String(row.winnerRegistrationId) : null,
    // The key to a protected room. Only its two players ever see it.
    roomCode: viewerIsParticipant ? (row.roomCode ?? null) : null,
    entryDeadlineMs: row.entryDeadlineAt ? row.entryDeadlineAt.getTime() : null,
  };
}

/** The "enter your match" card, for a participant with a match waiting. */
export function toViewerMatchDto(row: TournamentMatchDocument): ViewerMatchDto {
  return {
    matchId: String(row._id),
    roundNumber: row.roundNumber,
    matchNumber: row.matchNumber,
    status: row.status as MatchStatusWire,
    roomCode: row.roomCode ?? null,
    entryDeadlineMs: row.entryDeadlineAt ? row.entryDeadlineAt.getTime() : null,
  };
}

/** The viewer state of somebody who is not in this tournament at all. */
export function anonymousViewerState(
  row: AutoTournamentDocument,
  blockedReason: string | null,
): ViewerTournamentStateDto {
  const open =
    row.status === AUTO_TOURNAMENT_STATUS.registration &&
    (row.humanPlayerCount ?? 0) + (row.botPlayerCount ?? 0) < row.maxPlayers;

  return {
    isRegistered: false,
    isCheckedIn: false,
    canRegister: open && blockedReason === null,
    canCheckIn: false,
    canWithdraw: false,
    blockedReason,
    activeMatch: null,
  };
}

/** The viewer state of somebody who holds a registration row. */
export function participantViewerState(input: {
  row: AutoTournamentDocument;
  registration: TournamentRegistrationDocument;
  activeMatch: TournamentMatchDocument | null;
}): ViewerTournamentStateDto {
  const { row, registration, activeMatch } = input;

  const checkedIn = registration.checkedInAt !== null;

  return {
    isRegistered: true,
    isCheckedIn: checkedIn,
    canRegister: false,
    // Check-in is open, they have not done it, and they are still a live
    // registration rather than one already written off as a no-show.
    canCheckIn:
      row.status === AUTO_TOURNAMENT_STATUS.checkIn &&
      !checkedIn &&
      registration.status === REGISTRATION_STATUS.registered,
    // Withdrawing is only for the window before the bracket exists. Past that
    // a seat is a pairing, and removing it would leave a hole in the draw.
    canWithdraw: row.status === AUTO_TOURNAMENT_STATUS.registration,
    blockedReason: null,
    activeMatch:
      activeMatch &&
      (activeMatch.status === MATCH_STATUS.ready || activeMatch.status === MATCH_STATUS.running)
        ? toViewerMatchDto(activeMatch)
        : null,
  };
}

/** Whether a registration row belongs to a person rather than a bot. */
export function isHumanRow(row: TournamentRegistrationDocument): boolean {
  return row.playerType === PLAYER_TYPE.human;
}
