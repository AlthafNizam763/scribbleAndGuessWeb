'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';

import { ApiError } from '@/web/api';
import {
  deleteNotification as deleteNotificationRequest,
  fetchNotifications,
  markAllNotificationsRead as markAllNotificationsReadRequest,
  markNotificationRead as markNotificationReadRequest,
  type NotificationDto,
} from '@/web/notifications';
import {
  acceptInvitation as acceptInvitationRequest,
  fetchInvitations,
  rejectInvitation as rejectInvitationRequest,
  sendInvite,
} from '@/web/rooms';
import { ensureSession, profileOf, signOut } from '@/web/session';
import {
  SocketError,
  connectSocket,
  disconnectSocket,
  emit,
  getSocket,
  request,
} from '@/web/socket';
import type {
  ChatMessageDto,
  GameResultDto,
  GameStateDto,
  PointTuple,
  RoomDto,
  RoomInvitationDto,
  RoomSettingsDto,
  RoundResultDto,
  Session,
  StrokeDto,
  WordItemDto,
} from '@/web/types';

/**
 * The one place the web client holds live game state.
 *
 * ## Why a single provider rather than a store per feature
 *
 * Every screen in this game reads the same room. The lobby needs the player
 * list, the board needs it to label strokes, the scoreboard needs it, and all
 * three must agree the instant `s:room:state` lands. Splitting that across
 * stores would mean three subscriptions to one broadcast and three chances for
 * one of them to miss it.
 *
 * ## The server is the only authority
 *
 * Nothing here decides anything. Every action is a socket request whose ack or
 * subsequent broadcast produces the new state, which is what keeps this client
 * and the Flutter app describing the same game — both are only rendering what
 * the server told them.
 *
 * The one deliberate exception is the drawer's own strokes. Those are applied
 * locally as they are drawn, because the server relays them with
 * `emitToRoomExcept` — the author is excluded on purpose, since a pen that
 * waited for a round trip would feel broken. Undo, redo and clear are not
 * exceptions: the server broadcasts those to everyone including the author, so
 * they are applied only when it says so.
 */

/** Where the connection is. Distinct from whether the API is reachable. */
export type ConnectionState = 'idle' | 'connecting' | 'connected' | 'disconnected';

/** A failure worth showing, with enough detail to act on in development. */
export interface GameFailure {
  message: string;
  /** The server's own code, when it gave one. */
  code?: string;
  /** HTTP status, for REST failures. */
  status?: number;
}

interface GameContextValue {
  session: Session | null;
  connection: ConnectionState;
  /** True while signing in, creating or joining. */
  busy: boolean;
  room: RoomDto | null;
  game: GameStateDto | null;
  chat: ChatMessageDto[];
  wordChoices: WordItemDto[];
  roundResult: RoundResultDto | null;
  gameResult: GameResultDto | null;
  strokes: StrokeDto[];
  failure: GameFailure | null;
  /** A non-fatal announcement: the room closed, you were kicked. */
  notice: string | null;

  /**
   * The caller's unanswered room invitations.
   *
   * Held here rather than in the page that lists them because three places
   * need it at once: the inbox, the count on the home screen, and the toast
   * that interrupts for a new one. A per-page fetch would mean the badge only
   * updated on the page that could already see the list.
   */
  invitations: RoomInvitationDto[];
  /** The newest unanswered invitation, for the toast. Null once dismissed. */
  incomingInvitation: RoomInvitationDto | null;

  /**
   * The caller's notifications, newest first.
   *
   * Held here for the same reason `invitations` is: the centre lists them, the
   * home screen counts them, and a per-page fetch would mean the badge only
   * updated on the page that could already see the list.
   */
  notifications: NotificationDto[];
  /**
   * How many are unread.
   *
   * Always the server's figure — from the last page read or the last push —
   * never arithmetic on the previous value. A tab that decremented its own
   * counter would drift the first time it missed a push, and nothing would
   * ever correct it.
   */
  unreadNotifications: number;

