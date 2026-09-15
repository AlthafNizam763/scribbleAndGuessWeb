'use client';

import { useState } from 'react';

import { useGame } from '@/web/GameProvider';
import { InviteFriendsModal } from '@/web/components/InviteFriendsModal';
import { PlayerList } from '@/web/components/PlayerList';
import type { RoomDto } from '@/web/types';

/**
 * The waiting room.
 *
 * ## Why Start is enabled rather than validated here
 *
 * The button is disabled only for the things this client can see without
 * guessing: you are not the host, or there is nobody else here yet. Everything
 * else — whether enough players are ready, whether the room is in a state that
 * can start — is checked by the server when the request lands, and its refusal
 * carries a message written for that exact case. Re-implementing those rules
 * here would produce a second opinion that could disagree with the only one
 * that matters.
 */
export function Lobby({ room }: { room: RoomDto }) {
  const { session, setReady, startGame, leaveRoom, busy } = useGame();
  const [copied, setCopied] = useState(false);
  const [inviting, setInviting] = useState(false);

  const selfId = session?.user.id ?? null;
  const self = room.players.find((player) => player.id === selfId) ?? null;
  const isHost = room.hostId === selfId;

  async function copyCode() {
    try {
      await navigator.clipboard.writeText(room.code);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      // Clipboard access is refused without a secure context or a gesture the
      // browser trusts. The code is on screen either way.
    }
  }

  return (
    <>
      <div className="card">
        <h2>Room code</h2>
        <div className="row row--wrap">
          <span className="code-chip">{room.code}</span>
          <button type="button" onClick={copyCode}>
            {copied ? 'Copied' : 'Copy'}
          </button>
          {/*
            * Offered to every member, not only the host: the server's rule is
            * that anybody seated in the room may invite, and a client that
            * hid this from non-hosts would be enforcing a stricter rule than
            * the one that actually exists. A full room is still allowed to
            * open the sheet — the rows inside it come back already marked
            * un-invitable, which explains why better than a missing button.
            */}
          <button type="button" onClick={() => setInviting(true)}>
            Invite friends
          </button>
          <span className="spacer" />
          <span className="muted">
            {room.players.length} / {room.settings.maxPlayers} players
          </span>
        </div>
        <p className="muted" style={{ fontSize: '0.85rem', marginBottom: 0 }}>
          Share this code. The Flutter app joins the same room with it.
        </p>
      </div>

      <div className="card">
        <h2>Players</h2>
        <PlayerList players={room.players} hostId={room.hostId} selfId={selfId} />
      </div>

      <div className="card">
        <h2>Settings</h2>
        <div className="grid-2 muted" style={{ fontSize: '0.9rem' }}>
          <div>Rounds: {room.settings.rounds}</div>
          <div>Draw time: {room.settings.drawTimeSeconds}s</div>
          <div>Word choices: {room.settings.wordChoiceCount}</div>
          <div>Hints: {room.settings.hintCount}</div>
          <div>Mode: {room.settings.wordMode}</div>
          <div>Language: {room.settings.language}</div>
        </div>
      </div>

      <div className="card">
        <div className="row row--wrap">
          <button
            type="button"
            className={self?.isReady ? '' : 'btn--primary'}
            onClick={() => setReady(!self?.isReady)}
            disabled={busy}
          >
            {self?.isReady ? 'Not ready' : 'Ready'}
          </button>

          {isHost ? (
            <button
              type="button"
              className="btn--primary"
              onClick={startGame}
              disabled={busy || room.players.length < 2}
            >
              Start game
            </button>
          ) : (
            <span className="muted">Waiting for the host to start.</span>
          )}

          <span className="spacer" />

          <button type="button" className="btn--danger" onClick={leaveRoom}>
            Leave
          </button>
        </div>

        {isHost && room.players.length < 2 ? (
          <p className="muted" style={{ fontSize: '0.85rem', margin: '0.75rem 0 0' }}>
            At least two players are needed to start.
          </p>
        ) : null}
      </div>

      {inviting ? (
        <InviteFriendsModal roomId={room.id} onClose={() => setInviting(false)} />
      ) : null}
    </>
  );
}
