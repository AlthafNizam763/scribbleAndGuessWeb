import { connectToDatabase } from '@/config/database';
import { optionalUser } from '@/middleware/auth.middleware';
import { ok, withErrorHandling } from '@/middleware/error.middleware';
import { clientIdentity, enforceHttpLimit } from '@/middleware/rateLimit.middleware';
import { autoTournamentService } from '@/services/tournament/auto.service';

/**
 * `GET /api/tournaments`
 *
 * The automatic tournament slots — three of them, in order.
 *
 * ## Why a slot with nothing in it is still a row
 *
 * Because the screen shows three cards and "no tournament in this slot; a new
 * one will be created automatically soon" is a card. Returning only the
 * tournaments that exist would make the client work out which slots are
 * missing, which is the server's arithmetic, not the client's.
 *
 * ## Why authentication is optional
 *
 * The listing is public: what is on, how full it is and when it starts are the
 * same facts for everybody. Signing in adds the `viewer` block — whether you
 * are registered, whether you may check in, and why you cannot join if you
 * cannot — which is the only per-caller part of the response.
 *
 * ## Where the older points tournaments went
 *
 * `GET /api/tournaments/events`. They are a separate feature with separate
 * rows, and this path now belongs to the automatic system, which is the one a
 * player means when they open the tournament screen.
 */
export const GET = withErrorHandling(async (request: Request) => {
  const user = await optionalUser(request);
  enforceHttpLimit('progressionRead', clientIdentity(request, user?.id));

  await connectToDatabase();

  return ok(await autoTournamentService.listSlots(user?.id ?? null));
});

export const dynamic = 'force-dynamic';