  signIn: (name: string) => Promise<Session>;
  createRoom: (settings: Partial<RoomSettingsDto>) => Promise<RoomDto>;
  joinRoom: (code: string) => Promise<RoomDto>;
  leaveRoom: () => Promise<void>;
  setReady: (ready: boolean) => Promise<void>;
  startGame: () => Promise<void>;
  playAgain: () => Promise<void>;
  selectWord: (index: number) => Promise<void>;
  sendChat: (text: string) => Promise<void>;

  beginStroke: (stroke: StrokeDto) => void;
  appendStroke: (strokeId: string, points: PointTuple[]) => void;
  endStroke: (strokeId: string) => void;
  undo: () => void;
  redo: () => void;
  clearBoard: () => void;

  /** Asks one friend to join the given room. */
  inviteFriend: (roomId: string, friendId: string) => Promise<void>;
  /** Accepts an invitation and enters the room, returning its code. */
  acceptInvitation: (invitation: RoomInvitationDto) => Promise<string>;
  /** Declines an invitation. */
  rejectInvitation: (invitation: RoomInvitationDto) => Promise<void>;
  /** Re-reads the inbox. */
  refreshInvitations: () => Promise<void>;
  /** Dismisses the toast without answering; the invitation stays in the inbox. */
  dismissIncoming: () => void;

  /** Re-reads the notification centre. */
  refreshNotifications: () => Promise<void>;
  /** Marks one notification read. */
  markNotificationRead: (notificationId: string) => Promise<void>;
  /** Marks the whole backlog read. */
  markAllNotificationsRead: () => Promise<void>;
  /** Deletes one notification. */
  deleteNotification: (notificationId: string) => Promise<void>;

  clearFailure: () => void;
  clearNotice: () => void;
}

const GameContext = createContext<GameContextValue | null>(null);

/** Reads the live game state. Throws outside the provider, which is a bug. */
export function useGame(): GameContextValue {
  const value = useContext(GameContext);
  if (!value) throw new Error('useGame must be used inside <GameProvider>.');
  return value;
}

const DEBUG = process.env.NODE_ENV !== 'production';

/** Development trace. Never given a token, and never given the answer. */
function log(message: string, detail?: unknown): void {
  if (!DEBUG) return;
  if (detail === undefined) console.info(`[Web Game] ${message}`);
  else console.info(`[Web Game] ${message}`, detail);
}

/** Turns anything thrown by the API or the socket into something displayable. */
function toFailure(error: unknown): GameFailure {
  if (error instanceof ApiError) {
    return { message: error.friendlyMessage, code: error.code, status: error.status };
  }
  if (error instanceof SocketError) {
    return { message: error.message, code: error.code };
  }
  if (error instanceof Error) return { message: error.message };
  return { message: 'Something went wrong.' };
}

