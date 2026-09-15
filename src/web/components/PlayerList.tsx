'use client';

import { Avatar } from '@/web/components/ui';
import type { PlayerDto } from '@/web/types';

/**
 * The room's seats.
 *
 * The same list serves the lobby and the game; what changes is which badge
 * matters. In the lobby that is readiness, in a turn it is who holds the pen
 * and who has already guessed, so both are rendered and the irrelevant one is
 * simply never set by the server.
 */
export function PlayerList({
  players,
  hostId,
  selfId,
  showScores = false,
}: {
  players: PlayerDto[];
  hostId: string;
  selfId: string | null;
  showScores?: boolean;
}) {
  // Sorted by score while a game is running, and left in seat order before it,
  // where score is zero for everybody and sorting would only shuffle names.
  const ordered = showScores ? [...players].sort((a, b) => b.score - a.score) : players;

  return (
    <ul className="players">
      {ordered.map((player) => {
        const classes = ['player'];
        if (player.isDrawing) classes.push('player--drawing');
        else if (player.hasGuessed) classes.push('player--guessed');

        return (
          <li key={player.id} className={classes.join(' ')}>
            <Avatar name={player.name} colorIndex={player.avatarColorIndex} />

            <span>
              {player.name}
              {player.id === selfId ? <span className="muted"> (you)</span> : null}
            </span>

            <span className="spacer" />

            {player.id === hostId ? <span title="Host">👑</span> : null}
            {player.isDrawing ? <span title="Drawing">✏️</span> : null}
            {player.hasGuessed ? <span title="Guessed it">✅</span> : null}
            {!showScores && player.isReady ? <span title="Ready">🟢</span> : null}
            {player.connection !== 'connected' ? (
              <span title={player.connection} className="muted">
                ⚠︎
              </span>
            ) : null}

            {showScores ? <span className="player__score">{player.score}</span> : null}
          </li>
        );
      })}
    </ul>
  );
}
