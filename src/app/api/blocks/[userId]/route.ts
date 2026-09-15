import { blockController } from '@/controllers/block.controller';
import { withErrorHandling } from '@/middleware/error.middleware';

/**
 * `POST /api/blocks/:userId` — block a player.
 * `DELETE /api/blocks/:userId` — lift that block.
 *
 * The path names the person being blocked; the blocker is always the token, so
 * no request can plant or lift a block in somebody else's name. Blocking also
 * ends any friendship and cancels any pending request in either direction;
 * unblocking restores neither.
 */
type Context = { params: Promise<{ userId: string }> };

export const POST = withErrorHandling(async (request: Request, context: Context) => {
  const { userId } = await context.params;
  return blockController.block(request, userId);
});

export const DELETE = withErrorHandling(async (request: Request, context: Context) => {
  const { userId } = await context.params;
  return blockController.unblock(request, userId);
});

export const dynamic = 'force-dynamic';
