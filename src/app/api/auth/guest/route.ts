import { authController } from '@/controllers/auth.controller';
import { withErrorHandling } from '@/middleware/error.middleware';

/**
 * `POST /api/auth/guest` — create a guest account and return a JWT.
 *
 * Route files stay this thin on purpose: they bind a method to a controller
 * and wrap it in the shared error funnel, so the response shape and the error
 * vocabulary cannot drift between endpoints.
 */
export const POST = withErrorHandling((request: Request) => authController.guest(request));

/**
 * Route handlers must not be prerendered or cached: every one of them reads a
 * header, touches the database, or both.
 */
export const dynamic = 'force-dynamic';
