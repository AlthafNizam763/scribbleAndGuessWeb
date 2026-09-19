import { BOT_DIFFICULTY, type BotDifficultyWire } from '@/constants/autoTournament.constants';
import { GAME_PHASE } from '@/constants/room.constants';
import { botProfileService, type BotIdentity } from '@/services/bot/botProfile.service';
import { roomService } from '@/services/room.service';
import type { RuntimeRoom } from '@/types/socket.types';
import { errors } from '@/utils/errors';
import { logger } from '@/utils/logger';

/**
 * PLAY WITH STUPID: seating the platform's bot cast into an ordinary room.
 *
 * ## What this is, and what it is not
 *
 * It is a seating service, and only that. Every Stupid it seats is played by
 * the existing `botPlayerService`, which is driven from `gameService`'s own
 * broadcast funnel — so a Stupid picks words, draws and guesses through the
 * same engine calls a person does, is judged by the same rules, and cannot see
 * anything a person in its seat could not. **There is no second game engine
 * here and there must never be one**: that is what stops a bot cheating, and
 * it is why this file is forty lines rather than four hundred.
 *
 * The tournament fill service does the same job for brackets. This is the
 * player-facing door to the same machinery, which until now had none — the
 * bots existed and worked, but nothing a player could tap would seat one.
 *
 * ## Why the host, and why a cap
 *
 * Seating a Stupid changes the room for everybody in it, so it is a host
 * action like kicking or changing the settings, and it is refused once the
 * match has started for the same reason a join is: turn order and scores are
 * already fixed by then.
 *
 * The cap is the room's own `maxPlayers`. A room with no people left in it is
 * refused outright: seating bots into an empty room would keep alive a room the
 * engine is otherwise about to close.
 */
export class StupidsService {
  /**
   * Seats up to [count] Stupids in [room].
   *
   * Returns the ones actually seated, which may be fewer than asked for when
   * the room is nearly full or the roster is smaller than the request. Fewer
   * is not an error: somebody who taps "add 4" into a room with two free seats
   * wants those two seats filled, not a refusal.
   */
  async seat(input: {
    room: RuntimeRoom;
    actorId: string;
    count: number;
    difficulty?: BotDifficultyWire;
  }): Promise<BotIdentity[]> {
    const { room, actorId } = input;

    roomService.assertHost(room, actorId);
    if (room.phase !== GAME_PHASE.lobby) {
      throw errors.invalidAction('Add Stupids before the game starts.');
    }

    const free = room.settings.maxPlayers - room.players.size;
    const humans = [...room.players.values()].filter((player) => !player.isBot).length;
    if (humans === 0) {
      // Defensive: a room with no people in it is one the engine is about to
      // close anyway, and seating bots into it would keep it alive forever.
      throw errors.invalidAction('This room has no players in it.');
    }

    const seats = Math.max(0, Math.min(input.count, free));
    if (seats === 0) {
      throw errors.invalidAction('This room is full.');
    }

    // Already-seated bots are skipped rather than re-seated: `take` returns a
    // distinct slice, but a second tap would otherwise hand back the same
    // first entries and quietly overwrite their seats.
    const seated = new Set(
      [...room.players.values()].map((player) => player.botId).filter(Boolean),
    );

    const roster = await botProfileService.take({
      // Over-asked so the filter below still has candidates left once the
      // Stupids already in the room are dropped.
      count: seats + seated.size,
      difficulty: input.difficulty ?? BOT_DIFFICULTY.normal,
      // Rotates on the room, so two rooms open at once do not both field Mr
      // Whiskers while Big Yawn never plays.
      rotationKey: room.roomId,
    });

    const picked = roster
      .filter((identity) => !seated.has(identity.botId))
      .slice(0, seats);

    for (const identity of picked) {
      roomService.seatBot(room, {
        playerId: identity.playerId,
        botId: identity.botId,
        displayName: identity.displayName,
        avatarId: identity.avatarId,
        avatarColorIndex: identity.avatarColorIndex,
        difficulty: identity.difficulty,
      });
    }

    if (picked.length > 0) await roomService.persist(room);

    logger.info('stupids seated', {
      roomId: room.roomId,
      asked: input.count,
      seated: picked.length,
    });

    return picked;
  }

  /**
   * Removes every Stupid from [room].
   *
   * The counterpart to [seat], and the reason the button is not a one-way
   * door: a host who filled a room with Stupids and then had four friends
   * arrive needs the seats back.
   */
  async clear(room: RuntimeRoom, actorId: string): Promise<number> {
    roomService.assertHost(room, actorId);
    if (room.phase !== GAME_PHASE.lobby) {
      throw errors.invalidAction('Remove Stupids before the game starts.');
    }

    let removed = 0;
    for (const [playerId, player] of [...room.players.entries()]) {
      if (!player.isBot) continue;
      room.players.delete(playerId);
      removed++;
    }

    if (removed > 0) await roomService.persist(room);
    return removed;
  }
}

export const stupidsService = new StupidsService();
