'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useState, type FormEvent } from 'react';

import { useGame } from '@/web/GameProvider';
import { ConnectionPill, FailureBanner, NoticeBanner } from '@/web/components/ui';
import type { RoomSettingsDto } from '@/web/types';

/**
 * The home screen: sign in, then open a room or join one.
 *
 * ## Why signing in happens here and not on demand
 *
 * Both buttons need an authenticated socket, and the socket's identity is
 * fixed at its handshake. Authenticating as a side effect of the first click
 * would mean the connection opens and the create request races it. Doing it
 * when the name is submitted gives the websocket the time it takes the player
 * to pick their settings, and leaves both buttons with a connection already up.
 */

/** The bounds the server clamps to, mirrored so the sliders cannot exceed them. */
const LIMITS = {
  maxPlayers: { min: 2, max: 12 },
  rounds: { min: 1, max: 10 },
  drawTimeSeconds: { min: 30, max: 180 },
  wordChoiceCount: { min: 2, max: 5 },
  hintCount: { min: 0, max: 5 },
  wordSelectSeconds: { min: 5, max: 30 },
} as const;

/** The server's defaults, so an untouched form sends what it would have used. */
const DEFAULT_SETTINGS = {
  maxPlayers: 8,
  rounds: 3,
  drawTimeSeconds: 80,
  wordChoiceCount: 3,
  hintCount: 2,
  wordSelectSeconds: 15,
  wordMode: 'normal',
  language: 'en',
  isPrivate: false,
} satisfies Partial<RoomSettingsDto>;

const NAME_KEY = 'sg.web.name';

