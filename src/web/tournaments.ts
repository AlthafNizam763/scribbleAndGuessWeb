import { request } from '@/web/api';
import type {
  AutoTournamentDto,
  TournamentBracketDto,
  TournamentParticipantDto,
} from '@/types/tournament.types';

/**
 * The automatic tournament endpoints, for the web client.
 *
 * ## Why this file is so thin
 *
 * Because there is nothing for it to decide. Every rule about who may join,
 * who may check in and what a tournament is currently doing is computed by the
 * server and arrives on the row — including the sentence to show somebody who
 * cannot join. Re-deriving any of it here would give two places for it to
 * disagree, and this copy would be the one that was wrong.
 *
 * ## What is not here, and cannot be
 *
 * There is no `createTournament`, no `addBot`, no `setBracket` and no
 * `reportResult` — there are no endpoints for them. A web client cannot create
 * a tournament for the same reason the Flutter client cannot: the organiser is
 * the backend, and the API surface simply does not contain the verb.
 */

/** One day's schedule: at most three tournaments, in the order they happen. */
export interface TournamentDayDto {
  /** `YYYY-MM-DD`, in the server's configured zone rather than the browser's. */
  tournamentDate: string;
  /** The zone that date and every time on the page are in. */
  timeZone: string;
  tournaments: AutoTournamentDto[];
}

/** Where a match is being played, after asking to enter it. */
export interface MatchEntryDto {
  roomId: string;
  roomCode: string;
  matchId: string;
  roundNumber: number;
  matchNumber: number;
  entryDeadlineMs: number | null;
}

/**
 * Today's tournaments, in the order they happen.
 *
 * Works signed out — the schedule is public — and the `viewer` block on each
 * row is simply the anonymous one. A token adds the caller's own state, per
 * tournament, because a player may be in more than one of them.
 */
export async function fetchTournamentDay(
  token: string | null,
): Promise<TournamentDayDto> {
  const data = await request<TournamentDayDto>('/api/tournaments', {
    token: token ?? undefined,
  });

  return {
    tournamentDate: data.tournamentDate ?? '',
    timeZone: data.timeZone ?? 'UTC',
    tournaments: data.tournaments ?? [],
  };
}

/** One tournament, with the caller's own state folded in. */
export async function fetchTournament(
  token: string,
  tournamentId: string,
): Promise<AutoTournamentDto> {
  const data = await request<{ tournament: AutoTournamentDto }>(
    `/api/tournaments/${tournamentId}`,
    { token },
  );
  return data.tournament;
}

/** Everybody in a tournament, AI players included and flagged. */
export async function fetchTournamentParticipants(
  token: string,
  tournamentId: string,
): Promise<TournamentParticipantDto[]> {
  const data = await request<{ items: TournamentParticipantDto[] }>(
    `/api/tournaments/${tournamentId}/participants`,
    { token },
  );
  return data.items ?? [];
}

/**
 * The draw.
 *
 * Room codes arrive only on the matches the caller is playing in. That is the
 * server's decision, not a filter applied here — and the room refuses an
 * outsider regardless, so a code that somehow leaked still gets nowhere.
 */
export async function fetchTournamentBracket(
  token: string,
  tournamentId: string,
): Promise<TournamentBracketDto> {
  return request<TournamentBracketDto>(
    `/api/tournaments/${tournamentId}/bracket`,
    { token },
  );
}

/** How everybody placed. */
export async function fetchTournamentResults(
  token: string,
  tournamentId: string,
): Promise<(TournamentParticipantDto & { placement: number })[]> {
  const data = await request<{
    items: (TournamentParticipantDto & { placement: number })[];
  }>(`/api/tournaments/${tournamentId}/leaderboard`, { token });
  return data.items ?? [];
}

/** Takes a place. */
export async function registerForTournament(
  token: string,
  tournamentId: string,
): Promise<AutoTournamentDto> {
  const data = await request<{ tournament: AutoTournamentDto }>(
    `/api/tournaments/${tournamentId}/register`,
    { token, method: 'POST' },
  );
  return data.tournament;
}

/** Gives a place back. Only possible while registration is open. */
export async function withdrawFromTournament(
  token: string,
  tournamentId: string,
): Promise<AutoTournamentDto> {
  const data = await request<{ tournament: AutoTournamentDto }>(
    `/api/tournaments/${tournamentId}/register`,
    { token, method: 'DELETE' },
  );
  return data.tournament;
}

/** Confirms the caller is here, in the window before the draw. */
export async function checkInToTournament(
  token: string,
  tournamentId: string,
): Promise<AutoTournamentDto> {
  const data = await request<{ tournament: AutoTournamentDto }>(
    `/api/tournaments/${tournamentId}/check-in`,
    { token, method: 'POST' },
  );
  return data.tournament;
}

/**
 * Asks for the code of the room this caller's match is in.
 *
 * The tab then joins that room exactly as it joins any other — through
 * `/room/:code` and the socket join the room page already owns. One way into a
 * lobby rather than two that can disagree.
 */
export async function enterTournamentMatch(
  token: string,
  tournamentId: string,
  matchId: string,
): Promise<MatchEntryDto> {
  return request<MatchEntryDto>(
    `/api/tournaments/${tournamentId}/matches/${matchId}/enter`,
    { token, method: 'POST' },
  );
}
