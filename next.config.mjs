/**
 * Next.js is used here purely as an HTTP/REST framework.
 *
 * There is no game UI and no admin panel in this project (brief sections 62
 * and 63): the only page served is a minimal status page at `/`. Socket.IO is
 * attached to the same HTTP server by `server.ts`, which is why the app is
 * booted through a custom server rather than `next start`.
 */
/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  // Mongoose ships optional native deps that must not be bundled into the
  // server build; keeping it external also preserves the single connection
  // cache across route handlers.
  serverExternalPackages: ['mongoose'],
};

export default nextConfig;
