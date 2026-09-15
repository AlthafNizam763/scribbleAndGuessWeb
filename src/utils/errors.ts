/**
 * The error vocabulary shared by the REST and socket layers.
 *
 * Two audiences have to agree on these strings. The brief's section 70 names
 * the REST codes; the Flutter client's `AppErrorCode` names the ones it can
 * parse off a socket ack. They are not the same list, so `AppError` carries
 * both: `code` for HTTP bodies and `wireCode` for socket acks, derived from
 * one table so a handler only ever throws once and both surfaces stay right.
 */

/** REST error codes, exactly as listed in brief section 70. */
export const ErrorCode = {
  AUTH_ERROR: 'AUTH_ERROR',
  VALIDATION_ERROR: 'VALIDATION_ERROR',
  ROOM_NOT_FOUND: 'ROOM_NOT_FOUND',
  ROOM_FULL: 'ROOM_FULL',
  NOT_ROOM_MEMBER: 'NOT_ROOM_MEMBER',
  NOT_ROOM_OWNER: 'NOT_ROOM_OWNER',
  GAME_NOT_STARTED: 'GAME_NOT_STARTED',
  GAME_ALREADY_STARTED: 'GAME_ALREADY_STARTED',
  NOT_DRAWER: 'NOT_DRAWER',
  INVALID_WORD: 'INVALID_WORD',
  ROUND_ENDED: 'ROUND_ENDED',
  ALREADY_GUESSED: 'ALREADY_GUESSED',
  PLAYER_BANNED: 'PLAYER_BANNED',
  PLAYER_MUTED: 'PLAYER_MUTED',
  RATE_LIMITED: 'RATE_LIMITED',
  INTERNAL_ERROR: 'INTERNAL_ERROR',
  NOT_FOUND: 'NOT_FOUND',
  INVALID_ROOM_CODE: 'INVALID_ROOM_CODE',
  NAME_TAKEN: 'NAME_TAKEN',
  INVALID_ACTION: 'INVALID_ACTION',
  /**
   * The caller is the current drawer and asked for something in the voice
   * protocol. Spelled out as its own code rather than folded into
   * `NOT_DRAWER` — which means the opposite — because it is the one refusal
   * the voice feature exists to make, and a client (or a security test) has to
   * be able to tell it apart from "you are not allowed to draw".
   */
  DRAWER_VOICE_DISABLED: 'DRAWER_VOICE_DISABLED',
} as const;

export type ErrorCodeName = (typeof ErrorCode)[keyof typeof ErrorCode];

/**
 * `AppErrorCode` from `lib/core/errors/failure.dart`.
 *
 * The client parses an ack's `error.code` against this enum and falls back to
 * `unknown`, so sending a REST-flavoured code over a socket would degrade a
 * precise message ("that room is full") into a generic one.
 */
export type WireErrorCode =
  | 'unknown'
  | 'network'
  | 'timeout'
  | 'serverError'
  | 'connectionLost'
  | 'roomNotFound'
  | 'roomFull'
  | 'gameInProgress'
  | 'nameTaken'
  | 'invalidCode'
  | 'banned'
  | 'kicked'
  | 'notHost'
  | 'notDrawer'
  | 'invalidAction'
  | 'validation'
  | 'storage'
  | 'drawerVoiceDisabled';

interface CodeSpec {
  /** HTTP status this code answers with. */
  status: number;
  /** The `AppErrorCode` the Flutter client should see on a socket ack. */
  wire: WireErrorCode;
  /** Default human-readable message. */
  message: string;
}

const SPECS: Record<ErrorCodeName, CodeSpec> = {
  AUTH_ERROR: { status: 401, wire: 'invalidAction', message: 'Authentication required.' },
  VALIDATION_ERROR: { status: 422, wire: 'validation', message: 'That request is not valid.' },
  ROOM_NOT_FOUND: { status: 404, wire: 'roomNotFound', message: 'Room not found.' },
  ROOM_FULL: { status: 409, wire: 'roomFull', message: 'That room is full.' },
  NOT_ROOM_MEMBER: { status: 403, wire: 'invalidAction', message: 'You are not in that room.' },
  NOT_ROOM_OWNER: { status: 403, wire: 'notHost', message: 'Only the host can do that.' },
  GAME_NOT_STARTED: { status: 409, wire: 'invalidAction', message: 'The game has not started.' },
  GAME_ALREADY_STARTED: {
    status: 409,
    wire: 'gameInProgress',
    message: 'That game is already in progress.',
  },
  NOT_DRAWER: { status: 403, wire: 'notDrawer', message: 'Only the drawer can do that.' },
  INVALID_WORD: { status: 422, wire: 'invalidAction', message: 'That word is not on offer.' },
  ROUND_ENDED: { status: 409, wire: 'invalidAction', message: 'That round has ended.' },
  ALREADY_GUESSED: { status: 409, wire: 'invalidAction', message: 'You already guessed it.' },
  PLAYER_BANNED: { status: 403, wire: 'banned', message: 'You are banned from that room.' },
  PLAYER_MUTED: { status: 403, wire: 'invalidAction', message: 'You are muted in this room.' },
  RATE_LIMITED: { status: 429, wire: 'invalidAction', message: 'Slow down a moment.' },
  INTERNAL_ERROR: { status: 500, wire: 'serverError', message: 'Something went wrong.' },
  NOT_FOUND: { status: 404, wire: 'unknown', message: 'Not found.' },
  INVALID_ROOM_CODE: { status: 422, wire: 'invalidCode', message: 'That room code is not valid.' },
  NAME_TAKEN: { status: 409, wire: 'nameTaken', message: 'That name is already taken.' },
  INVALID_ACTION: { status: 409, wire: 'invalidAction', message: 'You cannot do that right now.' },
  DRAWER_VOICE_DISABLED: {
    status: 403,
    wire: 'drawerVoiceDisabled',
    message: 'Voice chat is off while you are drawing.',
  },
};

