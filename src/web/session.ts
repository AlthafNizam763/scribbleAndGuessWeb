import { request } from '@/web/api';
import type { AuthUserDto, PlayerProfileDto, Session } from '@/web/types';

/**
 * Guest authentication, and the token that comes out of it.
 *
 * ## Why there is any auth here at all
 *
 * Every room action is authenticated. `requireUser` rejects a request with no
 * bearer token, and the socket's handshake middleware rejects a connection
 * with none before a single event is handled. A web client that skipped this
 * step would not get a confusing room — it would get `AUTH_REQUIRED` on
 * `connect_error` and nothing else, which is precisely the failure mode this
 * module exists to prevent.
 *
 * The Flutter app does the same thing at launch: create a guest, keep the
 * token, send it on the handshake. This mirrors that flow rather than
 * inventing a second one.
 *
 * ## Where the token is kept
 *
 * `localStorage`, so a reload does not strand the player in a room their
 * account still holds a seat in. It is never logged and never put in a URL.
 */

const TOKEN_KEY = 'sg.web.token';
const USER_KEY = 'sg.web.user';

/** Reads a key, tolerating a browser that refuses storage entirely. */
function read(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    // Private windows and blocked-cookie settings throw on access rather than
    // returning null. A player in one should still be able to play; they just
    // get a fresh guest account on every load.
    return null;
  }
}

function write(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    /* Storage is a convenience here, never a requirement. */
  }
}

function clear(key: string): void {
  try {
    window.localStorage.removeItem(key);
  } catch {
    /* As above. */
  }
}

/** The stored session, if there is a complete one. */
function storedSession(): Session | null {
  const token = read(TOKEN_KEY);
  const rawUser = read(USER_KEY);
  if (!token || !rawUser) return null;

  try {
    const user = JSON.parse(rawUser) as AuthUserDto;
    return user?.id ? { token, user } : null;
  } catch {
    return null;
  }
}

function persist(session: Session): Session {
  write(TOKEN_KEY, session.token);
  write(USER_KEY, JSON.stringify(session.user));
  return session;
}

/** Forgets the session. Used when the server says the token is no longer good. */
export function signOut(): void {
  clear(TOKEN_KEY);
  clear(USER_KEY);
}

/** Creates a guest account and returns its token. */
async function createGuest(username: string): Promise<Session> {
  const data = await request<{ token: string; user: AuthUserDto }>('/api/auth/guest', {
    method: 'POST',
    body: {
      username,
      // The two avatar fields have server-side defaults, but sending them
      // keeps this payload identical to the Flutter client's.
      avatarId: Math.floor(Math.random() * 18),
      avatarColorIndex: Math.floor(Math.random() * 8),
    },
  });

  return persist({ token: data.token, user: data.user });
}

/**
 * Returns a usable session, reusing the stored one when it is still valid.
 *
 * The stored token is confirmed against `/api/auth/session` rather than
 * trusted. A token that expired while the tab was closed would otherwise fail
 * later and further in — at `c:room:create`, where it reads as "create room is
 * broken" rather than "you need to sign in again".
 */
export async function ensureSession(preferredName: string): Promise<Session> {
  const stored = storedSession();

  if (stored) {
    try {
      const data = await request<{ user: AuthUserDto }>('/api/auth/session', {
        token: stored.token,
      });
      const session = persist({ token: stored.token, user: data.user ?? stored.user });
      return preferredName && preferredName !== session.user.username
        ? await renameSession(session, preferredName)
        : session;
    } catch {
      // Expired, revoked, or the account is gone. A new guest is the right
      // answer to all three, and it is what the player wanted anyway.
      signOut();
    }
  }

  return createGuest(preferredName);
}

/** Changes the display name on an existing account. */
export async function renameSession(session: Session, username: string): Promise<Session> {
  const data = await request<{ user: AuthUserDto }>('/api/users/me', {
    method: 'PATCH',
    token: session.token,
    body: { username },
  });

  return persist({ token: session.token, user: data.user ?? { ...session.user, username } });
}

/**
 * The display half of a session, in the shape the socket expects.
 *
 * The server ignores the `id` in favour of the token's subject, so this is
 * strictly display data — but it is what puts the player's chosen name on
 * their seat, and omitting it leaves the lobby showing the placeholder the
 * account was created with.
 */
export function profileOf(user: AuthUserDto): PlayerProfileDto {
  return {
    id: user.id,
    name: user.username,
    avatarId: user.avatarId,
    avatarColorIndex: user.avatarColorIndex,
  };
}
