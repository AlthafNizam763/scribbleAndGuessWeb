import { authController } from '@/controllers/auth.controller';
import { withErrorHandling } from '@/middleware/error.middleware';

/**
 * `POST /api/auth/register` — create an email account, or upgrade a guest.
 *
 * Sending the caller's existing guest token with this request is what keeps
 * their history: the account is upgraded in place rather than duplicated.
 */
export const POST = withErrorHandling((request: Request) => authController.register(request));

/**
 * Route handlers must not be prerendered or cached: every one of them reads a
 * header, touches the database, or both.
 */
export const dynamic = 'force-dynamic';
