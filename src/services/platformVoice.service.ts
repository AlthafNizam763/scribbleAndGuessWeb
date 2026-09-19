import { getSocketServer } from '@/config/socket';
import { iceServers, type IceServerDto } from '@/config/webrtc';
import type { GameId } from '@/games/game.types';
import { spaceMysteryEngine } from '@/games/spaceMystery/engine';
import { GameMatch } from '@/models/GameMatch';
import { GameRoom } from '@/models/GameRoom';
import type { GameSocket } from '@/types/socket.types';
import { errors } from '@/utils/errors';
import { logger } from '@/utils/logger';

/**
 * Voice chat for the four platform games.
 *
 * ## Why this is not `voice.service.ts`
 *
 * It is the same *shape* — a membership set, a policy, and a relay that moves
 * nothing but SDP and ICE — but the two hang off different worlds. Scribble's
 * voice reads `RuntimeRoom` out of an in-process registry and asks one
 * question: are you the drawer. This one reads a `GameRoom` document, and the
 * question it asks depends on which game is being played and, for Space
 * Mystery, on a simulation running at twenty hertz.
 *
 * Merging them would mean one service that imports both engines and branches
 * on a game id in every method. They share the parts worth sharing —
 * `iceServers()`, the error codes, and the principle below — and nothing else.
 *
 * ## No audio passes through here
 *
 * Three kinds of string: offers, answers and candidates. The audio is a
 * peer-to-peer WebRTC stream that never reaches this process, never travels
 * over Socket.IO and is never written to Mongo. A table of six costs this
 * server a few dozen small messages when the mesh is built and nothing at all
 * afterwards.
 *
 * ## The membership set is the enforcement
 *
 * Signalling is relayed on `platform-voice:<roomId>`, which is **not** the
 * room channel. A player who has not joined voice, a player the policy
 * refuses, and a ghost on the Meridian are not in that channel — so they do
 * not receive a peer's offer, cannot answer one, and never appear in anybody
 * else's peer list. Exclusion is structural rather than a hidden button.
 */

/** A voice member as it appears on the wire. Mirrors `VoicePeerDto`. */
export interface PlatformVoicePeerDto {
  userId: string;
  muted: boolean;
}

/**
 * The join verdict, and everything a client needs to build the mesh.
 *
 * A type alias rather than an interface, for the same reason `VoiceStateDto`
 * is one: `handler.ts` spreads a handler's result into the ack envelope, which
 * needs an implicit index signature — TypeScript gives one to an object type
 * alias and withholds it from an interface.
 */
export type PlatformVoiceStateDto = {
  /** The client's instruction: false means tear voice down now. */
  enabled: boolean;
  /** The channel this membership belongs to. Echoed so a client can tell a
   *  stale ack from a current one after a room change. */
  voiceRoomId: string;
  /** Everybody already in the mesh, excluding the caller. */
  peers: PlatformVoicePeerDto[];
  iceServers: IceServerDto[];
  muted: boolean;
  /** Why voice is closed, when it is. `ok` when it is open. */
  reason: PlatformVoiceReason;
};

export type PlatformVoiceReason =
  | 'ok'
  | 'not_seated'
  | 'match_over'
  | 'eliminated'
  | 'spectating'
  | 'no_meeting';

/** The channel voice signalling is relayed on. Never the room channel. */
export const platformVoiceChannel = (roomId: string): string =>
  `platform-voice:${roomId}`;

/** One room's voice group. */
type VoiceGroup = Map<string, { muted: boolean }>;

export class PlatformVoiceService {
  /**
   * Who is in voice, per room.
   *
   * In memory, like Scribble's, and for the same reason: membership is a
   * property of live connections and is meaningless the moment the process
   * restarts. Nothing here is worth persisting — a client that reconnects
   * re-joins and is handed a fresh mesh.
   */
  private readonly groups = new Map<string, VoiceGroup>();

  /** How many people are holding a voice connection. For the health probe. */
  activeMembers(): number {
    let total = 0;
    for (const group of this.groups.values()) total += group.size;
    return total;
  }

  // --------------------------------------------------------------- policy --

  /**
   * Whether [userId] may hold a voice connection in this room, right now.
   *
   * Every rule the brief lists lands here, so join, mute and all three
   * signalling verbs enforce exactly the same thing and cannot drift apart.
   * Authentication happened earlier — a socket with no verified token never
   * reaches a handler — and seat membership is re-read from the room document
   * rather than trusted from `socket.data`.
   */
  async verdict(
    gameId: GameId,
    roomId: string,
    userId: string,
  ): Promise<{ allowed: boolean; reason: PlatformVoiceReason }> {
    const room = await GameRoom.findById(roomId).select('players status matchId').lean().exec();
    if (!room) throw errors.roomNotFound();

    const seated = (room.players ?? []).some((player) => player.playerId === userId);
    if (!seated) return { allowed: false, reason: 'not_seated' };

    if (room.status === 'completed' || room.status === 'closed') {
      return { allowed: false, reason: 'match_over' };
    }

    const matchId = room.matchId ? String(room.matchId) : '';

    switch (gameId) {
      case 'SPACE_MYSTERY':
        return this.spaceVerdict(matchId, userId);

      case 'BLUFF_BAR':
        return this.bluffVerdict(matchId, userId);

      // Kazhutha and Ludo have no voice restriction beyond being at the
      // table. Going out at Kazhutha is *winning*, not elimination — those
      // players are still sitting there and there is no hidden information
      // left for them to leak, so they keep talking.
      default:
        return { allowed: true, reason: 'ok' };
    }
  }

