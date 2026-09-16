import { beforeEach, describe, expect, it, vi } from 'vitest';

import { INPUT_LIMITS } from '@/constants/game.constants';
import { chatExtrasService } from '@/services/chat.service';
import { voiceService } from '@/services/voice.service';
import { ErrorCode } from '@/utils/errors';
import { containsProfanity, maskProfanity } from '@/utils/wordFilter';
import { CHAT_REACTIONS, chatReactSchema } from '@/validators/guess.validator';
import { makePlayer, makeRoom, makeRound } from './helpers';

/**
 * Chat extras and the room's communication switches.
 *
 * ## What is worth asserting
 *
 * The word filter is the piece most likely to cause a bug nobody reports: a
 * false positive stars an innocent word and looks like a glitch, and a filter
 * applied in the wrong order would make a round unwinnable. Both are pinned
 * here.
 *
 * The rest is permission: who may delete a message, who may react, and what
 * the host's two switches actually turn off. Those are checked against the
 * services rather than trusted, because every one of them is a rule a client
 * would otherwise be free to ignore.
 */

const ANA = '507f1f77bcf86cd799439011';
const BO = '507f1f77bcf86cd799439012';

beforeEach(() => {
  vi.restoreAllMocks();
});

describe('the word filter', () => {
  it('masks a blocked word and leaves the rest of the line alone', () => {
    const { text, masked } = maskProfanity('what the fuck is that');

    expect(masked).toBe(true);
    expect(text).toBe('what the **** is that');
  });

  it('catches the common character substitutions', () => {
    expect(containsProfanity('sh1t')).toBe(true);
  });

  /**
   * Self-censored text is already censored. Folding `*` away would turn
   * `f*ck` into `fck` — which matches nothing — while merging unrelated
   * words into each other, so it is deliberately not attempted.
   */
  it('leaves self-censored text as the sender wrote it', () => {
    expect(maskProfanity('f*ck').masked).toBe(false);
    expect(containsProfanity('$hit')).toBe(true);
  });

  /**
   * The classic way these filters embarrass themselves. Whole tokens only —
   * a substring match would star the middle of both of these.
   */
  it('does not star an innocent word that contains a blocked one', () => {
    expect(containsProfanity('Scunthorpe')).toBe(false);
    expect(containsProfanity('assassin')).toBe(false);
    expect(containsProfanity('classic')).toBe(false);
    expect(containsProfanity('grape')).toBe(false);
  });

  it('leaves an ordinary message completely untouched', () => {
    const { text, masked } = maskProfanity('is it a guitar or a violin');

    expect(masked).toBe(false);
    expect(text).toBe('is it a guitar or a violin');
  });

  it('preserves spacing so the line still reads', () => {
    expect(maskProfanity('a  b').text).toBe('a  b');
  });

  it('ignores very short tokens rather than guessing at them', () => {
    expect(containsProfanity('a s d')).toBe(false);
  });
});

