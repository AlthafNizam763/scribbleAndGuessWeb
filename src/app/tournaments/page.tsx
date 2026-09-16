'use client';

import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useMemo, useState } from 'react';

import {
  TOURNAMENT_EVENTS,
  CLIENT_TOURNAMENT_UNWATCH,
  CLIENT_TOURNAMENT_WATCH,
} from '@/constants/socket.constants';
import type {
  AutoTournamentDto,
  TournamentBracketDto,
  TournamentParticipantDto,
} from '@/types/tournament.types';
import { useGame } from '@/web/GameProvider';
import { ApiError } from '@/web/api';
import { ListState, PageShell } from '@/web/components/PageShell';
import { Avatar } from '@/web/components/ui';
import { emit, getSocket } from '@/web/socket';
import {
  checkInToTournament,
  enterTournamentMatch,
  fetchTournamentBracket,
  fetchTournamentParticipants,
  fetchTournamentDay,
  registerForTournament,
  withdrawFromTournament,
  type TournamentDayDto,
} from '@/web/tournaments';

/**
 * The day's tournaments, in the browser.
 *
 * ## The same feature, not a second one
 *
 * Every rule on this page is the server's: whether a tournament can be joined,
 * whether check-in is open, why a player is blocked, and which matches show
 * a room code. The page reads `viewer` and draws it. There is no local idea of
 * the tournament lifecycle here — that is exactly what the Flutter client
 * avoids too, and for the same reason: two implementations of a lifecycle is
 * one more than can ever be right.
 *
 * ## What it cannot do
 *
 * Create a tournament, add a bot, change a setting, or decide a match. Not
 * because a button is hidden — because `@/web/tournaments` has no such
 * function and the API has no such route.
 *
 * ## Entering a match
 *
 * The endpoint hands back a room code; the page routes to `/room/:code` and
 * lets the join machinery that page already owns seat the socket. One way into
 * a lobby rather than two that can disagree.
 */
export default function TournamentsPage() {
  const router = useRouter();
  const { session } = useGame();

  const [day, setDay] = useState<TournamentDayDto>({
    tournamentDate: '',
    timeZone: 'UTC',
    tournaments: [],
  });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      setDay(await fetchTournamentDay(session?.token ?? null));
    } catch (cause) {
      setError(
        cause instanceof ApiError
          ? cause.friendlyMessage
          : 'Could not load the tournaments.',
      );
    } finally {
      setLoading(false);
    }
  }, [session]);

  useEffect(() => {
    void load();
  }, [load]);

  /**
   * Live updates.
   *
   * The subscription is per *connection* on the server and does not survive a
   * reconnect, so it is re-sent on `connect` as well as on mount — a tab that
   * subscribed once would go quiet after its first dropped connection and
   * never notice, because the symptom is identical to a quiet hour.
   *
   * Every event is treated the same way: re-read the day. The payloads carry
   * enough to patch in place, and patching would mean a second model of the
   * lifecycle living in this file.
   */
  useEffect(() => {
    const socket = getSocket();
    if (!socket) return;

    const subscribe = () => emit(CLIENT_TOURNAMENT_WATCH);
    subscribe();
    socket.on('connect', subscribe);

    const names = Object.values(TOURNAMENT_EVENTS).map((entry) => entry.canonical);
    const onAny = () => void load();
    for (const name of names) socket.on(name, onAny);

    return () => {
      socket.off('connect', subscribe);
      for (const name of names) socket.off(name, onAny);
      emit(CLIENT_TOURNAMENT_UNWATCH);
    };
  }, [load]);

  /** Runs one write, then re-reads the day. */
  const act = useCallback(
    async (
      tournamentId: string,
      action: (token: string, id: string) => Promise<AutoTournamentDto>,
      success: string,
    ) => {
      if (!session) return;

      setBusyId(tournamentId);
      setNotice(null);
      setError(null);

      try {
        await action(session.token, tournamentId);
        setNotice(success);
        await load();
      } catch (cause) {
        // The server's own sentence. "Registration has closed for this
        // tournament" is the refusal a player would otherwise find baffling,
        // and it is a different sentence from the four other ways a join can
        // be refused.
        setError(
          cause instanceof ApiError ? cause.friendlyMessage : 'That did not work.',
        );
      } finally {
        setBusyId(null);
      }
    },
    [session, load],
  );

  const enter = useCallback(
    async (tournamentId: string, matchId: string) => {
      if (!session) return;

      setBusyId(tournamentId);
      try {
        const entry = await enterTournamentMatch(session.token, tournamentId, matchId);
        router.push(`/room/${entry.roomCode}`);
      } catch (cause) {
        setError(
          cause instanceof ApiError
            ? cause.friendlyMessage
            : 'Could not open that match.',
        );
        setBusyId(null);
      }
    },
    [session, router],
  );

  const empty = useMemo(() => day.tournaments.length === 0, [day]);

  return (
    <PageShell title="Tournaments">
      <p className="muted" style={{ marginTop: 0 }}>
        Three tournaments every day — morning, afternoon and evening. The server
        runs them: it publishes the schedule, fills short rosters with
        clearly-labelled AI players, draws the bracket and decides the matches.
        Join as many of the day&apos;s three as you like.
      </p>

      {notice ? <div className="banner banner--ok">{notice}</div> : null}

      <ListState
        loading={loading && empty}
        error={error && empty ? error : null}
        empty={false}
        emptyText=""
        onRetry={() => void load()}
      />

      {error && !empty ? (
        <div className="banner banner--error">{error}</div>
      ) : null}

      {!loading && empty ? (
        <div className="empty">
          <p style={{ marginTop: 0 }}>
            <strong>Nothing scheduled for today</strong>
          </p>
          <p className="muted">
            Tomorrow&apos;s three are published automatically.
          </p>
        </div>
      ) : null}

      {day.tournaments.map((tournament) => (
        <TournamentCard
          key={tournament.id}
          tournament={tournament}
          timeZone={day.timeZone}
          busy={busyId === tournament.id}
          expanded={openId === tournament.id}
          token={session?.token ?? null}
          onToggle={() =>
            setOpenId((current) => (current === tournament.id ? null : tournament.id))
          }
          onJoin={() =>
            void act(tournament.id, registerForTournament, 'You are in. Good luck!')
          }
          onWithdraw={() =>
            void act(
              tournament.id,
              withdrawFromTournament,
              'You have left the tournament.',
            )
          }
          onCheckIn={() =>
            void act(
              tournament.id,
              checkInToTournament,
              'Checked in. Your match is coming up.',
            )
          }
          onEnter={(matchId) => void enter(tournament.id, matchId)}
        />
      ))}
    </PageShell>
  );
}

