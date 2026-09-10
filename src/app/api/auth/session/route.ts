import { authController } from '@/controllers/auth.controller';
import { withErrorHandling } from '@/middleware/error.middleware';

/** `GET /api/auth/session` — verify a stored token and return its user. */
export const GET = withErrorHandling((request: Request) => authController.session(request));

export const dynamic = 'force-dynamic';
