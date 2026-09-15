import { request } from '@/web/api';
import type {
  FriendDto,
  InviteCandidateDto,
  PublicRoomDto,
  RoomDto,
  RoomInvitationDto,
  RoomMembersDto,
} from '@/web/types';

/**
 * The invitation, browser, friends and membership endpoints.
 *
 * ## Why these are REST and the game is not
 *
 * The room a player is *in* is a live thing, so it travels over the socket:
 * the state is pushed, and joining has to seat a connection rather than just
 * an account. These calls are the opposite shape. An invitations inbox has to
 * be readable before the socket is up — it is how a player decides which room
 * to open a connection *to* — and the public browser is a list somebody
 * scrolls, not a stream.
 *
 * So the split is not arbitrary: REST answers "what rooms are there", the
 * socket answers "what is happening in mine".
 *
 * ## It owns no rules
 *
 * Every refusal below is decided by the server and arrives as an `ApiError`
 * carrying the sentence it wrote: `Room is full`, `Game already started`,
 * `Invitation expired`, `You are already in another room. Leave that room
 * first.` Re-deriving any of that here would give two places for it to
 * disagree, and this copy would be the one that was wrong.
 */

/** One page of the invitations inbox. */
export interface InvitationPage {
  items: RoomInvitationDto[];
  total: number;
  hasMore: boolean;
}

/**
 * One page of the public browser.
 *
 * `currentRoomId` is the caller's existing seat, if they hold one. It is here
 * so the screen can say "leave that room first" *before* somebody taps Join
 * and is refused — the refusal is still the server's, this only saves a round
 * trip to hear it.
 */
export interface PublicRoomPage {
  items: PublicRoomDto[];
  currentRoomId: string | null;
  currentRoomCode: string | null;
}

/** The invite sheet's rows for one room. */
export interface InviteCandidatePage {
  roomId: string;
  roomCode: string;
  playerCount: number;
  maxPlayers: number;
  items: InviteCandidateDto[];
}

/** The caller's unanswered invitations. */
export function fetchInvitations(token: string): Promise<InvitationPage> {
  return request<InvitationPage>('/api/rooms/invitations', { token });
}

/** The public rooms the caller could join right now. */
export function fetchPublicRooms(token: string): Promise<PublicRoomPage> {
  return request<PublicRoomPage>('/api/rooms/public', { token });
}

/**
 * The caller's friends, annotated for one room.
 *
 * Every flag on a row — online, seated, already invited, invitable — is the
 * server's answer, which is what lets the modal grey a button out instead of
 * letting somebody tap into a refusal.
 */
export function fetchInviteCandidates(
  token: string,
  roomId: string,
): Promise<InviteCandidatePage> {
  return request<InviteCandidatePage>(`/api/rooms/${roomId}/invite`, { token });
}

/** Asks one friend to join one room. */
export function sendInvite(
  token: string,
  roomId: string,
  friendId: string,
): Promise<{ invitation: RoomInvitationDto }> {
  return request<{ invitation: RoomInvitationDto }>(`/api/rooms/${roomId}/invite`, {
    method: 'POST',
    token,
    body: { friendId },
  });
}

/**
 * Accepts an invitation, seating the account.
 *
 * The connection still has to enter the room, and it does that by code over
 * the socket — the same path a player typing a code takes, so there is one way
 * into a lobby rather than two. That is why the code is the useful half of
 * this response.
 */
export function acceptInvitation(
  token: string,
  invitationId: string,
): Promise<{ room: RoomDto; roomCode: string }> {
  return request<{ room: RoomDto; roomCode: string }>(
    `/api/rooms/invitations/${invitationId}/accept`,
    { method: 'POST', token },
  );
}

/** Declines an invitation. The caller stays where they are. */
export function rejectInvitation(token: string, invitationId: string): Promise<unknown> {
  return request(`/api/rooms/invitations/${invitationId}/reject`, {
    method: 'POST',
    token,
  });
}

/**
 * Takes a seat in a room named by id or by code.
 *
 * This is the call that re-validates: the browser row it came from is a
 * snapshot, and a room that had space when the list was drawn may not now.
 */
export function joinRoomById(
  token: string,
  roomId: string,
): Promise<{ room: RoomDto; roomCode: string }> {
  return request<{ room: RoomDto; roomCode: string }>(`/api/rooms/${roomId}/join`, {
    method: 'POST',
    token,
  });
}

/** Gives up a seat. */
export function leaveRoomById(token: string, roomId: string): Promise<unknown> {
  return request(`/api/rooms/${roomId}/leave`, { method: 'POST', token });
}

/** Who is seated in a room. Members only. */
export function fetchMembers(token: string, roomId: string): Promise<RoomMembersDto> {
  return request<RoomMembersDto>(`/api/rooms/${roomId}/members`, { token });
}

/** The caller's accepted friends. */
export function fetchFriends(
  token: string,
): Promise<{ items: FriendDto[]; total: number; hasMore: boolean }> {
  return request<{ items: FriendDto[]; total: number; hasMore: boolean }>('/api/friends', {
    token,
  });
}
