import { emitToSocket, emitToVoice } from '@/config/socket';
import {
  CLIENT_VOICE_ANSWER,
  CLIENT_VOICE_ICE,
  CLIENT_VOICE_JOIN,
  CLIENT_VOICE_LEAVE,
  CLIENT_VOICE_MUTE,
  CLIENT_VOICE_OFFER,
  SERVER_VOICE_ANSWER,
  SERVER_VOICE_ERROR,
  SERVER_VOICE_ICE,
  SERVER_VOICE_MUTE,
  SERVER_VOICE_OFFER,
} from '@/constants/socket.constants';
import { parsePayload } from '@/middleware/validation.middleware';
import { voiceService } from '@/services/voice.service';
import { on } from '@/socket/handler';
import type { GameSocket } from '@/types/socket.types';
import {
  voiceAnswerSchema,
  voiceIceSchema,
  voiceMuteSchema,
  voiceOfferSchema,
} from '@/validators/voice.validator';

/**
 * WebRTC signalling for guesser-only voice chat.
 *
 * ## What this relay does and does not carry
 *
 * Six inbound verbs, and between them they move nothing but membership and
 * three kinds of session-negotiation string. No audio ever travels over this
 * socket and none is ever stored: once two guessers have exchanged an offer,
 * an answer and their candidates, their voices go directly phone to phone (or
 * through a TURN relay where a NAT forbids that) and this server hears
 * nothing more from them until somebody hangs up.
 *
 * ## Why every handler re-checks the same thing
 *
 * The permission rule is not "was this caller allowed to join" but "is this
 * caller allowed *right now*", and right now changes in the middle of a
 * connection: the pen moves every turn. A guesser who was mid-handshake when
 * the round ended and made them the next drawer must not be able to finish
 * that handshake. So `voiceService.assertMayUseVoice` runs on every single
 * frame — it is a handful of map lookups against state this process owns, and
 * it is what makes `DRAWER_VOICE_DISABLED` a guarantee rather than a UI
 * convention.
 *
 * ## Acks versus fire-and-forget
 *
 * Join, leave and mute ack, because the client needs a verdict before it turns
 * a microphone on or off. Offer, answer and candidate do not: a round trip per
 * ICE candidate would add latency to connection setup for nothing, and
 * Socket.IO already delivers them in order over the websocket. Their failures
 * arrive on `s:voice:error` instead, which is what `errorEvent` below wires
 * up — so a drawer hand-crafting `voice:offer` is refused audibly rather than
 * silently.
 */
export function registerVoiceHandlers(socket: GameSocket): void {
  // -------------------------------------------------------------------- join

  on(
    socket,
    CLIENT_VOICE_JOIN,
    ({ room, socket: sock, userId }) => {
      // Throws `DRAWER_VOICE_DISABLED` for the drawer before anything else
      // happens, so no membership, no channel join and no announcement.
      voiceService.join(room, sock);

      // The joiner is handed the mesh it has to build, plus the ICE servers
      // for this deployment. Returned in the ack rather than pushed, so the
      // client has them in hand the moment its own join resolves.
      return voiceService.stateFor(room, userId);
    },
    { limit: 'voice', requiresRoom: true, errorEvent: SERVER_VOICE_ERROR },
  );

  // ------------------------------------------------------------------- leave

  on(
    socket,
    CLIENT_VOICE_LEAVE,
    ({ room, userId }) => {
      // Deliberately unguarded. Leaving is always allowed — including for
      // somebody who has just become the drawer and whose client is doing the
      // right thing by hanging up — so this must not be able to throw
      // `DRAWER_VOICE_DISABLED` at a client that is complying.
      voiceService.leave(room, userId, 'left');
      return { enabled: false };
    },
    { limit: 'voice', requiresRoom: true, errorEvent: SERVER_VOICE_ERROR },
  );

  // ------------------------------------------------------------------- offer

  on(
    socket,
    CLIENT_VOICE_OFFER,
    ({ room, userId }, payload) => {
      const { targetId, description } = parsePayload(payload, voiceOfferSchema);
      const target = voiceService.requirePeer(room, userId, targetId);

      // Addressed to the peer's own socket, never to a channel: an offer is a
      // private invitation between two guessers, and fanning it out would let
      // a third build a connection nobody asked for.
      emitToSocket(target.socketId, SERVER_VOICE_OFFER, {
        // `from`, not whatever the sender claimed: the id comes from the
        // authenticated socket, so a peer cannot be impersonated.
        from: userId,
        description,
      });
    },
    { limit: 'voiceSignal', requiresRoom: true, errorEvent: SERVER_VOICE_ERROR },
  );

  // ------------------------------------------------------------------ answer

  on(
    socket,
    CLIENT_VOICE_ANSWER,
    ({ room, userId }, payload) => {
      const { targetId, description } = parsePayload(payload, voiceAnswerSchema);
      const target = voiceService.requirePeer(room, userId, targetId);

      emitToSocket(target.socketId, SERVER_VOICE_ANSWER, { from: userId, description });
    },
    { limit: 'voiceSignal', requiresRoom: true, errorEvent: SERVER_VOICE_ERROR },
  );

  // --------------------------------------------------------- ice candidates

  on(
    socket,
    CLIENT_VOICE_ICE,
    ({ room, userId }, payload) => {
      const { targetId, candidate } = parsePayload(payload, voiceIceSchema);
      const target = voiceService.requirePeer(room, userId, targetId);

      emitToSocket(target.socketId, SERVER_VOICE_ICE, { from: userId, candidate });
    },
    { limit: 'voiceSignal', requiresRoom: true, errorEvent: SERVER_VOICE_ERROR },
  );

  // -------------------------------------------------------------------- mute

  on(
    socket,
    CLIENT_VOICE_MUTE,
    ({ room, userId }, payload) => {
      const { muted } = parsePayload(payload, voiceMuteSchema);

      // The microphone track is disabled on the sending device; this is only
      // so the other guessers can render the indicator. Nothing here can make
      // a peer stop hearing somebody — that is the sender's own track.
      const changed = voiceService.setMuted(room, userId, muted);
      if (changed) emitToVoice(room.roomId, SERVER_VOICE_MUTE, { userId, muted });

      return { muted };
    },
    { limit: 'voice', requiresRoom: true, errorEvent: SERVER_VOICE_ERROR },
  );
}