/** One of the day's tournaments. */
function TournamentCard({
  tournament,
  timeZone,
  busy,
  expanded,
  token,
  onToggle,
  onJoin,
  onWithdraw,
  onCheckIn,
  onEnter,
}: {
  tournament: AutoTournamentDto;
  timeZone: string;
  busy: boolean;
  expanded: boolean;
  token: string | null;
  onToggle: () => void;
  onJoin: () => void;
  onWithdraw: () => void;
  onCheckIn: () => void;
  onEnter: (matchId: string) => void;
}) {
  const viewer = tournament.viewer;

  return (
    <section className="card">
      <div className="row">
        <div style={{ flex: 1 }}>
          <h2 style={{ margin: 0 }}>{tournament.name}</h2>
          <p className="muted" style={{ margin: '0.15rem 0 0' }}>
            {slotLabel(tournament.dailySlot)} ·{' '}
            {startClock(tournament.startAtMs, timeZone)} · Knockout · Free entry
          </p>
        </div>
        <StatusPill status={tournament.status} />
      </div>

      <PlayerCounts tournament={tournament} />

      {tournament.status === 'RUNNING' && tournament.totalRounds > 0 ? (
        <p className="muted" style={{ margin: '0.25rem 0 0' }}>
          Round {tournament.currentRound} of {tournament.totalRounds}
        </p>
      ) : null}

      <Countdown tournament={tournament} />

      {tournament.cancelReason ? (
        <p className="muted" style={{ margin: '0.5rem 0 0' }}>
          Cancelled: {tournament.cancelReason}
        </p>
      ) : null}

      {tournament.winner ? (
        <p style={{ margin: '0.5rem 0 0' }}>
          🏆 Winner: <strong>{tournament.winner.displayName}</strong>
          {tournament.winner.isBot ? ' 🤖' : ''}
        </p>
      ) : null}

      {viewer.blockedReason ? (
        <p className="muted" style={{ margin: '0.5rem 0 0' }}>
          {viewer.blockedReason}
        </p>
      ) : null}

      <div className="row" style={{ marginTop: '0.75rem', gap: '0.5rem' }}>
        {viewer.activeMatch ? (
          <button
            type="button"
            disabled={busy}
            onClick={() => onEnter(viewer.activeMatch!.matchId)}
          >
            Enter match
          </button>
        ) : viewer.canCheckIn ? (
          <button type="button" disabled={busy} onClick={onCheckIn}>
            Check in
          </button>
        ) : viewer.canRegister ? (
          <button type="button" disabled={busy} onClick={onJoin}>
            Join tournament
          </button>
        ) : viewer.isRegistered ? (
          <span className="muted">
            ✓ {viewer.isCheckedIn ? 'Checked in' : 'Registered'}
          </span>
        ) : null}

        {viewer.canWithdraw ? (
          <button type="button" className="btn--ghost" disabled={busy} onClick={onWithdraw}>
            Withdraw
          </button>
        ) : null}

        <span className="spacer" />

        <button type="button" className="btn--ghost" onClick={onToggle}>
          {expanded ? 'Hide' : tournament.totalRounds > 0 ? 'View bracket' : 'Details'}
        </button>
      </div>

      {/* Built only once opened, so three slots make no extra requests until
          somebody asks for one. */}
      {expanded && token ? (
        <TournamentDetail tournamentId={tournament.id} token={token} />
      ) : null}
    </section>
  );
}

