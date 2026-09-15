import { emitToSocket, emitToVoice, getSocketServer } from '@/config/socket';
import { iceServers, type IceServerDto } from '@/config/webrtc';
import { CONNECTION, GAME_PHASE, type GamePhaseWire } from '@/constants/room.constants';
import {
  SERVER_VOICE_PEER_JOINED,
  SERVER_VOICE_PEER_LEFT,
  SERVER_VOICE_STATE,
  voiceChannel,
} from '@/constants/socket.constants';
import type { GameSocket, RuntimeRoom, RuntimeVoiceMember } from '@/types/socket.types';
import { errors } from '@/utils/errors';
import { logger } from '@/utils/logger';

/**
 * Guesser-only voice chat: membership, and the rules that decide it.
 *
 * ## The one rule
 *
 * The drawer cannot speak and cannot hear. Not "the microphone button is
 * hidden for them" — they are never admitted to the voice group at all, no
 * peer is ever told to connect to them, and every signalling frame addressed
 * to or from them is refused with `DRAWER_VOICE_DISABLED`. A client that
 * hand-crafts `voice:join` while holding the pen gets the same answer as one
 * that asks politely, because the answer comes from `room.round.drawerId`,
 * which this process decided and no client can move.
 *
 * ## No audio passes through here
 *
 * This service moves three kinds of string: SDP offers, SDP answers and ICE
 * candidates. The audio itself is a peer-to-peer WebRTC stream that never
 * reaches this process, never travels over Socket.IO and is never written to
 * Mongo. That is the whole reason the feature is free to run — a room of six
 * costs this server a few dozen small messages per turn and nothing else.
 *
 * ## Why membership is reconciled rather than commanded
 *
 * `reconcile` runs from `gameService.broadcastState`, which is the single
 * funnel every state change already goes through: a turn opening, the pen
 * changing hands, a pause, a resume, a departure, a reconnect. So there is no
 * list of call sites that must each remember to hang the old drawer up. If the
 * game state moved, voice membership was re-derived from it.
 */

/** A voice member as it appears on the wire. */
export interface VoicePeerDto {
  userId: string;
  muted: boolean;
}

/**
 * One player's voice status, as `s:voice:state` carries it.
 *
 * A type alias rather than an interface on purpose: this is returned straight
 * out of the `c:voice:join` handler, and `handler.ts` spreads a handler's
 * result into the ack envelope, which requires an implicit index signature.
 * TypeScript gives one to an object type alias and withholds it from an
 * interface.
 */
export type VoiceStateDto = {
  /** The client's instruction: false means tear voice down now. */
  enabled: boolean;
  isDrawer: boolean;
  phase: GamePhaseWire;
  muted: boolean;
  peers: VoicePeerDto[];
  iceServers: IceServerDto[];
};

/**
 * The phases in which voice is allowed.
 *
 * A turn plus its scoreboard. Guessers keep talking across the turn boundary —
 * the moment right after the buzzer is exactly what the feature is for — and
 * the outgoing drawer is admitted the instant the next turn names somebody
 * else.
 *
 * The lobby, the starting countdown, a paused match and the final scoreboard
 * are deliberately silent: there is no drawer to exclude in those phases, so
 * "guessers only" has no meaning there, and a mesh built in one of them would
 * have to be torn apart the moment a turn opened.
 */
const VOICE_PHASES: ReadonlySet<GamePhaseWire> = new Set<GamePhaseWire>([
  GAME_PHASE.wordSelection,
  GAME_PHASE.drawing,
  GAME_PHASE.roundEnd,
]);

export class VoiceService {
  // ------------------------------------------------------------------ rules

  /** Whether the room's phase permits voice at all. */
  isVoicePhase(room: RuntimeRoom): boolean {
    return !room.closed && VOICE_PHASES.has(room.phase);
  }

  /** The current drawer's id, or null when nobody holds the pen. */
  drawerId(room: RuntimeRoom): string | null {
    return room.round?.drawerId ?? null;
  }

