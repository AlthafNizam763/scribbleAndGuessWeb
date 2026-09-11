import { config as loadDotenv } from 'dotenv';
import { z } from 'zod';

/**
 * Environment parsing, done once and validated up front.
 *
 * Anything missing or malformed is a startup failure rather than a surprise at
 * the first request: a server that boots without a `JWT_SECRET` would happily
 * mint tokens nobody can verify, and a typo'd Mongo URI would only show up
 * when the first player tried to sign in.
 */

// `.env.local` wins over `.env`, matching Next.js's own precedence. Neither is
// loaded in production, where real deployments inject variables directly.
loadDotenv({ path: '.env.local' });
loadDotenv();

/**
 * Whether this module is being evaluated by `next build` rather than by a
 * running server.
 *
 * `next build` imports every route handler to collect page data, so this file
 * runs on the build machine too — and a build machine has no business holding
 * the production signing key. Throwing there turns a missing secret into a
 * failed *build* rather than a failed *boot*, and Next reports it as a
 * prerender error on `/500` rather than as the configuration problem it is.
 *
 * Next sets `NEXT_PHASE` immediately before forking the workers that do that
 * collection, so the flag is visible exactly where it is needed. Nothing is
 * relaxed for a real server: `server.ts` boots with this unset and gets the
 * full strict parse below, so a genuinely misconfigured deployment still
 * refuses to start rather than minting tokens nobody can verify.
 */
const isBuildPhase = process.env.NEXT_PHASE === 'phase-production-build';

/**
 * Stand-in used only while collecting page data. It never reaches a running
 * server, and it is deliberately recognisable if it somehow did.
 */
const BUILD_PLACEHOLDER_SECRET = 'build-phase-placeholder-not-a-real-secret';

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),

  MONGODB_URI: z
    .string()
    .min(1, 'MONGODB_URI is required')
    .default('mongodb://localhost:27017/scribbleAndGuess'),

  /**
   * Database name, when it should not come from the URI's path. Atlas strings
   * usually end in `/admin` — the database the credentials authenticate
   * against, not the one holding the game data — so naming the target here
   * keeps the two separate. Left unset, the URI's own path decides.
   */
  MONGODB_DB: z.string().min(1).optional(),

  /**
   * The signing key. Refused in production when it is short or still the
   * placeholder, because a guessable key means anybody can mint a token for
   * any user id.
   */
  JWT_SECRET: isBuildPhase
    ? z.string().min(1).default(BUILD_PLACEHOLDER_SECRET)
    : z.string().min(1, 'JWT_SECRET is required'),
  JWT_EXPIRES_IN: z.string().default('30d'),

  PORT: z.coerce.number().int().positive().default(3000),
  HOST: z.string().default('0.0.0.0'),

  NEXT_PUBLIC_API_URL: z.string().default('http://localhost:3000'),
  SOCKET_URL: z.string().default('http://localhost:3000'),

  CORS_ORIGIN: z.string().default('*'),
  LOG_LEVEL: z.enum(['error', 'warn', 'info', 'debug']).default('info'),
});

const parsed = schema.safeParse(process.env);

if (!parsed.success) {
  const problems = parsed.error.issues
    .map((issue) => `  - ${issue.path.join('.') || '(root)'}: ${issue.message}`)
    .join('\n');
  throw new Error(
    `Invalid environment configuration:\n${problems}\n\n` +
      'Copy .env.example to .env.local and fill it in.',
  );
}

const raw = parsed.data;

const isProduction = raw.NODE_ENV === 'production';

if (isProduction && !isBuildPhase) {
  if (raw.JWT_SECRET.length < 32 || raw.JWT_SECRET.includes('change-me')) {
    throw new Error(
      'JWT_SECRET is too weak for production. Generate one with:\n' +
        '  node -e "console.log(require(\'crypto\').randomBytes(48).toString(\'hex\'))"',
    );
  }
}

/** The parsed, validated environment. */
export const env = {
  nodeEnv: raw.NODE_ENV,
  isProduction,
  isDevelopment: raw.NODE_ENV === 'development',
  isTest: raw.NODE_ENV === 'test',

  mongodbUri: raw.MONGODB_URI,
  mongodbDb: raw.MONGODB_DB,

  jwtSecret: raw.JWT_SECRET,
  jwtExpiresIn: raw.JWT_EXPIRES_IN,

  port: raw.PORT,
  host: raw.HOST,

  apiUrl: raw.NEXT_PUBLIC_API_URL,
  socketUrl: raw.SOCKET_URL,

  /**
   * Allowed browser origins. Native Flutter clients send no `Origin` header at
   * all, so this only constrains web callers.
   */
  corsOrigins: raw.CORS_ORIGIN === '*' ? '*' : raw.CORS_ORIGIN.split(',').map((o) => o.trim()),

  logLevel: raw.LOG_LEVEL,
} as const;

export type Env = typeof env;
