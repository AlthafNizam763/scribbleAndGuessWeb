/**
 * Next.js is used here purely as an HTTP/REST framework.
 *
 * There is no game UI and no admin panel in this project (brief sections 62
 * and 63): the only page served is a minimal status page at `/`. Socket.IO is
 * attached to the same HTTP server by `server.ts`, which is why the app is
 * booted through a custom server rather than `next start`.
 */
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const projectRoot = dirname(fileURLToPath(import.meta.url));

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  // Mongoose ships optional native deps that must not be bundled into the
  // server build; keeping it external also preserves the single connection
  // cache across route handlers.
  serverExternalPackages: ['mongoose'],

  /**
   * `@/*` resolution, stated here rather than inherited from `tsconfig.json`.
   *
   * Next only reads `tsconfig.json` when the `typescript` package resolves
   * (`load-jsconfig.js` gates on it). On a build machine that installed
   * without devDependencies — which is what `NODE_ENV=production` does to
   * `npm install` — the aliases vanish and every `@/...` import in
   * `src/app/api` fails to resolve. The build then dies while prerendering
   * the Pages Router's fallback `/500`, reporting the misleading
   * "<Html> should not be imported outside of pages/_document".
   *
   * `.npmrc` keeps `typescript` installed, so this is the second lock on the
   * same door: the alias is now a fact about the build, not a side effect of
   * which packages happen to be present.
   */
  webpack: (config) => {
    config.resolve.alias = {
      ...config.resolve.alias,
      '@': join(projectRoot, 'src'),
    };
    return config;
  },
};

export default nextConfig;