  /**
   * The Meridian's rule: living players, during a meeting.
   *
   * Delegated to the engine because the answer lives in a simulation this
   * service has no business reaching into. See `SpaceMysteryEngine.voiceStatus`
   * for why the rule is what it is.
   */
  private spaceVerdict(
    matchId: string,
    userId: string,
  ): { allowed: boolean; reason: PlatformVoiceReason } {
    if (!matchId) return { allowed: false, reason: 'no_meeting' };

    const status = spaceMysteryEngine.voiceStatus(matchId, userId);
    if (!status.known) return { allowed: false, reason: 'match_over' };
    if (status.allowed) return { allowed: true, reason: 'ok' };

    return {
      allowed: false,
      reason: toWireReason(status.reason),
    };
  }

  /** A player who has run out of glasses is a spectator, and stays quiet. */
  private async bluffVerdict(
    matchId: string,
    userId: string,
  ): Promise<{ allowed: boolean; reason: PlatformVoiceReason }> {
    if (!matchId) return { allowed: true, reason: 'ok' };

    const match = await GameMatch.findById(matchId).select('publicState status').lean().exec();
    if (!match) return { allowed: true, reason: 'ok' };
    if (match.status === 'completed') return { allowed: false, reason: 'match_over' };

    const state = (match.publicState ?? {}) as Record<string, unknown>;
    const eliminated = Array.isArray(state.eliminated) ? state.eliminated : [];
    if (eliminated.includes(userId)) return { allowed: false, reason: 'eliminated' };

    return { allowed: true, reason: 'ok' };
  }

  /** Throws unless [userId] may act on voice in this room this instant. */
  async assertMayUseVoice(gameId: GameId, roomId: string, userId: string): Promise<void> {
    const { allowed, reason } = await this.verdict(gameId, roomId, userId);
    if (allowed) return;

    // Membership and timing are different answers, and the client shows them
    // differently: one is an error, the other is a button that is off for now.
    if (reason === 'not_seated') throw errors.notInGame();
    throw errors.voiceUnavailable(explain(reason));
  }

  // ----------------------------------------------------------- membership --

  /**
   * Admits a socket to the room's voice group.
   *
   * Refuses first and joins second, so a refused caller is never in the
   * channel even for an instant.
   */
  async join(
    gameId: GameId,
    roomId: string,
    socket: GameSocket,
  ): Promise<PlatformVoiceStateDto> {
    const userId = socket.data.user.id;
    await this.assertMayUseVoice(gameId, roomId, userId);

    const group = this.groups.get(roomId) ?? new Map<string, { muted: boolean }>();
    // Re-joining keeps the mute state: a reconnect mid-match should not
    // un-mute somebody who had deliberately gone quiet.
    const existing = group.get(userId);
    group.set(userId, { muted: existing?.muted ?? false });
    this.groups.set(roomId, group);

    socket.join(platformVoiceChannel(roomId));
    socket.data.platformVoiceRoomId = roomId;

    // Everybody already in the mesh is told to expect a peer. The joiner
    // builds outward, which is the same convention Scribble uses and is what
    // stops both ends offering at once.
    socket.to(platformVoiceChannel(roomId)).emit('game:voice_joined', {
      fromUserId: userId,
      muted: group.get(userId)!.muted,
    });

    return this.stateFor(roomId, userId, true, 'ok');
  }

  /** Removes a socket from the group and tells the rest to hang up. */
  leave(roomId: string, socket: GameSocket): void {
    const userId = socket.data.user.id;
    const group = this.groups.get(roomId);

    if (group?.delete(userId) === true && group.size === 0) {
      this.groups.delete(roomId);
    }

    socket.leave(platformVoiceChannel(roomId));
    socket.data.platformVoiceRoomId = null;

    // Fire and forget: a peer that is already gone does not need telling, and
    // a peer that is still there must not be left holding a dead connection.
    socket.to(platformVoiceChannel(roomId)).emit('game:voice_left', {
      fromUserId: userId,
    });
  }

  /** Records and announces a microphone state. */
  async setMuted(
    gameId: GameId,
    roomId: string,
    socket: GameSocket,
    muted: boolean,
  ): Promise<{ muted: boolean }> {
    const userId = socket.data.user.id;
    await this.assertMayUseVoice(gameId, roomId, userId);

    const group = this.groups.get(roomId);
    const member = group?.get(userId);
    if (!member) throw errors.voiceUnavailable('You are not in voice.');

    member.muted = muted;
    socket.to(platformVoiceChannel(roomId)).emit('game:player_muted', {
      fromUserId: userId,
      muted,
    });
    return { muted };
  }

