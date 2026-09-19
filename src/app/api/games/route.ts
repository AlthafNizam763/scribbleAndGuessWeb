import { gamePlatformController } from '@/controllers/game_platform.controller';
import { withErrorHandling } from '@/middleware/error.middleware';

/** The single authoritative catalogue. It always returns exactly five games. */
export const GET = withErrorHandling((request: Request) => gamePlatformController.list(request));
export const dynamic = 'force-dynamic';