  /** Whether this user is the current drawer. */
  isDrawer(room: RuntimeRoom, userId: string): boolean {
    const drawer = this.drawerId(room);
    return drawer !== null && drawer === userId;
  }

  /**
   * Confirms this user may hold a voice connection right now.
   *
   * Every check in the brief's server-authoritative list lands here, so
   * `join`, `mute` and all three signalling verbs enforce exactly the same
   * thing and cannot drift apart. Authentication itself happened earlier, in
   * the handshake middleware — a socket with no verified token never reaches
   * a handler at all — and room membership is re-checked here rather than
   * trusted from `socket.data.roomId`.
   */
  assertMayUseVoice(room: RuntimeRoom, userId: string): void {
    const player = room.players.get(userId);
    if (!player) throw errors.notMember();
    if (player.connection === CONNECTION.disconnected) {
      throw errors.invalidAction('You are not connected to this room.');
    }

    // The rule. Checked before the phase test so a drawer poking at the
    // protocol always gets the specific refusal rather than a vaguer one.
    if (this.isDrawer(room, userId)) throw errors.drawerVoiceDisabled();

    if (!this.isVoicePhase(room)) {
      throw errors.invalidAction('Voice chat is not open right now.');
    }
  }

  /**
   * Confirms a signalling frame may travel from `userId` to `targetId`.
   *
   * Both ends are checked, which is what stops a guesser addressing the
   * drawer: the sender being legitimate says nothing about the recipient, and
   * an offer delivered to the drawer would be an invitation to open exactly
   * the connection the rule forbids.
   */
  requirePeer(room: RuntimeRoom, userId: string, targetId: string): RuntimeVoiceMember {
    this.assertMayUseVoice(room, userId);

    if (targetId === userId) throw errors.invalidAction('You cannot call yourself.');
    if (this.isDrawer(room, targetId)) throw errors.drawerVoiceDisabled();

    const target = room.voice.members.get(targetId);
    // Somebody outside the group is reported as not being in the room: from
    // the sender's point of view there is nobody at that address, and saying
    // which of the two it is would leak the voice roster to a non-member.
    if (!target) throw errors.notMember('That player is not in voice chat.');

    return target;
  }

  // ------------------------------------------------------------- membership

  /** The group as the wire sees it, optionally without one member. */
  peers(room: RuntimeRoom, exceptUserId?: string): VoicePeerDto[] {
    const list: VoicePeerDto[] = [];
    for (const member of room.voice.members.values()) {
      if (member.userId === exceptUserId) continue;
      list.push({ userId: member.userId, muted: member.muted });
    }
    return list;
  }

  /**
   * Admits a socket to the voice group.
   *
   * Returns the peers it should connect to. Re-joining is idempotent from the
   * caller's point of view but is not a no-op: the seat moves to the new
   * socket and the old one is taken out of the channel, so a reconnect cannot
   * leave a ghost peer that nobody can reach.
   */
  join(room: RuntimeRoom, socket: GameSocket): VoicePeerDto[] {
    const userId = socket.data.user.id;
    this.assertMayUseVoice(room, userId);

    const existing = room.voice.members.get(userId);
    if (existing && existing.socketId !== socket.id) {
      this.detachSocket(room, existing.socketId);
    }

    const member: RuntimeVoiceMember = {
      userId,
      socketId: socket.id,
      muted: existing?.muted ?? false,
      joinedAt: Date.now(),
    };

    // Captured before the new member is inserted, so the joiner is not handed
    // itself as a peer to call.
    const peers = this.peers(room, userId);

    room.voice.members.set(userId, member);
    socket.join(voiceChannel(room.roomId));

    // Announced to the voice group only — never to `roomChannel`, which is
    // where the drawer is sitting.
    socket.to(voiceChannel(room.roomId)).emit(SERVER_VOICE_PEER_JOINED, {
      peer: { userId, muted: member.muted },
    });

    logger.debug('voice join', { roomId: room.roomId, userId, peers: peers.length });
    return peers;
  }