  /**
   * Relays one signalling frame to exactly one peer.
   *
   * Addressed rather than broadcast, which is the fix for the original relay:
   * an offer meant for one player was going to the whole room, so every client
   * had to filter frames that were never theirs, and anybody in the room —
   * including players who had never joined voice — received them.
   */
  async relay(input: {
    gameId: GameId;
    roomId: string;
    socket: GameSocket;
    event: 'game:voice_offer' | 'game:voice_answer' | 'game:voice_ice_candidate';
    targetUserId: string;
    payload: Record<string, unknown>;
  }): Promise<void> {
    const { gameId, roomId, socket, event, targetUserId, payload } = input;
    const fromUserId = socket.data.user.id;

    // Both ends are checked. A ghost must not be able to answer an offer it
    // somehow received, and a living player must not be able to address one to
    // a ghost.
    await this.assertMayUseVoice(gameId, roomId, fromUserId);
    await this.assertMayUseVoice(gameId, roomId, targetUserId);

    const group = this.groups.get(roomId);
    if (!group?.has(fromUserId) || !group.has(targetUserId)) {
      throw errors.voiceUnavailable('That player is not in voice.');
    }

    const server = getSocketServer();
    if (!server) return;

    // To the target's *user* channel, so it reaches whichever device they are
    // playing on rather than a socket id this caller guessed.
    server.to(`user:${targetUserId}`).emit(event, {
      ...payload,
      fromUserId,
      roomId,
    });
  }

  /**
   * Re-derives membership after a state change, and hangs up whoever no
   * longer qualifies.
   *
   * The Meridian needs this: a meeting ends and every living player must be
   * dropped from voice, and a player eliminated during one must be dropped
   * immediately. Called from the engine's own broadcast, which is the single
   * funnel every change already passes through — so there is no list of call
   * sites that each have to remember.
   */
  async reconcile(gameId: GameId, roomId: string): Promise<void> {
    const group = this.groups.get(roomId);
    if (!group || group.size === 0) return;

    const server = getSocketServer();
    if (!server) return;

    for (const userId of [...group.keys()]) {
      const { allowed } = await this.verdict(gameId, roomId, userId).catch(() => ({
        allowed: false,
        reason: 'match_over' as PlatformVoiceReason,
      }));
      if (allowed) continue;

      group.delete(userId);

      // The dropped player is told to tear down, and the rest are told to
      // forget them. Both, because a one-sided hang-up leaves a peer
      // connection open and a microphone live.
      server.to(`user:${userId}`).emit('game:voice_state', {
        enabled: false,
        voiceRoomId: roomId,
        peers: [],
        iceServers: [],
        muted: false,
        reason: 'no_meeting',
      });
      server.to(platformVoiceChannel(roomId)).emit('game:voice_left', {
        fromUserId: userId,
      });
    }

    if (group.size === 0) this.groups.delete(roomId);
  }

  /** Drops every trace of a socket. Called on disconnect. */
  forget(socket: GameSocket): void {
    const roomId = socket.data.platformVoiceRoomId;
    if (!roomId) return;

    try {
      this.leave(roomId, socket);
    } catch (error: unknown) {
      logger.debug('tidying a platform voice seat failed', { error: String(error) });
    }
  }

  /** The mesh as one member sees it. */
  stateFor(
    roomId: string,
    userId: string,
    enabled: boolean,
    reason: PlatformVoiceReason,
  ): PlatformVoiceStateDto {
    const group = this.groups.get(roomId);

    return {
      enabled,
      voiceRoomId: roomId,
      peers: <PlatformVoicePeerDto[]>[
        ...(group ?? new Map<string, { muted: boolean }>()).entries(),
      ]
        .filter(([id]) => id !== userId)
        .map(([id, member]) => ({ userId: id, muted: member.muted })),
      iceServers: iceServers(),
      muted: group?.get(userId)?.muted ?? false,
      reason,
    };
  }
}

/**
 * Maps the engine's own vocabulary onto the wire's.
 *
 * The two differ in one place that matters: the engine says `dead`, which is a
 * fact about the simulation, and the wire says `spectating`, which is what the
 * player is doing about it. Bluff Bar has no concept of `dead` and Kazhutha
 * has no concept of either, so the wire word is the one all four games share.
 */
function toWireReason(
  reason: 'no_match' | 'not_seated' | 'dead' | 'no_meeting' | 'ok',
): PlatformVoiceReason {
  switch (reason) {
    case 'no_match': return 'match_over';
    case 'not_seated': return 'not_seated';
    case 'dead': return 'spectating';
    case 'no_meeting': return 'no_meeting';
    case 'ok': return 'ok';
  }
}

function explain(reason: PlatformVoiceReason): string {
  switch (reason) {
    case 'spectating':
      return 'The dead do not talk to the living.';
    case 'no_meeting':
      return 'Voice opens when a meeting is called.';
    case 'eliminated':
      return 'You are out. Watch the rest of it from the bar.';
    case 'match_over':
      return 'That match has finished.';
    default:
      return 'Voice chat is not open to you right now.';
  }
}

export const platformVoiceService = new PlatformVoiceService();
