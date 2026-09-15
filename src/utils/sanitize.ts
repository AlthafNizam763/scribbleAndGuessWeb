import { INPUT_LIMITS } from '@/constants/game.constants';

/**
 * Making a stored name safe to *render*, wherever it is about to be rendered.
 *
 * ## Why this exists when usernames are already validated
 *
 * `auth.validator.ts` bounds a name when an account is created, and that is
 * the right place for it. This is the second lock, and it guards a different
 * door: the public room list and the invitation inbox show names to people who
 * have no relationship with their owner, and those names come off rows that
 * may predate any given validation rule. A name written before a rule tightened
 * is still in the database.
 *
 * ## What it does and deliberately does not do
 *
 * It removes the characters that break a *layout* rather than a parser:
 * control codes, the bidirectional-override runs used to make text read
 * backwards, and zero-width characters used to fake a duplicate of somebody
 * else's name. Then it collapses whitespace and clamps the length.
 *
 * It does not escape HTML. Both clients render text as text — Flutter has no
 * HTML at all, React escapes by construction — so escaping here would not
 * prevent an injection that cannot happen, it would show people `&amp;` in
 * their own names. Encoding belongs at the boundary that needs it, and neither
 * of ours does.
 */

/** Control codes, bidi overrides, and zero-width joiners and spaces. */
const UNSAFE =
  // eslint-disable-next-line no-control-regex -- stripping control codes is the point
  /[\u0000-\u001F\u007F-\u009F\u200B-\u200F\u2028\u2029\u202A-\u202E\u2066-\u2069\uFEFF]/g;

/**
 * A display name, safe to put in a list.
 *
 * Falls back to `Player` rather than to an empty string: a row with no name is
 * a row nobody can refer to, and an invitation from nobody is worse than an
 * invitation from a placeholder.
 */
export function sanitizeName(value: string | null | undefined): string {
  const cleaned = (value ?? '')
    .replace(UNSAFE, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, INPUT_LIMITS.maxNameLength);

  return cleaned.length > 0 ? cleaned : 'Player';
}

/**
 * A room's display name, built from its host's.
 *
 * Rooms have no name of their own in this game — they have a code, which is
 * what people actually share. Naming them after the host is what makes a list
 * of five rooms scannable, and building it here rather than on each client is
 * what keeps the Flutter app and the web app from spelling it two ways.
 */
export function roomDisplayName(hostName: string | null | undefined): string {
  const host = sanitizeName(hostName);
  return host.endsWith('s') ? `${host}' room` : `${host}'s room`;
}