describe('the chat index', () => {
  function roomWithPlayers() {
    return makeRoom({
      players: [makePlayer({ userId: ANA }), makePlayer({ userId: BO })],
    });
  }

  it('remembers a message so it can be acted on', () => {
    const room = roomWithPlayers();
    chatExtrasService.remember(room, 'm-1', ANA);

    expect(room.chat.recent.get('m-1')?.senderId).toBe(ANA);
  });

  /**
   * The index is bounded because it is a convenience, not a record — the
   * transcript in Mongo is the durable one. A room chatting all evening must
   * not grow it without limit.
   */
  it('evicts the oldest message past the limit', () => {
    const room = roomWithPlayers();

    for (let i = 0; i < INPUT_LIMITS.chatIndexLimit + 10; i += 1) {
      chatExtrasService.remember(room, `m-${i}`, ANA);
    }

    expect(room.chat.recent.size).toBe(INPUT_LIMITS.chatIndexLimit);
    expect(room.chat.recent.has('m-0')).toBe(false);
    expect(room.chat.recent.has(`m-${INPUT_LIMITS.chatIndexLimit + 9}`)).toBe(true);
  });

  describe('reactions', () => {
    it('adds, tallies and toggles off', () => {
      const room = roomWithPlayers();
      chatExtrasService.remember(room, 'm-1', ANA);

      expect(chatExtrasService.react(room, 'm-1', BO, '👍')).toEqual({ '👍': 1 });
      expect(chatExtrasService.react(room, 'm-1', ANA, '👍')).toEqual({ '👍': 2 });

      // The same tap takes it back, and the emoji disappears when nobody is
      // left holding it rather than lingering at zero.
      expect(chatExtrasService.react(room, 'm-1', BO, '👍')).toEqual({ '👍': 1 });
      expect(chatExtrasService.react(room, 'm-1', ANA, '👍')).toEqual({});
    });

    /**
     * A reaction is a toggle, so repeated taps alternate — they do not stack.
     * A set holds the reactors, which is what makes one player's contribution
     * exactly one whatever they do, rather than a counter a double tap could
     * run up.
     */
    it('never counts one player more than once', () => {
      const room = roomWithPlayers();
      chatExtrasService.remember(room, 'm-1', ANA);

      for (let taps = 1; taps <= 6; taps += 1) {
        const tally = chatExtrasService.react(room, 'm-1', BO, '🔥');
        // On, off, on, off — and never two.
        expect(tally).toEqual(taps % 2 === 1 ? { '🔥': 1 } : {});
      }
    });

    it('reports a message that has fallen out of the index', () => {
      const room = roomWithPlayers();
      expect(chatExtrasService.react(room, 'gone', BO, '👍')).toBeNull();
    });

    /**
     * An open emoji field would be a second text channel — one that skips the
     * length limit, the mask and the rate limiter.
     */
    it('refuses an emoji outside the fixed set', () => {
      expect(() =>
        chatReactSchema.parse({ messageId: 'm-1', emoji: '🖕' }),
      ).toThrow();

      for (const emoji of CHAT_REACTIONS) {
        expect(chatReactSchema.parse({ messageId: 'm-1', emoji }).emoji).toBe(emoji);
      }
    });
  });

  describe('deletion', () => {
    it('lets an author withdraw their own message', async () => {
      const room = roomWithPlayers();
      chatExtrasService.remember(room, 'm-1', ANA);

      await chatExtrasService.remove(room, 'm-1', ANA);

      expect(room.chat.recent.has('m-1')).toBe(false);
    });

    /** Authorship comes from the index, so a crafted id deletes nothing. */
    it('refuses to delete somebody else’s message', async () => {
      const room = roomWithPlayers();
      chatExtrasService.remember(room, 'm-1', ANA);

      const error = await chatExtrasService
        .remove(room, 'm-1', BO)
        .catch((thrown: unknown) => thrown);

      expect((error as { code: string }).code).toBe(ErrorCode.INVALID_ACTION);
      expect(room.chat.recent.has('m-1')).toBe(true);
    });

    it('refuses a message it no longer knows about', async () => {
      const room = roomWithPlayers();

      const error = await chatExtrasService
        .remove(room, 'gone', ANA)
        .catch((thrown: unknown) => thrown);

      expect((error as { code: string }).code).toBe(ErrorCode.NOT_FOUND);
    });
  });
});

describe('the voice switch', () => {
  /** A room mid-turn, with Ana drawing and Bo guessing. */
  function playingRoom(voiceEnabled: boolean) {
    const room = makeRoom({
      players: [makePlayer({ userId: ANA }), makePlayer({ userId: BO })],
      phase: 'drawing',
    });
    room.round = makeRound({ drawerId: ANA });
    room.settings = { ...room.settings, voiceEnabled };
    return room;
  }

  it('admits a guesser while voice is on', () => {
    const room = playingRoom(true);
    expect(() => voiceService.assertMayUseVoice(room, BO)).not.toThrow();
  });

  it('refuses everybody while voice is off', () => {
    const room = playingRoom(false);
    expect(() => voiceService.assertMayUseVoice(room, BO)).toThrow();
  });

  /**
   * The rule the whole voice feature exists for still wins: a drawer is
   * refused for *being the drawer*, not for the room setting, so the specific
   * error code survives.
   */
  it('still refuses the drawer with the drawer code', () => {
    const room = playingRoom(true);

    const error = (() => {
      try {
        voiceService.assertMayUseVoice(room, ANA);
        return null;
      } catch (thrown) {
        return thrown;
      }
    })();

    expect((error as { code: string }).code).toBe(ErrorCode.DRAWER_VOICE_DISABLED);
  });

  it('reports voice as off in the state a client is handed', () => {
    expect(voiceService.stateFor(playingRoom(false), BO).enabled).toBe(false);
    expect(voiceService.stateFor(playingRoom(true), BO).enabled).toBe(true);
  });
});