  /**
   * Removes a user from the voice group.
   *
   * Returns whether they were in it, so a caller can skip announcing a
   * departure that did not happen. Safe to call for somebody who never joined,
   * which is what lets every teardown path call it unconditionally.
   */
  leave(room: RuntimeRoom, userId: string, reason: string): boolean {
    const member = room.voice.members.get(userId);
    if (!member) return false;

    room.voice.members.delete(userId);
    this.detachSocket(room, member.socketId);

    // To the remaining group, so each peer closes its RTCPeerConnection to
    // this user rather than holding a dead one open.
    emitToVoice(room.roomId, SERVER_VOICE_PEER_LEFT, { userId, reason });

    logger.debug('voice leave', { roomId: room.roomId, userId, reason });
    return true;
  }

  /** Records a member's microphone state. Returns whether it changed. */
  setMuted(room: RuntimeRoom, userId: string, muted: boolean): boolean {
    this.assertMayUseVoice(room, userId);

    const member = room.voice.members.get(userId);
    if (!member) throw errors.invalidAction('You are not in voice chat.');
    if (member.muted === muted) return false;

    member.muted = muted;
    return true;
  }

  // ---------------------------------------------------------- reconciliation

  /**
   * Brings the voice group back in line with the game state.
   *
   * Runs on every broadcast, so it has to be cheap and silent when nothing
   * moved — and it is: at most a dozen map lookups, and not one emit unless
   * somebody genuinely has to be hung up.
   *
   * The removals it makes are the ones no client can be trusted to make for
   * itself: the player who has just become the drawer, anybody the room has
   * written off, and everybody at once when the match leaves a voice phase.
   */
  reconcile(room: RuntimeRoom): void {
    if (room.voice.members.size === 0) return;

    const drawer = this.drawerId(room);
    const open = this.isVoicePhase(room);

    for (const member of [...room.voice.members.values()]) {
      const player = room.players.get(member.userId);

      let reason: string | null = null;
      if (!open) reason = 'voice_closed';
      else if (member.userId === drawer) reason = 'drawer';
      else if (!player) reason = 'left_room';
      else if (player.connection === CONNECTION.disconnected) reason = 'disconnected';

      if (reason === null) continue;

      this.leave(room, member.userId, reason);

      // The evicted client is told directly as well. `peerLeft` went to the
      // group they are no longer in, so without this the new drawer's own app
      // would never hear that its microphone must go off — and the rule would
      // hold for everybody except the one person it is about.
      emitToSocket(member.socketId, SERVER_VOICE_STATE, this.stateFor(room, member.userId));
    }
  }

  /**
   * One player's voice status.
   *
   * `enabled` is an instruction rather than a hint: false means stop the
   * microphone and close every peer connection now.
   */
  stateFor(room: RuntimeRoom, userId: string): VoiceStateDto {
    const isDrawer = this.isDrawer(room, userId);
    const enabled = this.isVoicePhase(room) && !isDrawer && room.players.has(userId);

    return {
      enabled,
      isDrawer,
      phase: room.phase,
      muted: room.voice.members.get(userId)?.muted ?? false,
      peers: enabled ? this.peers(room, userId) : [],
      iceServers: enabled ? iceServers() : [],
    };
  }

  /** Drops every member. Used when a room closes. */
  clear(room: RuntimeRoom): void {
    for (const member of [...room.voice.members.values()]) {
      this.leave(room, member.userId, 'room_closed');
    }
  }

  // ------------------------------------------------------------------ helper

  /** Takes one socket out of the voice channel, if it is still connected. */
  private detachSocket(room: RuntimeRoom, socketId: string): void {
    const server = getSocketServer();
    if (!server) return;
    server.sockets.sockets.get(socketId)?.leave(voiceChannel(room.roomId));
  }
}

export const voiceService = new VoiceService();
