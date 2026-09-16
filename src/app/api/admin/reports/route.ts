import { connectToDatabase } from '@/config/database';
import { REPORT_STATUSES, type ReportStatusWire } from '@/constants/social.constants';
import { requireUser } from '@/middleware/auth.middleware';
import { ok, withErrorHandling } from '@/middleware/error.middleware';
import { clientIdentity, enforceHttpLimit } from '@/middleware/rateLimit.middleware';
import { parseQuery } from '@/middleware/validation.middleware';
import { reportReviewService } from '@/services/reportReview.service';
import { pageQuerySchema } from '@/validators/social.validator';

/**
 * `GET /api/admin/reports?status=&page=&limit=`
 *
 * The review queue. Moderators only — and a player who is not one gets
 * `NOT_FOUND` rather than a refusal, so probing these routes does not confirm
 * that they exist.
 *
 * Nothing here is ever visible to a player: not to the reported account, and
 * not to the reporter either. A report a player could read back would be a
 * harassment channel of its own.
 */
export const GET = withErrorHandling(async (request: Request) => {
  const user = await requireUser(request);
  enforceHttpLimit('progressionRead', clientIdentity(request, user.id));

  await connectToDatabase();

  const { page, limit } = parseQuery(request, pageQuerySchema);
  const raw = new URL(request.url).searchParams.get('status');
  const status = REPORT_STATUSES.includes(raw as ReportStatusWire)
    ? (raw as ReportStatusWire)
    : undefined;

  return ok(
    await reportReviewService.list({ actorId: user.id, status, page, limit }),
  );
});

export const dynamic = 'force-dynamic';
