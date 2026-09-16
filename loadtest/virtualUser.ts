import { io, type Socket } from 'socket.io-client';

import { describe, type Recorder } from './recorder';

/**
 * One simulated player: a REST identity plus a websocket (brief section 12).
 *
 * ## Why this drives the real protocol rather than a synthetic one
 *
 * A load test that invents its own traffic measures the load generator. This
 * one signs in through `POST /api/auth/guest`, connects with the token it got
 * back, says `c:hello` and then emits the same events the Flutter client
 * emits, in the same shapes, with the same ack expectations. What it therefore
 * exercises is the rate limiters, the validators, the room registry and the
 * broadcast fan-out as they actually are.
 *
 * ## Why each virtual user presents a distinct `x-forwarded-for`
 *
 * `guestLogin` is limited to a burst of five per *identity*, and an
 * unauthenticated caller's identity is their address. A hundred virtual users
 * signing in from one machine would therefore be refused after the fifth —
 * which is the limiter working correctly, and would measure nothing but the
 * limiter.
 *
 * A hundred real players are a hundred addresses, so each virtual user claims
 * one. `clientIdentity` reads `x-forwarded-for`'s first entry exactly as it
 * would behind a reverse proxy. This is not a way around a protection: it is
 * how the test reproduces the condition the protection was sized for. The
 * limiter is verified separately, on purpose, by the abuse scenario.
 */

export interface VirtualUserOptions {
  apiUrl: string;
  socketUrl: string;
  recorder: Recorder;
  /** Index in the run, used for the name and the claimed address. */
  index: number;
}

export interface AckEnvelope {
  ok: boolean;
  error?: { code?: string; message?: string };
  [key: string]: unknown;
}

/** How long an ack may take before the test calls it a failure. */
const ACK_TIMEOUT_MS = 10_000;

export class VirtualUser {
  readonly index: number;
  readonly username: string;
  /** The address this user claims, so each gets its own rate-limit bucket. */
  readonly address: string;

  private readonly apiUrl: string;
  private readonly socketUrl: string;
  private readonly recorder: Recorder;

  token: string | null = null;
  userId: string | null = null;
  socket: Socket | null = null;
  roomId: string | null = null;
  roomCode: string | null = null;
  /**
   * Whether the server made this user the drawer of the current turn.
   *
   * Set by the scenario that starts matches, and read by the two scenarios
   * whose permissions depend on it: only the drawer may draw, and only a
   * guesser may join voice. Without it both scenarios pick an arbitrary seat
   * and measure the server correctly refusing them.
   */
  isDrawer = false;

  /** Users this one is now friends with, so the invite scenario can pick one. */
  readonly friendIds: string[] = [];

  /** Server events seen, by name, so a scenario can assert fan-out. */
  readonly received = new Map<string, number>();
  /** The most recent payload per event, for scenarios that need to read one. */
  readonly last = new Map<string, unknown>();

  /** Resolvers waiting on a named event. */
  private readonly waiters = new Map<string, Array<(payload: unknown) => void>>();

  constructor(options: VirtualUserOptions) {
    this.index = options.index;
    this.apiUrl = options.apiUrl.replace(/\/+$/, '');
    this.socketUrl = options.socketUrl.replace(/\/+$/, '');
    this.recorder = options.recorder;

    // Within the client's own 2..16 character limit.
    this.username = `lt${String(options.index).padStart(4, '0')}`;

    // 10.x.x.x is private space, so this never collides with a real address
    // that might legitimately appear in a log.
    const octet = (shift: number): number => ((options.index >> shift) & 0xff) || 1;
    this.address = `10.${octet(16)}.${octet(8)}.${octet(0)}`;
  }

  // ------------------------------------------------------------------ REST --

  /**
   * A REST call, timed and recorded.
   *
   * Every response is read to completion even when the body is not wanted:
   * an undrained body holds the socket open, and a few hundred of those is a
   * load generator that runs out of file descriptors before the server does.
   */
  async api<T = unknown>(
    operation: string,
    path: string,
    init: RequestInit = {},
  ): Promise<T | null> {
    return this.recorder.time(operation, async () => {
      const headers: Record<string, string> = {
        'content-type': 'application/json',
        'x-forwarded-for': this.address,
        ...((init.headers as Record<string, string>) ?? {}),
      };
      if (this.token) headers.authorization = `Bearer ${this.token}`;

      const response = await fetch(`${this.apiUrl}${path}`, {
        ...init,
        headers,
        signal: AbortSignal.timeout(ACK_TIMEOUT_MS),
      });

      const body = (await response.json().catch(() => null)) as
        | { success?: boolean; data?: T; error?: { code?: string; message?: string } }
        | null;

      if (!response.ok || body?.success === false) {
        throw new Error(
          `HTTP ${response.status} ${body?.error?.code ?? ''} ${body?.error?.message ?? ''}`.trim(),
        );
      }

      return (body?.data ?? null) as T;
    });
  }

