import { z } from 'zod';

/**
 * Voice signalling validation.
 *
 * ## What is checked, and what deliberately is not
 *
 * The server is a relay: it never parses SDP and never interprets a candidate,
 * because doing so would make it a WebRTC implementation rather than a
 * postbox, and every browser and mobile stack spells these slightly
 * differently. So the checks here are structural and about *size* — the thing
 * a relay actually has to defend against is a client parking megabytes of
 * text on it, or addressing a peer id long enough to be an attack in itself.
 *
 * The rules that matter for this feature — who may talk to whom — are not
 * expressible in a schema at all: they depend on who is drawing right now.
 * They live in `voice.service.ts` and run after this.
 */

/**
 * Longest accepted SDP blob.
 *
 * A real offer with a single audio track and a full candidate list runs to a
 * few kilobytes; 16 KB leaves generous headroom for a verbose stack while
 * staying far below the socket's own 1 MB frame cap.
 */
const MAX_SDP_LENGTH = 16_384;

/** Longest accepted ICE candidate line. Real ones are around 100 characters. */
const MAX_CANDIDATE_LENGTH = 1024;

/** A player id, as it appears on the wire. */
const peerId = z.string().trim().min(1).max(64);

/** `c:voice:join`. Carries nothing: who may join is decided by the server. */
export const voiceJoinSchema = z.object({}).passthrough();

/**
 * The SDP half of an offer or an answer.
 *
 * `type` is constrained because it is the one field the relay does look at —
 * it is echoed to the peer, and an unknown value there would make the
 * receiver's `setRemoteDescription` throw rather than simply fail to connect.
 */
const sessionDescription = z.object({
  type: z.enum(['offer', 'answer', 'pranswer', 'rollback']),
  sdp: z.string().max(MAX_SDP_LENGTH),
});

/** `c:voice:offer`. */
export const voiceOfferSchema = z.object({
  targetId: peerId,
  description: sessionDescription,
});

/** `c:voice:answer`. */
export const voiceAnswerSchema = z.object({
  targetId: peerId,
  description: sessionDescription,
});

/**
 * `c:voice:ice`.
 *
 * Every field is optional but `targetId`, because an end-of-candidates signal
 * is legitimately a null candidate and dropping it would leave the peer
 * waiting for more that will never come.
 */
export const voiceIceSchema = z.object({
  targetId: peerId,
  candidate: z
    .object({
      candidate: z.string().max(MAX_CANDIDATE_LENGTH).nullable().optional(),
      sdpMid: z.string().max(64).nullable().optional(),
      sdpMLineIndex: z.coerce.number().int().min(0).max(64).nullable().optional(),
    })
    .nullable(),
});

/** `c:voice:mute`. */
export const voiceMuteSchema = z.object({
  muted: z.coerce.boolean(),
});