/** The shape of the `error` object in both REST bodies and socket acks. */
export interface ErrorPayload {
  code: string;
  message: string;
  details?: unknown;
}

/**
 * An error with a known code, safe to show a player.
 *
 * Anything that is *not* an `AppError` is treated as a bug by the error
 * middleware: it is logged with its stack and reported as `INTERNAL_ERROR`,
 * so an unexpected failure can never leak a stack trace or a Mongo message to
 * a client.
 */
export class AppError extends Error {
  readonly code: ErrorCodeName;
  readonly status: number;
  readonly wireCode: WireErrorCode;
  readonly details?: unknown;
  /** Marks errors that are expected in normal play and need no stack. */
  readonly expected: boolean;

  constructor(code: ErrorCodeName, message?: string, options?: { details?: unknown }) {
    const spec = SPECS[code];
    super(message ?? spec.message);
    this.name = 'AppError';
    this.code = code;
    this.status = spec.status;
    this.wireCode = spec.wire;
    this.details = options?.details;
    this.expected = spec.status < 500;
    Error.captureStackTrace?.(this, AppError);
  }

  /** The REST body's `error` object. */
  toPayload(): ErrorPayload {
    return {
      code: this.code,
      message: this.message,
      ...(this.details === undefined ? {} : { details: this.details }),
    };
  }

  /**
   * The socket ack's `error` object.
   *
   * Uses `wireCode` so the client's `Failure.fromJson` maps it to a real
   * `AppErrorCode` instead of collapsing to `unknown`. The REST code rides
   * along in `details` for debugging.
   */
  toWirePayload(): ErrorPayload {
    return {
      code: this.wireCode,
      message: this.message,
      details: { code: this.code, ...(this.details === undefined ? {} : { details: this.details }) },
    };
  }

  static isAppError(value: unknown): value is AppError {
    return value instanceof AppError;
  }
}

/** Shorthand constructors for the codes thrown most often. */
export const errors = {
  auth: (message?: string) => new AppError(ErrorCode.AUTH_ERROR, message),
  validation: (message?: string, details?: unknown) =>
    new AppError(ErrorCode.VALIDATION_ERROR, message, { details }),
  roomNotFound: (message?: string) => new AppError(ErrorCode.ROOM_NOT_FOUND, message),
  roomFull: (message?: string) => new AppError(ErrorCode.ROOM_FULL, message),
  notMember: (message?: string) => new AppError(ErrorCode.NOT_ROOM_MEMBER, message),
  notOwner: (message?: string) => new AppError(ErrorCode.NOT_ROOM_OWNER, message),
  notDrawer: (message?: string) => new AppError(ErrorCode.NOT_DRAWER, message),
  gameNotStarted: (message?: string) => new AppError(ErrorCode.GAME_NOT_STARTED, message),
  gameAlreadyStarted: (message?: string) => new AppError(ErrorCode.GAME_ALREADY_STARTED, message),
  invalidWord: (message?: string) => new AppError(ErrorCode.INVALID_WORD, message),
  roundEnded: (message?: string) => new AppError(ErrorCode.ROUND_ENDED, message),
  alreadyGuessed: (message?: string) => new AppError(ErrorCode.ALREADY_GUESSED, message),
  banned: (message?: string) => new AppError(ErrorCode.PLAYER_BANNED, message),
  muted: (message?: string) => new AppError(ErrorCode.PLAYER_MUTED, message),
  rateLimited: (message?: string) => new AppError(ErrorCode.RATE_LIMITED, message),
  internal: (message?: string) => new AppError(ErrorCode.INTERNAL_ERROR, message),
  notFound: (message?: string) => new AppError(ErrorCode.NOT_FOUND, message),
  invalidCode: (message?: string) => new AppError(ErrorCode.INVALID_ROOM_CODE, message),
  invalidAction: (message?: string) => new AppError(ErrorCode.INVALID_ACTION, message),
  drawerVoiceDisabled: (message?: string) =>
    new AppError(ErrorCode.DRAWER_VOICE_DISABLED, message),
};
