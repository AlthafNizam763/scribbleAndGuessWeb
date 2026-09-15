'use client';

import { useEffect, useState } from 'react';

import { useGame } from '@/web/GameProvider';
import { ChatPanel } from '@/web/components/ChatPanel';
import { DrawCanvas } from '@/web/components/DrawCanvas';
import { PlayerList } from '@/web/components/PlayerList';
import { Avatar } from '@/web/components/ui';
import type { GameStateDto, RoomDto } from '@/web/types';

/**
 * The match.
 *
 * ## What this component is allowed to know
 *
 * `game.word` is populated for the drawer and, once the turn is over, for
 * everybody. For a guesser mid-turn it is null and `maskedWord` is all there
 * is. So the display reads whichever is present rather than choosing between
 * them by role: the server has already decided what this viewer may see, and
 * second-guessing it here is how an answer leaks.
 */
export function GameView({ room }: { room: RoomDto }) {
  const { session, game, wordChoices, roundResult, gameResult, selectWord, leaveRoom, playAgain } =
    useGame();

  const selfId = session?.user.id ?? null;
  const isDrawer = game?.drawerId != null && game.drawerId === selfId;
  const isHost = room.hostId === selfId;
  const drawer = room.players.find((player) => player.id === game?.drawerId) ?? null;

  const phase = game?.phase ?? 'waiting';
  const finished = phase === 'final_result' || gameResult != null;

  return (
    <div className="game-grid">
      <div>
        <div className="card">
          <h2>
            Round {game?.currentRound ?? 0} / {game?.totalRounds ?? room.settings.rounds}
          </h2>
          <PlayerList players={room.players} hostId={room.hostId} selfId={selfId} showScores />
        </div>

        <div className="card">
          <div className="row">
            <span className="code-chip" style={{ fontSize: '1rem' }}>
              {room.code}
            </span>
            <span className="spacer" />
            <button type="button" className="btn--danger" onClick={leaveRoom}>
              Leave
            </button>
          </div>
        </div>
      </div>

      <div>
        <div className="card">
          <div className="row" style={{ marginBottom: '0.75rem' }}>
            <div>
              <div className="word">{game?.word ?? game?.maskedWord ?? ''}</div>
              <div className="muted" style={{ fontSize: '0.82rem' }}>
                {isDrawer
                  ? 'You are drawing'
                  : drawer
                    ? `${drawer.name} is drawing`
                    : 'Waiting for the next turn'}
              </div>
            </div>
            <span className="spacer" />
            <Countdown game={game} />
          </div>

          <div style={{ position: 'relative' }}>
            <DrawCanvas canDraw={Boolean(isDrawer) && phase === 'drawing'} />

            {finished && gameResult ? (
              <div className="board__overlay">
                <div>
                  <h2>Final scores</h2>
                  <ul className="standings">
                    {gameResult.standings.map((entry) => (
                      <li key={entry.playerId} className="standing">
                        <span className="standing__rank">{entry.rank}</span>
                        <Avatar name={entry.name} colorIndex={entry.avatarColorIndex} />
                        <span>{entry.name}</span>
                        <span className="spacer" />
                        <strong>{entry.score}</strong>
                      </li>
                    ))}
                  </ul>
                  {isHost ? (
                    <button
                      type="button"
                      className="btn--primary"
                      style={{ marginTop: '1rem' }}
                      onClick={playAgain}
                    >
                      Play again
                    </button>
                  ) : null}
                </div>
              </div>
            ) : phase === 'round_result' && roundResult ? (
              <div className="board__overlay">
                <div>
                  <h2>
                    The word was <span style={{ color: 'var(--accent)' }}>{roundResult.word}</span>
                  </h2>
                  <ul className="standings" style={{ marginTop: '1rem' }}>
                    {room.players.map((player) => (
                      <li key={player.id} className="standing">
                        <Avatar name={player.name} colorIndex={player.avatarColorIndex} />
                        <span>{player.name}</span>
                        <span className="spacer" />
                        <span className="delta">
                          +{roundResult.scoreDeltas[player.id] ?? 0}
                        </span>
                        <strong>{roundResult.totals[player.id] ?? player.score}</strong>
                      </li>
                    ))}
                  </ul>
                </div>
              </div>
            ) : phase === 'word_selection' ? (
              <div className="board__overlay">
                {isDrawer ? (
                  <div>
                    <h2>Pick a word</h2>
                    <div className="choices">
                      {wordChoices.map((choice, index) => (
                        <button
                          key={`${choice.text}-${index}`}
                          type="button"
                          className="btn--primary"
                          onClick={() => selectWord(index)}
                        >
                          {choice.text}
                          <span className="muted" style={{ marginLeft: '0.5rem', fontWeight: 400 }}>
                            {choice.difficulty}
                          </span>
                        </button>
                      ))}
                    </div>
                  </div>
                ) : (
                  <p>{drawer ? `${drawer.name} is choosing a word…` : 'Choosing a word…'}</p>
                )}
              </div>
            ) : phase === 'starting' ? (
              <div className="board__overlay">
                <h2>Get ready…</h2>
              </div>
            ) : phase === 'paused' ? (
              <div className="board__overlay">
                <p>Paused — waiting for more players.</p>
              </div>
            ) : null}
          </div>
        </div>
      </div>

      <ChatPanel disabled={Boolean(isDrawer) && phase === 'drawing'} />
    </div>
  );
}

/**
 * Seconds left in the turn.
 *
 * `turnEndMs` is an absolute time on the server's clock, so this counts down
 * to it rather than from a duration. A client that started its own timer when
 * the round-start message arrived would be short by the latency of that
 * message, and would drift further every turn.
 */
function Countdown({ game }: { game: GameStateDto | null }) {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(timer);
  }, []);

  if (!game || !game.turnEndMs || game.phase !== 'drawing') return null;

  const remaining = Math.max(0, Math.ceil((game.turnEndMs - now) / 1000));
  const urgent = remaining <= 10;

  return (
    <span className="timer" style={{ color: urgent ? 'var(--bad)' : undefined }}>
      {remaining}s
    </span>
  );
}
