'use client';

import type { ConnectionState, GameFailure } from '@/web/GameProvider';

/**
 * The small pieces every screen shares.
 *
 * Avatar colours are indexed rather than free-form because the account carries
 * an `avatarColorIndex`, not a colour — the Flutter app and this client have to
 * agree on what index 3 looks like, so the palette is a fixed list of the same
 * length as the server's `avatarColorCount`.
 */

/*
 * The same eight accents, in the same order, as `AppColors.avatarPalette` in
 * the Flutter client. The order is on the wire — an index is persisted with
 * the profile and broadcast to every other player — so an entry may be
 * recoloured but never moved, and the two clients must not disagree about it.
 */
const AVATAR_COLORS = [
  '#ff5a5f',
  '#4d8bff',
  '#ffc53d',
  '#2fd07b',
  '#9b5cff',
  '#ff8a3d',
  '#ff5ca2',
  '#00cfc1',
];

/**
 * A colour index for something that has no `avatarColorIndex` of its own.
 *
 * A public room row shows its host, but the browser listing deliberately
 * carries no avatar fields — it is the one payload a stranger reads, so it
 * holds the minimum. Hashing the id keeps one host the same colour on every
 * render and in every list, which is the only property the avatar needs.
 */
export function colorIndexFor(seed: string): number {
  let hash = 0;
  for (let index = 0; index < seed.length; index += 1) {
    hash = (hash * 31 + seed.charCodeAt(index)) | 0;
  }
  return Math.abs(hash);
}

export function Avatar({
  name,
  colorIndex,
  size = '2rem',
}: {
  name: string;
  colorIndex: number;
  size?: string;
}) {
  const background = AVATAR_COLORS[colorIndex % AVATAR_COLORS.length];
  const initial = name.trim().charAt(0).toUpperCase() || '?';

  return (
    <span className="avatar" style={{ background, width: size, height: size }} aria-hidden="true">
      {initial}
    </span>
  );
}

/** Whether the realtime connection is up, shown independently of API health. */
export function ConnectionPill({ state }: { state: ConnectionState }) {
  const label: Record<ConnectionState, string> = {
    idle: 'Offline',
    connecting: 'Connecting',
    connected: 'Live',
    disconnected: 'Reconnecting',
  };

  const modifier =
    state === 'connected' ? 'connected' : state === 'connecting' ? 'connecting' : 'disconnected';

  return (
    <span className="pill">
      <span className={`dot dot--${modifier}`} />
      {label[state]}
    </span>
  );
}

/**
 * Shows a failure, with the server's own code beside it outside production.
 *
 * The code is the difference between a report that can be acted on and one
 * that cannot: `ROOM_NOT_FOUND` and `NOT_ROOM_MEMBER` produce the same
 * sentence to a player and completely different next steps to a developer. It
 * is hidden in production builds, where it is noise.
 */
export function FailureBanner({
  failure,
  onDismiss,
}: {
  failure: GameFailure | null;
  onDismiss?: () => void;
}) {
  if (!failure) return null;

  const showDetail = process.env.NODE_ENV !== 'production';
  const detail = [failure.code, failure.status ? `HTTP ${failure.status}` : null]
    .filter(Boolean)
    .join(' · ');

  return (
    <div className="banner banner--error" role="alert">
      <div className="row">
        <span>{failure.message}</span>
        {onDismiss ? (
          <>
            <span className="spacer" />
            <button type="button" className="btn--ghost" onClick={onDismiss}>
              Dismiss
            </button>
          </>
        ) : null}
      </div>
      {showDetail && detail ? <code>{detail}</code> : null}
    </div>
  );
}

/** A non-fatal announcement: the room closed, you were removed. */
export function NoticeBanner({
  notice,
  onDismiss,
}: {
  notice: string | null;
  onDismiss?: () => void;
}) {
  if (!notice) return null;

  return (
    <div className="banner banner--info" role="status">
      <div className="row">
        <span>{notice}</span>
        {onDismiss ? (
          <>
            <span className="spacer" />
            <button type="button" className="btn--ghost" onClick={onDismiss}>
              Dismiss
            </button>
          </>
        ) : null}
      </div>
    </div>
  );
}
