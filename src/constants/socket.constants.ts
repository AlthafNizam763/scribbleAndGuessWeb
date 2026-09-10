/**
 * Every Socket.IO event string, and the only place they are written down.
 *
 * ## Why these names and not the ones in the brief
 *
 * The Flutter client already speaks a protocol: `docs/CONTRACT.md` section 8
 * in the app repo defines it, `lib/core/constants/socket_events.dart` mirrors
 * it, and the four `socket_*_repository.dart` files are written against it.
 * Those `c:` / `s:` names are therefore canonical here — renaming them would
 * mean rewriting working client code, which the brief explicitly forbids.
 *
 * The brief's section 16 names are registered as aliases in `ALIASES` below
 * and dispatch to exactly the same handlers, so either vocabulary works on the
 * wire. New clients should prefer the canonical names.
 */

// ---------------------------------------------------------------------------
// Client -> server
// ---------------------------------------------------------------------------

/** Handshake carrying the local profile. Acks with the server clock. */
export const CLIENT_HELLO = 'c:hello';
/** Clock-offset probe. Acks with the send and server timestamps. */
export const CLIENT_TIME_PING = 'c:time:ping';
/** Creates a room from the given settings and profile. */
export const CLIENT_ROOM_CREATE = 'c:room:create';
/** Joins an existing room by code. */
export const CLIENT_ROOM_JOIN = 'c:room:join';
/** Leaves the current room. */
export const CLIENT_ROOM_LEAVE = 'c:room:leave';
/** Sets the ready flag of the calling player. */
export const CLIENT_ROOM_READY = 'c:room:ready';
/** Replaces the room settings. Host only. */
export const CLIENT_ROOM_SETTINGS = 'c:room:settings';
/** Removes a player from the room. Host only. */
export const CLIENT_ROOM_KICK = 'c:room:kick';
/** Removes a player and blocks them from rejoining. Host only. */
export const CLIENT_ROOM_BAN = 'c:room:ban';
/** Mutes or unmutes a player in chat. Host only. */
export const CLIENT_ROOM_MUTE = 'c:room:mute';
/** Hands the host role to another player. Host only. */
export const CLIENT_ROOM_TRANSFER_HOST = 'c:room:transferHost';
/** Casts a vote to kick a player. */
export const CLIENT_ROOM_VOTE_KICK = 'c:room:voteKick';
/** Reports a player with a free-form reason. */
export const CLIENT_ROOM_REPORT = 'c:room:report';
/** Starts the match. Host only. */
export const CLIENT_GAME_START = 'c:game:start';
/** Picks one of the offered words by index. Drawer only. */
export const CLIENT_GAME_SELECT_WORD = 'c:game:selectWord';
/** Restarts the match with the same players. Host only. */
export const CLIENT_GAME_PLAY_AGAIN = 'c:game:playAgain';
/** Announces the first points of a new stroke. No ack. */
export const CLIENT_DRAW_BEGIN = 'c:draw:begin';
/** Appends a batch of points to a live stroke. No ack. */
export const CLIENT_DRAW_APPEND = 'c:draw:append';
/** Ends a live stroke. No ack. */
export const CLIENT_DRAW_END = 'c:draw:end';
/** Undoes the last stroke of the drawer. No ack. */
export const CLIENT_DRAW_UNDO = 'c:draw:undo';
/** Redoes the last undone stroke of the drawer. No ack. */
export const CLIENT_DRAW_REDO = 'c:draw:redo';
/** Clears the board. No ack. */
export const CLIENT_DRAW_CLEAR = 'c:draw:clear';
/** Sends a chat message, which doubles as a guess while drawing. */
export const CLIENT_CHAT_SEND = 'c:chat:send';

// ---------------------------------------------------------------------------
// Server -> client
// ---------------------------------------------------------------------------

/** Full room snapshot after any membership or settings change. */
export const SERVER_ROOM_STATE = 's:room:state';
/** The room was closed, with a reason. */
export const SERVER_ROOM_CLOSED = 's:room:closed';
/** The recipient was kicked or banned, with a reason. */
export const SERVER_YOU_KICKED = 's:you:kicked';
/** Full game snapshot. The word is omitted for non-drawers. */
export const SERVER_GAME_STATE = 's:game:state';
/** The words the drawer may choose from. Drawer only. */
export const SERVER_GAME_WORD_CHOICES = 's:game:wordChoices';
/** A new turn started. */
export const SERVER_GAME_ROUND_START = 's:game:roundStart';
/** Extra letters were revealed in the masked word. */
export const SERVER_GAME_HINT = 's:game:hint';
/** The turn ended, carrying the round result and the new game state. */
export const SERVER_GAME_ROUND_END = 's:game:roundEnd';
/** The match ended, carrying the final standings. */
export const SERVER_GAME_END = 's:game:end';
/** A remote stroke started. */
export const SERVER_DRAW_BEGIN = 's:draw:begin';
/** Points were appended to a remote stroke. */
export const SERVER_DRAW_APPEND = 's:draw:append';
/** A remote stroke ended. */
export const SERVER_DRAW_END = 's:draw:end';
/** A remote stroke was undone. */
export const SERVER_DRAW_UNDO = 's:draw:undo';
/** A previously undone remote stroke was restored. */
export const SERVER_DRAW_REDO = 's:draw:redo';
/** The board was cleared. */
export const SERVER_DRAW_CLEAR = 's:draw:clear';
/** The full stroke list, sent to late joiners and after a reconnect. */
export const SERVER_DRAW_SNAPSHOT = 's:draw:snapshot';
/** A chat, guess or system message. */
export const SERVER_CHAT_MESSAGE = 's:chat:message';
/** Periodic broadcast of the authoritative server clock. */
export const SERVER_TIME_SYNC = 's:time:sync';
/** An out-of-band failure that is not tied to a single ack. */
export const SERVER_ERROR = 's:error';

/**
 * Alternate inbound names from the brief's section 16.
 *
 * Each maps onto the canonical event above, so a client written against the
 * brief's vocabulary talks to the same handler with the same payload. Only
 * inbound events need aliasing: outbound broadcasts go out under the
 * canonical name, because that is what the existing client listens for.
 */
export const ALIASES: Readonly<Record<string, string>> = Object.freeze({
  'room:join': CLIENT_ROOM_JOIN,
  'room:leave': CLIENT_ROOM_LEAVE,
  'player:ready': CLIENT_ROOM_READY,
  'game:start': CLIENT_GAME_START,
  'game:select_word': CLIENT_GAME_SELECT_WORD,
  'game:play_again': CLIENT_GAME_PLAY_AGAIN,
  'drawing:stroke': CLIENT_DRAW_BEGIN,
  'drawing:stroke_batch': CLIENT_DRAW_APPEND,
  'drawing:undo': CLIENT_DRAW_UNDO,
  'drawing:redo': CLIENT_DRAW_REDO,
  'drawing:clear': CLIENT_DRAW_CLEAR,
  'guess:submit': CLIENT_CHAT_SEND,
  'chat:message': CLIENT_CHAT_SEND,
  'moderation:kick': CLIENT_ROOM_KICK,
  'moderation:ban': CLIENT_ROOM_BAN,
  'moderation:mute': CLIENT_ROOM_MUTE,
  'moderation:report': CLIENT_ROOM_REPORT,
  'moderation:vote_kick': CLIENT_ROOM_VOTE_KICK,
});

/** Socket.IO room name for a game room. */
export const roomChannel = (roomId: string): string => `room:${roomId}`;

/** Socket.IO room name that reaches every socket of one user. */
export const userChannel = (userId: string): string => `user:${userId}`;
