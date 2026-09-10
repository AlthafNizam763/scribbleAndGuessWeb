import { connectToDatabase } from '@/config/database';
import { authService } from '@/services/auth.service';
import type { AuthenticatedUser } from '@/types/auth.types';
import { errors } from '@/utils/errors';

/**
 * Bearer-token authentication for the REST layer.
 *
 * One function, used by every protected route. It opens the database
 * connection first, because resolving a token means loading the user, and a
 * route that authenticated without a connection would fail confusingly deep
 * inside Mongoose instead of here.
 */

/** Pulls the token out of an `Authorization: Bearer <token>` header. */
export function bearerToken(request: Request): string | null {
  const header = request.headers.get('authorization') ?? request.headers.get('Authorization');
  if (!header) return null;

  const [scheme, token] = header.split(' ');
  if (!scheme || scheme.toLowerCase() !== 'bearer' || !token) return null;

  return token.trim() || null;
}

/** Resolves the caller, or throws `AUTH_ERROR`. */
export async function requireUser(request: Request): Promise<AuthenticatedUser> {
  const token = bearerToken(request);
  if (!token) throw errors.auth('Sign in to do that.');

  await connectToDatabase();
  return authService.authenticate(token);
}

/** Resolves the caller if there is one, without failing when there is not. */
export async function optionalUser(request: Request): Promise<AuthenticatedUser | null> {
  const token = bearerToken(request);
  if (!token) return null;

  try {
    await connectToDatabase();
    return await authService.authenticate(token);
  } catch {
    // A bad token on an optional route is the same as no token: the caller
    // gets the anonymous view rather than an error they did not ask for.
    return null;
  }
}
