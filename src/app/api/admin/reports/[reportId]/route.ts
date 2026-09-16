import { connectToDatabase } from '@/config/database';
import { REPORT_STATUS, type ReportStatusWire } from '@/constants/social.constants';
import { requireUser } from '@/middleware/auth.middleware';
import { ok, withErrorHandling } from '@/middleware/error.middleware';
import { clientIdentity, enforceHttpLimit } from '@/middleware/rateLimit.middleware';
import { parseBody } from '@/middleware/validation.middleware';
import { reportReviewService } from '@/services/reportReview.service';
import { resolveReportSchema } from '@/validators/social.validator';
import { objectIdSchema } from '@/validators/social.validator';

/**
 * `PATCH /api/admin/reports/:reportId`
 *
 * Resolves one report as actioned or dismissed. Moderators only.
 *
 * Upholding a report does not itself punish anybody, deliberately: an account
 * that should be removed is removed by an operator who looked at it. A status
 * that could ban would make the report button a weapon, which is exactly what
 * the queue exists to prevent.
 */
type Context = { params: Promise<{ reportId: string }> };

export const PATCH = withErrorHandling(async (request: Request, context: Context) => {
  const user = await requireUser(request);
  enforceHttpLimit('moderation', clientIdentity(request, user.id));

  await connectToDatabase();

  const { reportId } = await context.params;
  const body = await parseBody(request, resolveReportSchema);

  return ok(
    await reportReviewService.resolve({
      actorId: user.id,
      reportId: objectIdSchema.parse(reportId),
      status: (body.status ?? REPORT_STATUS.dismissed) as ReportStatusWire,
      note: body.note,
    }),
  );
});

export const dynamic = 'force-dynamic';