export default function HomePage() {
  const router = useRouter();
  const {
    session,
    connection,
    busy,
    failure,
    notice,
    invitations,
    unreadNotifications,
    signIn,
    createRoom,
    joinRoom,
    clearFailure,
    clearNotice,
  } = useGame();

  const [name, setName] = useState('');
  const [settings, setSettings] = useState<Partial<RoomSettingsDto>>(DEFAULT_SETTINGS);
  const [joinCode, setJoinCode] = useState('');

  // Restores the last name used, so a returning player does not retype it.
  useEffect(() => {
    try {
      setName(window.localStorage.getItem(NAME_KEY) ?? '');
    } catch {
      /* Storage is optional here. */
    }
  }, []);

  const set = <K extends keyof RoomSettingsDto>(key: K, value: RoomSettingsDto[K]) =>
    setSettings((current) => ({ ...current, [key]: value }));

  async function handleSignIn(event: FormEvent) {
    event.preventDefault();
    const trimmed = name.trim();
    if (trimmed.length < 2) return;

    try {
      window.localStorage.setItem(NAME_KEY, trimmed);
    } catch {
      /* As above. */
    }

    await signIn(trimmed).catch(() => {
      // The failure is already on screen through the provider; swallowing the
      // rejection here only stops it reaching the console as unhandled.
    });
  }

  async function handleCreate() {
    try {
      const room = await createRoom(settings);
      router.push(`/room/${room.code}`);
    } catch {
      /* Shown by the banner. */
    }
  }

  async function handleJoin(event: FormEvent) {
    event.preventDefault();
    const code = joinCode.trim().toUpperCase();
    if (code.length !== 5) return;

    try {
      const room = await joinRoom(code);
      router.push(`/room/${room.code}`);
    } catch {
      /* Shown by the banner. */
    }
  }

  return (
    <main className="page page--narrow">
      <div className="brand">
        <h1>Scribble &amp; Guess</h1>
        <span>web</span>
        <span className="spacer" />
        {session ? <ConnectionPill state={connection} /> : null}
      </div>

      <NoticeBanner notice={notice} onDismiss={clearNotice} />
      <FailureBanner failure={failure} onDismiss={clearFailure} />

      {!session ? (
        <form className="card" onSubmit={handleSignIn}>
          <h2>Who are you?</h2>
          <div className="field">
            <label htmlFor="name">Display name</label>
            <input
              id="name"
              type="text"
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="2–16 characters"
              maxLength={16}
              autoFocus
            />
          </div>
          <button type="submit" className="btn--primary btn--block" disabled={busy || name.trim().length < 2}>
            {busy ? 'Signing in…' : 'Continue'}
          </button>
          <p className="muted" style={{ fontSize: '0.8rem', marginBottom: 0 }}>
            A guest account is created for you. No password, no email.
          </p>
        </form>
      ) : (
        <>
          {/*
            * Browsing and invitations sit above the create form, because both
            * are ways into a room that already has people in it — which is the
            * better outcome for somebody who just wants to play, and the same
            * reasoning that puts Quick Play above Create in the Flutter app.
            */}
          <div className="card">
            <div className="row row--wrap">
              <button type="button" onClick={() => router.push('/rooms')}>
                Browse public rooms
              </button>
              <button type="button" onClick={() => router.push('/rooms/invitations')}>
                Invitations
                {invitations.length > 0 ? (
                  <span className="count-badge">{invitations.length}</span>
                ) : null}
              </button>
              <button type="button" onClick={() => router.push('/friends')}>
                Friends
              </button>
              {/*
                * The count is the server's, taken from the last page read or
                * the last push — never arithmetic on the previous value. See
                * `unreadNotifications` in the provider for why.
                */}
              <button type="button" onClick={() => router.push('/achievements')}>
                Achievements
              </button>
              <button type="button" onClick={() => router.push('/notifications')}>
                Notifications
                {unreadNotifications > 0 ? (
                  <span className="count-badge">
                    {unreadNotifications > 99 ? '99+' : unreadNotifications}
                  </span>
                ) : null}
              </button>
            </div>
          </div>

          <div className="card">
            <h2>New room</h2>

            <div className="grid-2">
              <Slider
                id="maxPlayers"
                label="Players"
                value={settings.maxPlayers ?? DEFAULT_SETTINGS.maxPlayers}
                bounds={LIMITS.maxPlayers}
                onChange={(value) => set('maxPlayers', value)}
              />
              <Slider
                id="rounds"
                label="Rounds"
                value={settings.rounds ?? DEFAULT_SETTINGS.rounds}
                bounds={LIMITS.rounds}
                onChange={(value) => set('rounds', value)}
              />
              <Slider
                id="drawTimeSeconds"
                label="Draw time"
                suffix="s"
                value={settings.drawTimeSeconds ?? DEFAULT_SETTINGS.drawTimeSeconds}
                bounds={LIMITS.drawTimeSeconds}
                step={10}
                onChange={(value) => set('drawTimeSeconds', value)}
              />
              <Slider
                id="wordChoiceCount"
                label="Words to choose from"
                value={settings.wordChoiceCount ?? DEFAULT_SETTINGS.wordChoiceCount}
                bounds={LIMITS.wordChoiceCount}
                onChange={(value) => set('wordChoiceCount', value)}
              />
              <Slider
                id="hintCount"
                label="Hints"
                value={settings.hintCount ?? DEFAULT_SETTINGS.hintCount}
                bounds={LIMITS.hintCount}
                onChange={(value) => set('hintCount', value)}
              />
              <Slider
                id="wordSelectSeconds"
                label="Word pick time"
                suffix="s"
                value={settings.wordSelectSeconds ?? DEFAULT_SETTINGS.wordSelectSeconds}
                bounds={LIMITS.wordSelectSeconds}
                onChange={(value) => set('wordSelectSeconds', value)}
              />
            </div>

            <div className="grid-2">
              <div className="field">
                <label htmlFor="wordMode">Word mode</label>
                <select
                  id="wordMode"
                  value={settings.wordMode ?? 'normal'}
                  onChange={(event) =>
                    set('wordMode', event.target.value as RoomSettingsDto['wordMode'])
                  }
                >
                  <option value="normal">Normal</option>
                  <option value="hidden">Hidden</option>
                  <option value="combination">Combination</option>
                </select>
              </div>

              <div className="field">
                <label htmlFor="language">Language</label>
                <select
                  id="language"
                  value={settings.language ?? 'en'}
                  onChange={(event) =>
                    set('language', event.target.value as RoomSettingsDto['language'])
                  }
                >
                  <option value="en">English</option>
                  <option value="ml">Malayalam</option>
                  <option value="hi">Hindi</option>
                  <option value="de">German</option>
                  <option value="ja">Japanese</option>
                  <option value="ru">Russian</option>
                  <option value="es">Spanish</option>
                  <option value="fr">French</option>
                </select>
              </div>
            </div>

            <label className="row" style={{ marginBottom: '1rem' }}>
              <input
                type="checkbox"
                checked={settings.isPrivate ?? false}
                onChange={(event) => set('isPrivate', event.target.checked)}
                style={{ width: 'auto' }}
              />
              <span>Private — keep this room out of Quick Play</span>
            </label>

            <button
              type="button"
              className="btn--primary btn--block"
              onClick={handleCreate}
              disabled={busy}
            >
              {busy ? 'Creating…' : 'Create room'}
            </button>
          </div>

          <form className="card" onSubmit={handleJoin}>
            <h2>Join a room</h2>
            <div className="row">
              <input
                type="text"
                value={joinCode}
                onChange={(event) => setJoinCode(event.target.value.toUpperCase())}
                placeholder="ABCDE"
                maxLength={5}
                style={{ letterSpacing: '0.3em', fontFamily: 'ui-monospace, monospace' }}
                aria-label="Room code"
              />
              <button type="submit" disabled={busy || joinCode.trim().length !== 5}>
                Join
              </button>
            </div>
          </form>

          <p className="muted" style={{ fontSize: '0.8rem' }}>
            Playing as <strong>{session.user.username}</strong>. Share a room code with the Flutter
            app to play across devices.
          </p>
        </>
      )}
    </main>
  );
}

/** One labelled range input, with its current value shown beside the label. */
function Slider({
  id,
  label,
  value,
  bounds,
  onChange,
  step = 1,
  suffix = '',
}: {
  id: string;
  label: string;
  value: number;
  bounds: { min: number; max: number };
  onChange: (value: number) => void;
  step?: number;
  suffix?: string;
}) {
  return (
    <div className="field">
      <label htmlFor={id}>
        {label}
        <span className="field__value">
          {value}
          {suffix}
        </span>
      </label>
      <input
        id={id}
        type="range"
        min={bounds.min}
        max={bounds.max}
        step={step}
        value={value}
        onChange={(event) => onChange(Number(event.target.value))}
      />
    </div>
  );
}
