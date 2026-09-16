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

  /**
   * Shared secret required to read `/api/metrics` and `/metrics`.
   *
   * Empty — the default — leaves the endpoint open, which is right for a probe
   * on a private network and for reading numbers during a load test. Set it on
   * a deployment whose metrics endpoint is reachable from the internet: the
   * payload names no user, but it does describe how loaded the deployment is.
   */
  METRICS_TOKEN: z.string().default(''),
  LOG_LEVEL: z.enum(['error', 'warn', 'info', 'debug']).default('info'),

  /**
   * Voice chat's ICE configuration (brief: free STUN, optional self-hosted
   * TURN). Handed to clients over `s:voice:state` rather than compiled into
   * them, so a TURN server can be introduced — or its credentials rotated —
   * without shipping a new app build, and so no credential is ever written
   * down in the client bundle.
   *
   * Comma-separated lists are accepted for both URL variables.
   */
  WEBRTC_STUN_URL: z.string().default('stun:stun.l.google.com:19302'),
  WEBRTC_TURN_URL: z.string().default(''),
  WEBRTC_TURN_USERNAME: z.string().default(''),
  WEBRTC_TURN_CREDENTIAL: z.string().default(''),

  /**
   * The automatic tournament organiser.
   *
   * ## Why the slot count is configurable but capped
   *
   * The product rule is three, and three is the default. It is a variable
   * rather than a constant so a staging deployment can run one slot and a load
   * test can run more — but it is bounded, because each slot is a bracket, a
   * set of rooms and a pool of bot workers, and an operator typing a large
   * number would quietly commit this process to running all of them.
   */
  TOURNAMENT_SLOT_COUNT: z.coerce.number().int().min(1).max(10).default(3),
  TOURNAMENT_MIN_PLAYERS: z.coerce.number().int().min(2).max(16).default(4),
  TOURNAMENT_MAX_PLAYERS: z.coerce.number().int().min(2).max(16).default(16),
  TOURNAMENT_MIN_HUMAN_PLAYERS: z.coerce.number().int().min(1).max(16).default(1),
  TOURNAMENT_MAX_BOTS: z.coerce.number().int().min(0).max(15).default(3),
  TOURNAMENT_ALLOW_BOTS: z
    .enum(['true', 'false'])
    .default('true')
    .transform((value) => value === 'true'),
  TOURNAMENT_BOT_DIFFICULTY: z.enum(['EASY', 'NORMAL', 'HARD']).default('NORMAL'),

  /** Registration and check-in windows, in minutes. */
  TOURNAMENT_REGISTRATION_MINUTES: z.coerce.number().min(1).max(240).default(10),
  TOURNAMENT_CHECKIN_MINUTES: z.coerce.number().min(1).max(60).default(2),

  /**
   * Whether this process runs the scheduler loop itself.
   *
   * Off is the external-cron deployment: something outside calls
   * `POST /api/internal/tournaments/scheduler` and this process only serves
   * requests. On is the single-service deployment, where the loop runs here.
   * Both are safe at once — the distributed lock means a tick from either
   * source excludes the other — so this is about not paying for a timer you
   * are not using rather than about correctness.
   */
  TOURNAMENT_SCHEDULER_ENABLED: z
    .enum(['true', 'false'])
    .default('true')
    .transform((value) => value === 'true'),

  /**
   * The shared secret on the internal scheduler endpoint.
   *
   * Empty refuses every call in production — an unauthenticated endpoint that
   * creates and cancels tournaments is not something to leave open by default.
   * In development an empty secret allows the call, so the loop can be driven
   * by hand without configuration.
   */
  TOURNAMENT_SCHEDULER_SECRET: z.string().default(''),
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

  /** Gate on the metrics endpoints. Empty means no gate. */
  metricsToken: raw.METRICS_TOKEN,

  /** STUN URLs, in preference order. Empty disables STUN entirely. */
  webrtcStunUrls: splitUrls(raw.WEBRTC_STUN_URL),
  /** TURN URLs. Empty — the default — means no relay fallback is configured. */
  webrtcTurnUrls: splitUrls(raw.WEBRTC_TURN_URL),
  webrtcTurnUsername: raw.WEBRTC_TURN_USERNAME,
  webrtcTurnCredential: raw.WEBRTC_TURN_CREDENTIAL,

  /**
   * The automatic tournament organiser's configuration.
   *
   * Grouped into one object rather than spread across the top level because
   * every consumer wants the whole policy at once: a tournament is created by
   * copying this block onto the row, so that a tournament already taking
   * registrations keeps the rules it advertised even if this changes.
   *
   * `maxPlayers` is floored at `minPlayers` rather than validated apart from
   * it: a deployment that set a minimum above its maximum would otherwise
   * create tournaments that can never legally start, and failing to boot over
   * a transposed pair of numbers helps nobody.
   */
  tournament: {
    slotCount: raw.TOURNAMENT_SLOT_COUNT,
    minPlayers: raw.TOURNAMENT_MIN_PLAYERS,
    maxPlayers: Math.max(raw.TOURNAMENT_MAX_PLAYERS, raw.TOURNAMENT_MIN_PLAYERS),
    minHumanPlayers: Math.min(raw.TOURNAMENT_MIN_HUMAN_PLAYERS, raw.TOURNAMENT_MIN_PLAYERS),
    maxBots: raw.TOURNAMENT_MAX_BOTS,
    allowBots: raw.TOURNAMENT_ALLOW_BOTS,
    botDifficulty: raw.TOURNAMENT_BOT_DIFFICULTY,
    registrationMs: Math.round(raw.TOURNAMENT_REGISTRATION_MINUTES * 60_000),
    checkInMs: Math.round(raw.TOURNAMENT_CHECKIN_MINUTES * 60_000),
    schedulerEnabled: raw.TOURNAMENT_SCHEDULER_ENABLED,
    schedulerSecret: raw.TOURNAMENT_SCHEDULER_SECRET,
  },
} as const;

/** Splits a comma-separated URL list, dropping blanks. */
function splitUrls(value: string): string[] {
  return value
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

export type Env = typeof env;
