import { progressionController } from '@/controllers/progression.controller';
import { withErrorHandling } from '@/middleware/error.middleware';

/**
 * `GET /api/progression/me`
 *
 * The caller's level, XP and full achievement catalogue in one read — which is
 * what the profile screen needs, and it needs all of it at once.
 */
export const GET = withErrorHandling((request: Request) => progressionController.me(request));

export const dynamic = 'force-dynamic';
