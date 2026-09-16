import { connectToDatabase } from '@/config/database';
import { requireUser } from '@/middleware/auth.middleware';
import { ok, withErrorHandling } from '@/middleware/error.middleware';
import { clientIdentity, enforceHttpLimit } from '@/middleware/rateLimit.middleware';
import { tournamentMatchService } from '@/services/tournament/match.service';

/**
 * `POST /api/tournaments/:id/matches/:matchId/enter`
 *
 * The code for the room a player's match is being held in.
 *
 * ## What this does and does not do
 *
 * It hands back a room code. It does not seat anybody — the client joins the
 * room over the socket exactly as it joins any other, which is what keeps the
 * tournament path free of a second way into a game.
 *
 * ## Why a non-participant gets "not found" rather than "not allowed"
 *
 * Because "not allowed" confirms the match exists, which is the only useful
 * thing to learn by guessing at match ids. The same reasoning as the room
 * join path, which refuses an outsider at a protected room the same way.
 *
 * Note that this endpoint is not the security boundary. The room refuses
 * anybody outside the pairing on its own `allowedUserIds`, so a leaked code
 * gets nowhere; this simply avoids handing one out in the first place.
 */
type Context = { params: Promise<{ tournamentId: string; matchId: string }> };

export const POST = withErrorHandling(async (request: Request, context: Context) => {
  const user = await requireUser(request);
  enforceHttpLimit('joinRoom', clientIdentity(request, user.id));

  await connectToDatabase();

  const { tournamentId, matchId } = await context.params;

  const entry = await tournamentMatchService.enter({
    tournamentId,
    matchId,
    userId: user.id,
  });

  return ok({
    roomId: entry.roomId,
    roomCode: entry.roomCode,
    matchId,
    roundNumber: entry.match.roundNumber,
    matchNumber: entry.match.matchNumber,
    entryDeadlineMs: entry.match.entryDeadlineAt
      ? entry.match.entryDeadlineAt.getTime()
      : null,
  });
});

export const dynamic = 'force-dynamic';
