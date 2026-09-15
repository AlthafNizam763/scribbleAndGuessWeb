import { env } from '@/config/env';

/**
 * The ICE configuration voice chat hands to clients.
 *
 * ## Why the server decides this and not the app
 *
 * A TURN server needs credentials, and a credential compiled into a mobile
 * binary is a credential anybody with the APK has. Building the list here and
 * shipping it over `s:voice:state` means the app holds nothing: the relay can
 * be introduced, moved or rotated by restarting this process, and a client
 * that is not authenticated never sees it at all.
 *
 * ## Why STUN alone is the default
 *
 * STUN is free and enough for the overwhelming majority of home and mobile
 * networks: it only tells each peer what its public address looks like, and
 * the audio then flows directly between the two phones. TURN is the fallback
 * for the minority behind a symmetric NAT, and it is *not* free — every byte
 * of audio is relayed through it — so it stays opt-in via `WEBRTC_TURN_URL`
 * (brief: support Coturn as an optional production fallback).
 *
 * With no TURN configured, a peer pair that cannot traverse its NAT simply
 * fails to connect; the client reports that peer as failed and the rest of the
 * mesh carries on.
 */

/** One entry of an `RTCConfiguration.iceServers` array. */
export interface IceServerDto {
  urls: string[];
  username?: string;
  credential?: string;
}

/**
 * The ICE servers for this deployment.
 *
 * Recomputed per call rather than cached, because the object is handed
 * straight to a serialiser and a shared mutable array would be one accidental
 * `push` away from leaking between rooms. It is a handful of strings.
 */
export function iceServers(): IceServerDto[] {
  const servers: IceServerDto[] = [];

  if (env.webrtcStunUrls.length > 0) {
    servers.push({ urls: [...env.webrtcStunUrls] });
  }

  if (env.webrtcTurnUrls.length > 0) {
    const turn: IceServerDto = { urls: [...env.webrtcTurnUrls] };
    // A TURN server that needs no credentials is unusual but legal, and
    // sending empty strings would make some stacks reject the whole entry.
    if (env.webrtcTurnUsername) turn.username = env.webrtcTurnUsername;
    if (env.webrtcTurnCredential) turn.credential = env.webrtcTurnCredential;
    servers.push(turn);
  }

  return servers;
}

/** Whether a relay is configured, for diagnostics and the health payload. */
export function hasTurn(): boolean {
  return env.webrtcTurnUrls.length > 0;
}