export function GameProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [connection, setConnection] = useState<ConnectionState>('idle');
  const [busy, setBusy] = useState(false);
  const [room, setRoom] = useState<RoomDto | null>(null);
  const [game, setGame] = useState<GameStateDto | null>(null);
  const [chat, setChat] = useState<ChatMessageDto[]>([]);
  const [wordChoices, setWordChoices] = useState<WordItemDto[]>([]);
  const [roundResult, setRoundResult] = useState<RoundResultDto | null>(null);
  const [gameResult, setGameResult] = useState<GameResultDto | null>(null);
  const [strokes, setStrokes] = useState<StrokeDto[]>([]);
  const [failure, setFailure] = useState<GameFailure | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [invitations, setInvitations] = useState<RoomInvitationDto[]>([]);
  const [incomingInvitation, setIncomingInvitation] =
    useState<RoomInvitationDto | null>(null);
  const [notifications, setNotifications] = useState<NotificationDto[]>([]);
  const [unreadNotifications, setUnreadNotifications] = useState(0);

  // Held in a ref as well as in state because the action callbacks below are
  // memoised, and would otherwise keep reading the session from the render
  // that created them.
  const sessionRef = useRef<Session | null>(null);
  sessionRef.current = session;

  /**
   * Re-reads the invitations inbox.
   *
   * Defined before the listener effect below because that effect calls it on
   * every invitation push. The REST read is authoritative: a pushed payload is
   * enough to raise a toast immediately, but what the inbox renders is always
   * what the server just said, so a missed push costs a refresh and nothing
   * else.
   */
  const refreshInvitations = useCallback(async () => {
    const current = sessionRef.current;
    if (!current) return;

    try {
      const page = await fetchInvitations(current.token);
      setInvitations(page.items ?? []);
    } catch (error) {
      // A failed inbox read is not worth a banner over whatever the player is
      // doing — the list simply stays as it was, and the next push or page
      // open re-reads it.
      log('invitations refresh failed', toFailure(error).code);
    }
  }, []);

  /**
   * Re-reads the notification centre.
   *
   * Both the rows and the count come from this one response, so the badge and
   * the list can never disagree about what is unread — which they would if the
   * count were derived from the rows this page happens to hold. The list is
   * one page; the count is over the whole inbox.
   */
  const refreshNotifications = useCallback(async () => {
    const current = sessionRef.current;
    if (!current) return;

    try {
      const page = await fetchNotifications(current.token);
      setNotifications(page.items ?? []);
      setUnreadNotifications(page.unreadCount ?? 0);
    } catch (error) {
      // Same as the inbox above: a failed read is not worth a banner over
      // whatever the player is doing. The next push or page open re-reads it.
      log('notifications refresh failed', toFailure(error).code);
    }
  }, []);

  /** Everything that belongs to one room, dropped on leaving it. */
  const resetRoomState = useCallback(() => {
    setRoom(null);
    setGame(null);
    setChat([]);
    setWordChoices([]);
    setRoundResult(null);
    setGameResult(null);
    setStrokes([]);
  }, []);

  // ---------------------------------------------------------------- listeners

  /**
   * Wires the server pushes onto state.
   *
   * Re-run whenever the session changes, because a new session means a new
   * socket and the old listeners belong to a connection that is gone.
   */
  useEffect(() => {
    if (!session) return undefined;

    const socket = connectSocket(session.token);
    setConnection(socket.connected ? 'connected' : 'connecting');

    const onConnect = async () => {
      setConnection('connected');
      try {
        // The handshake carried the identity; this carries the display
        // profile, and it has to land before any seat is cut or the lobby
        // shows the placeholder name the account was created with.
        await request('c:hello', { profile: profileOf(session.user) });
        log('handshake complete');
      } catch (error) {
        log('handshake failed', toFailure(error).code);
      }
    };

    const onDisconnect = () => setConnection('disconnected');

    const onConnectError = (error: Error) => {
      setConnection('disconnected');
      // The handshake middleware rejects with these before any handler runs,
      // so a bad token surfaces here rather than on an ack.
      if (error.message === 'AUTH_REQUIRED' || error.message === 'AUTH_FAILED') {
        signOut();
        setSession(null);
        setFailure({
          message: 'Your session is no longer valid. Reload the page to sign in again.',
          code: error.message,
        });
        return;
      }
      setFailure({
        message: `Cannot reach the game server: ${error.message}`,
        code: 'connect_error',
      });
    };

    socket.on('connect', onConnect);
    socket.on('disconnect', onDisconnect);
    socket.on('connect_error', onConnectError);

    socket.on('s:room:state', (payload: { room: RoomDto }) => {
      if (payload?.room) setRoom(payload.room);
    });

    socket.on('s:game:state', (payload: { game: GameStateDto }) => {
      if (payload?.game) setGame(payload.game);
    });

    socket.on('s:game:roundStart', (payload: { game: GameStateDto }) => {
      if (payload?.game) setGame(payload.game);
      // A new turn starts on a clean board, and clears the previous turn's
      // scoreboard which is otherwise still on screen.
      setStrokes([]);
      setRoundResult(null);
      setWordChoices([]);
    });

    socket.on('s:game:wordChoices', (payload: { choices: WordItemDto[] }) => {
      setWordChoices(payload?.choices ?? []);
    });

    socket.on('s:game:hint', (payload: { hintIndices: number[]; maskedWord: string }) => {
      setGame((current) =>
        current
          ? { ...current, hintIndices: payload.hintIndices, maskedWord: payload.maskedWord }
          : current,
      );
    });

    socket.on('s:game:roundEnd', (payload: { result: RoundResultDto; game: GameStateDto }) => {
      if (payload?.result) setRoundResult(payload.result);
      if (payload?.game) setGame(payload.game);
      setWordChoices([]);
    });

    socket.on('s:game:end', (payload: { result: GameResultDto }) => {
      if (payload?.result) setGameResult(payload.result);
      setWordChoices([]);
    });

    socket.on('s:chat:message', (payload: { message: ChatMessageDto }) => {
      if (!payload?.message) return;
      setChat((current) => {
        const next = [...current, payload.message];
        // The server keeps 200 lines; keeping more here would only grow the
        // DOM for messages nobody will scroll back to.
        return next.length > 200 ? next.slice(next.length - 200) : next;
      });
    });

    // --------------------------------------------------------------- drawing

    socket.on('s:draw:snapshot', (payload: { strokes: StrokeDto[] }) => {
      // Sent on connect and after a reconnect: the whole board, so a late
      // joiner sees what has already been drawn this turn.
      setStrokes(payload?.strokes ?? []);
    });

    socket.on('s:draw:begin', (payload: { stroke: StrokeDto }) => {
      if (payload?.stroke) setStrokes((current) => [...current, payload.stroke]);
    });

    socket.on('s:draw:append', (payload: { strokeId: string; points: PointTuple[] }) => {
      setStrokes((current) =>
        current.map((stroke) =>
          stroke.id === payload.strokeId
            ? { ...stroke, p: [...stroke.p, ...payload.points] }
            : stroke,
        ),
      );
    });

    socket.on('s:draw:undo', (payload: { strokeId: string }) => {
      setStrokes((current) => current.filter((stroke) => stroke.id !== payload.strokeId));
    });

    socket.on('s:draw:redo', (payload: { stroke: StrokeDto }) => {
      if (payload?.stroke) setStrokes((current) => [...current, payload.stroke]);
    });

    socket.on('s:draw:clear', () => setStrokes([]));

    // ------------------------------------------------------ room departures

    socket.on('s:room:closed', (payload: { reason?: string }) => {
      resetRoomState();
      setNotice(payload?.reason ?? 'The room was closed.');
    });

    socket.on('s:you:kicked', (payload: { reason?: string }) => {
      resetRoomState();
      setNotice(payload?.reason ?? 'You were removed from the room.');
    });

    // ------------------------------------------------------- invitations

    socket.on(
      's:room:invitationReceived',
      (payload: { invitation?: RoomInvitationDto }) => {
        const invitation = payload?.invitation;
        if (!invitation?.id) return;

        // Raised from the pushed payload rather than after a REST round trip:
        // a toast that waited would arrive a beat late, or not at all on a
        // poor connection. The inbox re-reads underneath it regardless, and
        // that read is what wins if the two ever differ.
        setIncomingInvitation(invitation);
        void refreshInvitations();
      },
    );

    // Somebody answered an invitation *this* player sent. Nothing to show —
    // the room's own player list already says whether they arrived — but the
    // inbox is re-read because an accept can also retire rows in it.
    socket.on('s:room:invitationAccepted', () => void refreshInvitations());
    socket.on('s:room:invitationRejected', () => void refreshInvitations());
    socket.on('s:room:invitationExpired', () => void refreshInvitations());

    // ------------------------------------------------------ notifications

    /**
     * A notification was written for this player.
     *
     * The count is taken from the payload so the badge moves immediately, and
     * the list is re-read underneath — the same arrangement the invitation
     * push uses, and for the same reason: what the centre renders is always
     * the REST read, and that read wins wherever the two differ.
     */
    socket.on(
      's:notification:new',
      (payload: { notification?: NotificationDto; unreadCount?: number }) => {
        if (typeof payload?.unreadCount === 'number') {
          setUnreadNotifications(payload.unreadCount);
        }
        void refreshNotifications();
      },
    );

    /**
     * The count changed with no new row — this player read or deleted
     * something on another device.
     *
     * The list is re-read as well as the count, because "read on the phone"
     * has to stop the row rendering as unread here too.
     */
    socket.on('s:notification:unread', (payload: { unreadCount?: number }) => {
      if (typeof payload?.unreadCount === 'number') {
        setUnreadNotifications(payload.unreadCount);
      }
      void refreshNotifications();
    });

    // ---------------------------------------------------- room membership

    // The brief's `room:player_joined` / `room:player_left`. The room snapshot
    // on `s:room:state` is still what renders the list; these only drive the
    // line in the log, so they are deliberately not used to mutate `room`.
    socket.on('s:room:playerJoined', (payload: { player?: { name?: string } }) => {
      const name = payload?.player?.name;
      if (name) log('player joined', name);
    });

    socket.on('s:room:playerLeft', (payload: { username?: string }) => {
      if (payload?.username) log('player left', payload.username);
    });

    socket.on('s:room:error', (payload: { code?: string; message?: string }) => {
      if (payload?.message) setFailure({ message: payload.message, code: payload.code });
    });

    socket.on('s:error', (payload: { error?: { code?: string; message?: string } }) => {
      // Out-of-band failures: something the server refused that was not tied
      // to a request we are awaiting.
      const error = payload?.error;
      if (error?.message) setFailure({ message: error.message, code: error.code });
    });

    return () => {
      socket.off('connect', onConnect);
      socket.off('disconnect', onDisconnect);
      socket.off('connect_error', onConnectError);
      socket.removeAllListeners();
    };
  }, [session, resetRoomState, refreshInvitations, refreshNotifications]);

  /**
   * Reads the inbox once a session exists.
   *
   * Separate from the socket effect on purpose: an invitation sent while this
   * tab was closed is waiting in the inbox and no push will ever arrive for
   * it, so the badge has to come from a read rather than from the connection.
   */
  useEffect(() => {
    if (!session) {
      setInvitations([]);
      setIncomingInvitation(null);
      setNotifications([]);
      setUnreadNotifications(0);
      return;
    }
    void refreshInvitations();
    // The same argument as the inbox: everything that happened while this tab
    // was closed is sitting in the notification collection, and no push will
    // ever arrive for it. The badge has to come from a read.
    void refreshNotifications();
  }, [session, refreshInvitations, refreshNotifications]);

  /** Closes the connection when the app unmounts. */
  useEffect(() => () => disconnectSocket(), []);

  // ------------------------------------------------------------------ actions

  const signIn = useCallback(async (name: string): Promise<Session> => {
    setBusy(true);
    setFailure(null);
    try {
      log('authenticating');
      const next = await ensureSession(name.trim());
      setSession(next);
      log('authenticated');
      return next;
    } catch (error) {
      const failed = toFailure(error);
      log('authentication failed', failed.code);
      setFailure(failed);
      throw error;
    } finally {
      setBusy(false);
    }
  }, []);

  /**
   * Waits for the socket to be usable.
   *
   * Creating a room is the first thing a player does, and the button is live
   * the moment the name is accepted — which can be before the websocket has
   * finished opening. Without this the first click would fail with "not
   * connected" and the second would work, which reads as a flaky button.
   */
  const awaitConnection = useCallback(async (): Promise<void> => {
    const socket = getSocket();
    if (!socket) throw new SocketError('Not connected to the game server.', 'noConnection');
    if (socket.connected) return;

    await new Promise<void>((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timer);
        socket.off('connect', onConnect);
        socket.off('connect_error', onError);
      };
      const onConnect = () => {
        cleanup();
        resolve();
      };
      const onError = (error: Error) => {
        cleanup();
        reject(new SocketError(error.message, 'connect_error'));
      };
      const timer = setTimeout(() => {
        cleanup();
        reject(new SocketError('Could not reach the game server.', 'timeout'));
      }, 15_000);

      socket.on('connect', onConnect);
      socket.on('connect_error', onError);
    });
  }, []);

  const createRoom = useCallback(
    async (settings: Partial<RoomSettingsDto>): Promise<RoomDto> => {
      setBusy(true);
      setFailure(null);
      try {
        await awaitConnection();
        log('creating room');

        // The same payload the Flutter client sends: settings plus the display
        // profile, in one request whose ack carries the room back.
        const ack = await request<{ room: RoomDto }>('c:room:create', {
          settings,
          profile: sessionRef.current ? profileOf(sessionRef.current.user) : undefined,
        });

        if (!ack.room) {
          throw new SocketError('The server created a room but sent none back.', 'badAck');
        }

        log('room created', ack.room.code);
        setRoom(ack.room);
        setChat([]);
        setStrokes([]);
        return ack.room;
      } catch (error) {
        const failed = toFailure(error);
        log('create room failed', failed.code);
        setFailure(failed);
        throw error;
      } finally {
        setBusy(false);
      }
    },
    [awaitConnection],
  );

  const joinRoom = useCallback(
    async (code: string): Promise<RoomDto> => {
      setBusy(true);
      setFailure(null);
      try {
        await awaitConnection();
        log('joining room');

        const ack = await request<{ room: RoomDto }>('c:room:join', {
          code: code.trim().toUpperCase(),
          profile: sessionRef.current ? profileOf(sessionRef.current.user) : undefined,
        });

        if (!ack.room) throw new SocketError('The server sent no room back.', 'badAck');

        log('room joined', ack.room.code);
        setRoom(ack.room);
        setStrokes([]);
        return ack.room;
      } catch (error) {
        const failed = toFailure(error);
        log('join room failed', failed.code);
        setFailure(failed);
        throw error;
      } finally {
        setBusy(false);
      }
    },
    [awaitConnection],
  );

  const leaveRoom = useCallback(async () => {
    try {
      await request('c:room:leave');
    } catch (error) {
      // Leaving a room the server already removed us from is not a failure
      // worth stopping on: the intent was to end up outside it, and we are.
      log('leave refused', toFailure(error).code);
    } finally {
      resetRoomState();
    }
  }, [resetRoomState]);

  const setReady = useCallback(async (ready: boolean) => {
    try {
      await request('c:room:ready', { ready });
    } catch (error) {
      setFailure(toFailure(error));
    }
  }, []);

  const startGame = useCallback(async () => {
    setFailure(null);
    try {
      log('starting game');
      await request('c:game:start');
    } catch (error) {
      setFailure(toFailure(error));
    }
  }, []);

  /**
   * Restarts the match with the same players.
   *
   * A separate event from `c:game:start`, not a convenience alias: the room is
   * sitting in `final_result` with scores on it, and this is what resets them
   * and deals a new turn order. Starting would be refused from that phase.
   */
  const playAgain = useCallback(async () => {
    setFailure(null);
    try {
      log('play again');
      await request('c:game:playAgain');
      setGameResult(null);
      setRoundResult(null);
    } catch (error) {
      setFailure(toFailure(error));
    }
  }, []);

  const selectWord = useCallback(async (index: number) => {
    try {
      await request('c:game:selectWord', { index });
      setWordChoices([]);
    } catch (error) {
      setFailure(toFailure(error));
    }
  }, []);

  const sendChat = useCallback(async (text: string) => {
    const trimmed = text.trim();
    if (!trimmed) return;
    try {
      await request('c:chat:send', { text: trimmed });
    } catch (error) {
      setFailure(toFailure(error));
    }
  }, []);

  // ------------------------------------------------------------------ drawing

  const beginStroke = useCallback((stroke: StrokeDto) => {
    setStrokes((current) => [...current, stroke]);
    emit('c:draw:begin', { stroke });
  }, []);

  const appendStroke = useCallback((strokeId: string, points: PointTuple[]) => {
    if (points.length === 0) return;
    setStrokes((current) =>
      current.map((stroke) =>
        stroke.id === strokeId ? { ...stroke, p: [...stroke.p, ...points] } : stroke,
      ),
    );
    emit('c:draw:append', { strokeId, points });
  }, []);

  const endStroke = useCallback((strokeId: string) => {
    emit('c:draw:end', { strokeId });
  }, []);

  // These three are not applied locally: the server broadcasts them back to
  // the author too, and guessing at the outcome would drift the board.
  const undo = useCallback(() => emit('c:draw:undo'), []);
  const redo = useCallback(() => emit('c:draw:redo'), []);
  const clearBoard = useCallback(() => emit('c:draw:clear'), []);

  // ------------------------------------------------------------- invitations

  /**
   * Invites a friend to a room.
   *
   * Over the socket when one is open — the inviter is almost always sitting in
   * the lobby, and the ack returns without a second HTTP round trip — and over
   * REST otherwise. Both reach the same server service, so the rules cannot
   * differ; only the transport does.
   */
  const inviteFriend = useCallback(async (roomId: string, friendId: string) => {
    const current = sessionRef.current;
    if (!current) throw new SocketError('Sign in first.', 'noSession');

    const socket = getSocket();

    if (socket?.connected) {
      await request('c:room:invite', { friendId });
      return;
    }

    await sendInvite(current.token, roomId, friendId);
  }, []);

  /**
   * Accepts an invitation and returns the room code to navigate to.
   *
   * The REST call seats the account; the caller then routes to `/room/:code`,
   * where the existing join effect puts this *connection* in the room. Which
   * is the point of returning a code rather than a room: there is one way into
   * a lobby in this client, and this reuses it.
   *
   * Every refusal — `Room is full`, `Game already started`, `Invitation
   * expired` — comes back from that call and is thrown for the caller to show.
   */
  const acceptInvitation = useCallback(
    async (invitation: RoomInvitationDto): Promise<string> => {
      const current = sessionRef.current;
      if (!current) throw new SocketError('Sign in first.', 'noSession');

      setBusy(true);
      setFailure(null);
      try {
        const data = await acceptInvitationRequest(current.token, invitation.id);
        setIncomingInvitation(null);
        // Optimistic only in that the server has already agreed: the row is
        // spent, and the refresh below would remove it anyway.
        setInvitations((rows) => rows.filter((row) => row.id !== invitation.id));
        return data.roomCode || data.room?.code || invitation.roomCode;
      } catch (error) {
        setFailure(toFailure(error));
        // Refused or expired, the invitation is spent either way, so the inbox
        // is re-read rather than left offering a button that will fail again.
        void refreshInvitations();
        throw error;
      } finally {
        setBusy(false);
      }
    },
    [refreshInvitations],
  );

  const rejectInvitation = useCallback(
    async (invitation: RoomInvitationDto) => {
      const current = sessionRef.current;
      if (!current) return;

      setIncomingInvitation(null);
      setInvitations((rows) => rows.filter((row) => row.id !== invitation.id));

      try {
        await rejectInvitationRequest(current.token, invitation.id);
      } catch (error) {
        setFailure(toFailure(error));
      } finally {
        void refreshInvitations();
      }
    },
    [refreshInvitations],
  );

  const dismissIncoming = useCallback(() => setIncomingInvitation(null), []);

  // ------------------------------------------------------------ notifications

  /**
   * Marks one notification read.
   *
   * The row settles here first — it has been opened, and the server is about
   * to agree — but the *count* is whatever the call returns. That asymmetry is
   * deliberate: a wrong row is visible and self-correcting on the next read, a
   * wrong badge is neither.
   */
  const markNotificationRead = useCallback(async (notificationId: string) => {
    const current = sessionRef.current;
    if (!current) return;

    setNotifications((rows) =>
      rows.map((row) =>
        row.id === notificationId && !row.isRead
          ? { ...row, isRead: true, readAtMs: Date.now() }
          : row,
      ),
    );

    try {
      setUnreadNotifications(await markNotificationReadRequest(current.token, notificationId));
    } catch (error) {
      // The server disagreed about the row, so re-read rather than leave it
      // looking read when it is not.
      log('mark read failed', toFailure(error).code);
      void refreshNotifications();
    }
  }, [refreshNotifications]);

  const markAllNotificationsRead = useCallback(async () => {
    const current = sessionRef.current;
    if (!current) return;

    try {
      setUnreadNotifications(await markAllNotificationsReadRequest(current.token));
      await refreshNotifications();
    } catch (error) {
      setFailure(toFailure(error));
    }
  }, [refreshNotifications]);

  /**
   * Deletes one notification.
   *
   * Removed from the list only once the server has confirmed. Unlike marking
   * read — which is recoverable and invisible if it fails — a row removed
   * optimistically and then refused would be gone from the screen while still
   * sitting in the inbox.
   */
  const deleteNotification = useCallback(async (notificationId: string) => {
    const current = sessionRef.current;
    if (!current) return;

    try {
      const unread = await deleteNotificationRequest(current.token, notificationId);
      setNotifications((rows) => rows.filter((row) => row.id !== notificationId));
      setUnreadNotifications(unread);
    } catch (error) {
      setFailure(toFailure(error));
    }
  }, []);

  const clearFailure = useCallback(() => setFailure(null), []);
  const clearNotice = useCallback(() => setNotice(null), []);

  const value = useMemo<GameContextValue>(
    () => ({
      session,
      connection,
      busy,
      room,
      game,
      chat,
      wordChoices,
      roundResult,
      gameResult,
      strokes,
      failure,
      notice,
      invitations,
      notifications,
      unreadNotifications,
      incomingInvitation,
      signIn,
      createRoom,
      joinRoom,
      leaveRoom,
      setReady,
      startGame,
      playAgain,
      selectWord,
      sendChat,
      beginStroke,
      appendStroke,
      endStroke,
      undo,
      redo,
      clearBoard,
      inviteFriend,
      acceptInvitation,
      rejectInvitation,
      refreshInvitations,
      refreshNotifications,
      markNotificationRead,
      markAllNotificationsRead,
      deleteNotification,
      dismissIncoming,
      clearFailure,
      clearNotice,
    }),
    [
      session,
      connection,
      busy,
      room,
      game,
      chat,
      wordChoices,
      roundResult,
      gameResult,
      strokes,
      failure,
      notice,
      invitations,
      notifications,
      unreadNotifications,
      incomingInvitation,
      signIn,
      createRoom,
      joinRoom,
      leaveRoom,
      setReady,
      startGame,
      playAgain,
      selectWord,
      sendChat,
      beginStroke,
      appendStroke,
      endStroke,
      undo,
      redo,
      clearBoard,
      inviteFriend,
      acceptInvitation,
      rejectInvitation,
      refreshInvitations,
      refreshNotifications,
      markNotificationRead,
      markAllNotificationsRead,
      deleteNotification,
      dismissIncoming,
      clearFailure,
      clearNotice,
    ],
  );

  return <GameContext.Provider value={value}>{children}</GameContext.Provider>;
}
