import { authController } from '@/controllers/auth.controller';
import { withErrorHandling } from '@/middleware/error.middleware';

/** `POST /api/auth/login` — exchange an email and password for a JWT. */
export const POST = withErrorHandling((request: Request) => authController.login(request));

/**
 * Route handlers must not be prerendered or cached: every one of them reads a
 * header, touches the database, or both.
 */
export const dynamic = 'force-dynamic';