/** The status pill. */
function StatusPill({ status }: { status: AutoTournamentDto['status'] }) {
  const label: Record<string, string> = {
    UPCOMING: 'Starting soon',
    REGISTRATION: 'Registration open',
    CHECK_IN: 'Check-in open',
    RUNNING: 'Running',
    COMPLETED: 'Completed',
    CANCELLED: 'Cancelled',
  };

  return <span className="pill">{label[status] ?? status}</span>;
}

/**
 * How full a tournament is.
 *
 * Never one total. "3 / 4" on a tournament that is one person and two robots
 * would be true and misleading at once, which is the specific thing the
 * product forbids — so the human count leads and the AI count sits beside it.
 */
function PlayerCounts({ tournament }: { tournament: AutoTournamentDto }) {
  return (
    <p className="muted" style={{ margin: '0.5rem 0 0' }}>
      <strong>{tournament.humanPlayerCount}</strong> player
      {tournament.humanPlayerCount === 1 ? '' : 's'}
      {tournament.botPlayerCount > 0 ? (
        <> · 🤖 {tournament.botPlayerCount} AI</>
      ) : null}
      {' · '}
      {tournament.totalPlayers} of {tournament.minPlayers}–{tournament.maxPlayers}
    </p>
  );
}

/**
 * A live countdown to whichever deadline the tournament is waiting on.
 *
 * Computed from an absolute server timestamp, so it needs no network at all —
 * asking the server every second for a number the browser can work out would
 * be the worst possible use of a socket connection.
 */
function Countdown({ tournament }: { tournament: AutoTournamentDto }) {
  const deadline =
    tournament.status === 'REGISTRATION'
      ? tournament.registrationCloseAtMs
      : tournament.status === 'CHECK_IN'
        ? tournament.checkInCloseAtMs
        : null;

  const [, tick] = useState(0);

  useEffect(() => {
    if (deadline === null) return;
    const timer = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(timer);
  }, [deadline]);

  if (deadline === null) return null;

  const left = Math.max(0, deadline - Date.now());
  const minutes = Math.floor(left / 60_000);
  const seconds = Math.floor((left % 60_000) / 1000);

  return (
    <p className="muted" style={{ margin: '0.25rem 0 0' }}>
      {tournament.status === 'REGISTRATION' ? 'Registration closes in ' : 'Check-in closes in '}
      {minutes}:{String(seconds).padStart(2, '0')}
    </p>
  );
}

