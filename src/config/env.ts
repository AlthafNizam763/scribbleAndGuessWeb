import { config as loadDotenv } from 'dotenv';
import { z } from 'zod';

import { isKnownTimeZone } from '@/utils/dayKey';

/** A 24-hour wall-clock time. What the tournament slot times are written as. */
const CLOCK = /^([01]\d|2[0-3]):([0-5]\d)$/;

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
   * ## Why there is no slot *count*
   *
   * Because three is not a quantity here, it is three named times of day. The
   * old rolling system had a configurable number of concurrent slots; this one
   * has a morning, an afternoon and an evening, and a deployment that wanted a
   * fourth would be asking for a different product rather than a bigger
   * number. The times themselves are configurable, which is the part an
   * operator actually needs.
   *
   * ## The timezone
   *
   * Everything below is read in this zone: which calendar day it is, and what
   * "20:00" means. It is configured rather than taken from the host because
   * the host is in whichever region the platform put it, and the promise is
   * about the player's day, not the datacentre's. An unknown zone name fails
   * at boot rather than silently falling back to UTC — a tournament system
   * quietly running eleven hours out is worse than one that will not start.
   */
  TOURNAMENT_TIMEZONE: z
    .string()
    .default('Asia/Kolkata')
    .refine(isKnownTimeZone, 'not a timezone this runtime knows'),

  /**
   * When each daily tournament begins, as `HH:MM` in `TOURNAMENT_TIMEZONE`.
   *
   * These are the only times in the system an operator sets directly.
   * Everything else — when registration opens, when it closes, when check-in
   * ends — is measured backwards from them, because the start is the part that
   * was published and the windows in front of it are arrangements.
   */
  TOURNAMENT_MORNING_AT: z.string().regex(CLOCK, 'expected HH:MM').default('10:00'),
  TOURNAMENT_AFTERNOON_AT: z.string().regex(CLOCK, 'expected HH:MM').default('15:00'),
  TOURNAMENT_EVENING_AT: z.string().regex(CLOCK, 'expected HH:MM').default('20:00'),

  /**
   * How many days ahead the organiser prepares.
   *
   * One: today and tomorrow. Enough that the day rolls over with the next
   * three tournaments already published — so a player opening the app just
   * after midnight sees a schedule rather than an empty screen — and not so
   * far that a change to the times takes a week to take effect.
   */
  TOURNAMENT_PREPARE_DAYS_AHEAD: z.coerce.number().int().min(0).max(7).default(1),

  TOURNAMENT_MIN_PLAYERS: z.coerce.number().int().min(2).max(16).default(4),
  TOURNAMENT_MAX_PLAYERS: z.coerce.number().int().min(2).max(16).default(16),
  TOURNAMENT_MIN_HUMAN_PLAYERS: z.coerce.number().int().min(1).max(16).default(1),
  TOURNAMENT_MAX_BOTS: z.coerce.number().int().min(0).max(15).default(3),
  TOURNAMENT_ALLOW_BOTS: z
    .enum(['true', 'false'])
    .default('true')
    .transform((value) => value === 'true'),
  TOURNAMENT_BOT_DIFFICULTY: z.enum(['EASY', 'NORMAL', 'HARD']).default('NORMAL'),

  /**
   * How long before a tournament starts its registration opens, in minutes.
   *
   * Ninety. The window a player has to notice the thing exists and take a
   * place in it. Held above the check-in lead below, so there is always a
   * registration window to open at all.
   */
  TOURNAMENT_REGISTRATION_LEAD_MINUTES: z.coerce.number().min(2).max(1_440).default(90),

  /**
   * How long before the start registration closes and check-in opens.
   *
   * Ten minutes: how long a player has to confirm, and how much warning they
   * get that the thing they signed up for is about to happen.
   */
  TOURNAMENT_CHECKIN_LEAD_MINUTES: z.coerce.number().min(1).max(120).default(10),

  /**
   * The fast-start windows, in seconds.
   *
   * Only reached by a deployment running with check-in off, where a tournament
   * seals its roster on a timer rather than at a published start. Kept because
   * that deployment is still supported — see `checkInEnabled`.
   */
  TOURNAMENT_BOT_FILL_DELAY_SECONDS: z.coerce.number().min(0).max(3_600).default(45),
  TOURNAMENT_START_COUNTDOWN_SECONDS: z.coerce.number().min(3).max(300).default(15),

  /**
   * Whether registered players must confirm before the bracket is drawn.
   *
   * On by default, because registration for a scheduled tournament opens an
   * hour and a half before it starts and a bracket drawn from everybody who
   * tapped join at half past six would be half walkovers. See `checkInEnabled`
   * in `autoTournament.constants.ts`.
   */
  TOURNAMENT_CHECKIN_ENABLED: z
    .enum(['true', 'false'])
    .default('true')
    .transform((value) => value === 'true'),

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

  /**
   * Firebase Admin, for push notifications.
   *
   * ## Why a service account and not the client SDK's config
   *
   * Sending a push is a privileged operation: anybody holding these values can
   * deliver a notification to any device token in the project. They are a
   * server credential and are read here only — nothing in `src/web` or in the
   * Flutter client ever sees them. The client needs `google-services.json`,
   * which is a different, public-by-design file.
   *
   * ## Why all three default to empty
   *
   * Because a deployment without push configured has to keep working. Every
   * other feature in this codebase is unaffected by FCM, and a dev machine
   * that has never seen a service account should still boot, run the
   * scheduler, and run the tests. `push.service.ts` reports itself as
   * unconfigured and every send becomes a logged no-op — see `isConfigured`
   * there.
   */
  FIREBASE_PROJECT_ID: z.string().default(''),
  FIREBASE_CLIENT_EMAIL: z.string().default(''),

  /**
   * The service account's private key.
   *
   * Almost always supplied with literal `\n` two-character sequences, because
   * a PEM block cannot survive a single-line `.env` or most secret managers
   * otherwise. Converted to real newlines below; a key that already has them
   * passes through unchanged, so both forms work.
   */
  FIREBASE_PRIVATE_KEY: z.string().default(''),
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
    /** The zone the calendar day and every slot time are read in. */
    timeZone: raw.TOURNAMENT_TIMEZONE,

    /**
     * When each slot starts, as minutes after local midnight.
     *
     * Parsed here rather than where they are used, so a malformed clock is a
     * boot failure with the variable's name on it instead of a tournament
     * scheduled for `NaN`.
     */
    slotMinutes: {
      MORNING: clockMinutes(raw.TOURNAMENT_MORNING_AT),
      AFTERNOON: clockMinutes(raw.TOURNAMENT_AFTERNOON_AT),
      EVENING: clockMinutes(raw.TOURNAMENT_EVENING_AT),
    },

    /** How many days beyond today the organiser publishes. */
    prepareDaysAhead: raw.TOURNAMENT_PREPARE_DAYS_AHEAD,

    minPlayers: raw.TOURNAMENT_MIN_PLAYERS,
    maxPlayers: Math.max(raw.TOURNAMENT_MAX_PLAYERS, raw.TOURNAMENT_MIN_PLAYERS),
    minHumanPlayers: Math.min(raw.TOURNAMENT_MIN_HUMAN_PLAYERS, raw.TOURNAMENT_MIN_PLAYERS),
    maxBots: raw.TOURNAMENT_MAX_BOTS,
    allowBots: raw.TOURNAMENT_ALLOW_BOTS,
    botDifficulty: raw.TOURNAMENT_BOT_DIFFICULTY,

    /**
     * The two leads, with the registration lead held above the check-in lead.
     *
     * Clamped rather than validated apart, for the same reason `maxPlayers` is
     * floored at `minPlayers`: an operator who transposed them would otherwise
     * get tournaments whose registration closes before it opens, which is a
     * tournament nobody can ever join. A minute of registration is not much,
     * but it is a window, and the deployment boots.
     */
    registrationLeadMs: Math.max(
      Math.round(raw.TOURNAMENT_REGISTRATION_LEAD_MINUTES * 60_000),
      Math.round(raw.TOURNAMENT_CHECKIN_LEAD_MINUTES * 60_000) + 60_000,
    ),
    checkInLeadMs: Math.round(raw.TOURNAMENT_CHECKIN_LEAD_MINUTES * 60_000),

    /**
     * Held inside the registration window, rather than validated against it.
     *
     * Only the fast-start path reads this, and there a fill delay longer than
     * the window it sits inside would mean bots never arrive before
     * registration closes — the tournament would reach its deadline with an
     * unfilled roster every time. Clamping leaves a countdown's worth of room.
     */
    botFillDelayMs: Math.min(
      Math.round(raw.TOURNAMENT_BOT_FILL_DELAY_SECONDS * 1_000),
      Math.max(
        0,
        Math.round(raw.TOURNAMENT_REGISTRATION_LEAD_MINUTES * 60_000) -
          Math.round(raw.TOURNAMENT_CHECKIN_LEAD_MINUTES * 60_000) -
          Math.round(raw.TOURNAMENT_START_COUNTDOWN_SECONDS * 1_000),
      ),
    ),
    startCountdownMs: Math.round(raw.TOURNAMENT_START_COUNTDOWN_SECONDS * 1_000),

    checkInEnabled: raw.TOURNAMENT_CHECKIN_ENABLED,
    schedulerEnabled: raw.TOURNAMENT_SCHEDULER_ENABLED,
    schedulerSecret: raw.TOURNAMENT_SCHEDULER_SECRET,
  },

  /**
   * The Firebase service account used to send push notifications.
   *
   * `configured` is the single question every caller asks, answered once here
   * rather than by three separate emptiness checks scattered through the push
   * service.
   */
  firebase: {
    projectId: raw.FIREBASE_PROJECT_ID.trim(),
    clientEmail: raw.FIREBASE_CLIENT_EMAIL.trim(),
    /** Literal `\n` sequences turned back into real newlines. */
    privateKey: raw.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n'),
    configured:
      raw.FIREBASE_PROJECT_ID.trim().length > 0 &&
      raw.FIREBASE_CLIENT_EMAIL.trim().length > 0 &&
      raw.FIREBASE_PRIVATE_KEY.trim().length > 0,
  },
} as const;

/**
 * `HH:MM` as minutes after midnight.
 *
 * The schema has already refused anything that is not a clock, so this does no
 * validation of its own — it would be a second, weaker copy of the check that
 * already passed.
 */
function clockMinutes(value: string): number {
  const [hours, minutes] = value.split(':');
  return Number(hours) * 60 + Number(minutes);
}

/** Splits a comma-separated URL list, dropping blanks. */
function splitUrls(value: string): string[] {
  return value
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

export type Env = typeof env;