  /** Signs in as a guest, keeping the token for the socket handshake. */
  async signIn(): Promise<boolean> {
    const data = await this.api<{ token: string; user: { id: string } }>(
      'rest.auth.guest',
      '/api/auth/guest',
      {
        method: 'POST',
        body: JSON.stringify({
          username: this.username,
          avatarId: this.index % 18,
          avatarColorIndex: this.index % 8,
        }),
      },
    );

    if (!data?.token) return false;

    this.token = data.token;
    this.userId = data.user.id;
    return true;
  }

  // ---------------------------------------------------------------- socket --

  /**
   * Opens the websocket and completes the handshake.
   *
   * `websocket` only, matching the Flutter client, so the measurement is of
   * the transport players actually use rather than of a polling fallback.
   * Socket.IO's own reconnection is left off: a scenario that wants to test
   * reconnecting does it explicitly, and automatic retries underneath would
   * make a connection failure invisible to the report.
   */
  async connect(): Promise<boolean> {
    if (!this.token) return false;

    const result = await this.recorder.time('socket.connect', async () => {
      const socket = io(this.socketUrl, {
        transports: ['websocket'],
        auth: { token: this.token },
        reconnection: false,
        timeout: ACK_TIMEOUT_MS,
        forceNew: true,
      });

      this.socket = socket;
      this.observeEvents(socket);

      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('connect timeout')), ACK_TIMEOUT_MS);

        socket.once('connect', () => {
          clearTimeout(timer);
          resolve();
        });
        socket.once('connect_error', (error: Error) => {
          clearTimeout(timer);
          reject(error);
        });
      });

      return true;
    });

    return result === true;
  }

  /** Records every inbound event, and wakes anything waiting on one. */
  private observeEvents(socket: Socket): void {
    socket.onAny((event: string, payload: unknown) => {
      this.received.set(event, (this.received.get(event) ?? 0) + 1);
      this.last.set(event, payload);
      this.recorder.increment(`event.${event}`);

      const waiting = this.waiters.get(event);
      if (waiting && waiting.length > 0) {
        this.waiters.set(event, []);
        for (const resolve of waiting) resolve(payload);
      }
    });

    socket.on('disconnect', (reason: string) => {
      this.recorder.increment(`socket.disconnect.${reason}`);
    });
  }

  /**
   * Emits an event and awaits its ack, recording the round trip.
   *
   * A refusal the server meant to send — room full, rate limited — is recorded
   * as a failure of *this operation*, which is what makes the error column in
   * the report meaningful: a race scenario expects some of these and says so,
   * while a throughput scenario expecting none is failing if it sees any.
   */
  async emit(operation: string, event: string, payload: unknown = {}): Promise<AckEnvelope | null> {
    const socket = this.socket;
    if (!socket?.connected) {
      this.recorder.fail(operation, 'socket not connected');
      return null;
    }

    return this.recorder.time(operation, async () => {
      const ack = await new Promise<AckEnvelope>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('ack timeout')), ACK_TIMEOUT_MS);

        socket.emit(event, payload, (response: AckEnvelope) => {
          clearTimeout(timer);
          resolve(response ?? { ok: false, error: { message: 'empty ack' } });
        });
      });

      if (!ack.ok) {
        throw new Error(`${ack.error?.code ?? 'error'}: ${ack.error?.message ?? ''}`.trim());
      }

      return ack;
    });
  }

  /**
   * Emits without awaiting an ack.
   *
   * The drawing relay is deliberately ack-free — a round trip per stroke batch
   * would be the latency the batching exists to avoid — so measuring it means
   * measuring arrival at the *other* clients, which the drawing scenario does.
   */
  fire(event: string, payload: unknown): void {
    if (!this.socket?.connected) return;
    this.socket.emit(event, payload);
  }

  /** Completes the `c:hello` handshake, restoring a seat if one is held. */
  async hello(): Promise<AckEnvelope | null> {
    return this.emit('socket.hello', 'c:hello', {
      username: this.username,
      avatarId: this.index % 18,
      avatarColorIndex: this.index % 8,
      t0: Date.now(),
    });
  }

  /** Resolves with the next occurrence of an event, or null on timeout. */
  async waitFor(event: string, timeoutMs = 5000): Promise<unknown | null> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(null), timeoutMs);

      const waiting = this.waiters.get(event) ?? [];
      waiting.push((payload) => {
        clearTimeout(timer);
        resolve(payload);
      });
      this.waiters.set(event, waiting);
    });
  }

  /** Remembers the room an ack just seated this user in. */
  noteRoom(ack: AckEnvelope | null): void {
    const room = (ack?.room ?? null) as { id?: string; code?: string } | null;
    if (!room) return;
    this.roomId = room.id ?? this.roomId;
    this.roomCode = room.code ?? this.roomCode;
  }

  /** Closes the socket. Idempotent. */
  disconnect(): void {
    try {
      this.socket?.removeAllListeners();
      this.socket?.disconnect();
    } catch (error) {
      this.recorder.fail('socket.disconnect', describe(error));
    }
    this.socket = null;
  }
}