/** The roster and the draw, loaded on demand. */
function TournamentDetail({
  tournamentId,
  token,
}: {
  tournamentId: string;
  token: string;
}) {
  const [participants, setParticipants] = useState<TournamentParticipantDto[]>([]);
  const [bracket, setBracket] = useState<TournamentBracketDto | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    void (async () => {
      setLoading(true);
      try {
        const [roster, draw] = await Promise.all([
          fetchTournamentParticipants(token, tournamentId),
          fetchTournamentBracket(token, tournamentId),
        ]);
        if (cancelled) return;
        setParticipants(roster);
        setBracket(draw);
      } catch (cause) {
        if (cancelled) return;
        setError(
          cause instanceof ApiError
            ? cause.friendlyMessage
            : 'Could not load the tournament.',
        );
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [tournamentId, token]);

  if (loading) return <p className="empty">Loading…</p>;
  if (error) return <p className="empty">{error}</p>;

  return (
    <div style={{ marginTop: '0.75rem' }}>
      <h3 style={{ marginBottom: '0.35rem' }}>Players</h3>
      {participants.map((player) => (
        <PlayerRow key={player.registrationId} player={player} />
      ))}

      {bracket && bracket.rounds.length > 0 ? (
        <>
          <h3 style={{ margin: '0.75rem 0 0.35rem' }}>Bracket</h3>
          {bracket.rounds.map((round) => (
            <div key={round.roundNumber} style={{ marginBottom: '0.6rem' }}>
              <p
                className="muted"
                style={{
                  margin: '0 0 0.25rem',
                  fontWeight: round.roundNumber === bracket.currentRound ? 700 : 400,
                }}
              >
                {round.name}
              </p>
              {round.matches.map((match) => (
                <div
                  key={match.matchId}
                  className="card card--tight"
                  style={{ marginBottom: '0.35rem' }}
                >
                  <MatchSeat
                    player={match.playerA}
                    score={match.status === 'COMPLETED' ? match.scoreA : null}
                    won={match.winnerRegistrationId === match.playerA?.registrationId}
                  />
                  <MatchSeat
                    player={match.playerB}
                    score={match.status === 'COMPLETED' ? match.scoreB : null}
                    won={match.winnerRegistrationId === match.playerB?.registrationId}
                  />
                  {match.outcome === 'BYE' || match.outcome === 'WALKOVER' ? (
                    <p className="muted" style={{ margin: 0, textAlign: 'right' }}>
                      {match.outcome === 'BYE' ? 'Bye' : 'Walkover'}
                    </p>
                  ) : null}
                </div>
              ))}
            </div>
          ))}
        </>
      ) : null}
    </div>
  );
}

/**
 * One entrant.
 *
 * The AI badge is drawn from the server's own `isBot`, never inferred. A
 * client that renders what it was given is correct by default.
 */
function PlayerRow({ player }: { player: TournamentParticipantDto }) {
  return (
    <div className="row" style={{ gap: '0.5rem', padding: '0.15rem 0' }}>
      {player.isBot ? (
        <span aria-hidden style={{ fontSize: '1.25rem', lineHeight: 1 }}>
          🤖
        </span>
      ) : (
        <Avatar name={player.displayName} colorIndex={player.avatarColorIndex} size="1.6rem" />
      )}
      <span
        style={{
          flex: 1,
          fontWeight: player.isSelf ? 700 : 400,
          textDecoration: player.status === 'ELIMINATED' ? 'line-through' : undefined,
          opacity: player.status === 'ELIMINATED' ? 0.6 : 1,
        }}
      >
        {player.displayName}
        {player.isBot ? (
          <span className="muted">
            {' '}
            — AI Player{player.botDifficulty ? ` · ${player.botDifficulty}` : ''}
          </span>
        ) : null}
      </span>
      {player.seed !== null ? <span className="muted">#{player.seed}</span> : null}
      {player.status === 'WINNER' ? <span aria-hidden>🏆</span> : null}
    </div>
  );
}

/** One seat of a pairing, or the fact that it is not decided yet. */
function MatchSeat({
  player,
  score,
  won,
}: {
  player: TournamentParticipantDto | null;
  score: number | null;
  won: boolean;
}) {
  if (!player) {
    return (
      <p className="muted" style={{ margin: 0 }}>
        To be decided
      </p>
    );
  }

  return (
    <div className="row" style={{ gap: '0.4rem' }}>
      <span style={{ flex: 1, fontWeight: won ? 700 : 400 }}>
        {player.isBot ? '🤖 ' : ''}
        {player.displayName}
      </span>
      {score !== null ? <span className="muted">{score}</span> : null}
      {won ? <span aria-hidden>✓</span> : null}
    </div>
  );
}

/** "Morning", "Afternoon", "Evening". */
function slotLabel(slot: AutoTournamentDto['dailySlot']): string {
  switch (slot) {
    case 'MORNING':
      return 'Morning';
    case 'AFTERNOON':
      return 'Afternoon';
    case 'EVENING':
      return 'Evening';
    default:
      return 'Daily';
  }
}

/**
 * The start time, in the schedule's own zone rather than the browser's.
 *
 * A player in another timezone reading "20:00" off their own clock would turn
 * up four hours late. The zone comes down with the listing for exactly this,
 * and is shown alongside so the number is unambiguous.
 */
function startClock(startAtMs: number, timeZone: string): string {
  if (!startAtMs) return '';

  try {
    return new Intl.DateTimeFormat('en-GB', {
      timeZone,
      hour: '2-digit',
      minute: '2-digit',
      timeZoneName: 'short',
    }).format(new Date(startAtMs));
  } catch {
    // An unknown zone name should cost a label, not the page.
    return new Date(startAtMs).toLocaleTimeString();
  }
}
