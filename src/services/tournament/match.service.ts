import {
  AUTO_TOURNAMENT_DEFAULTS,
  AUTO_TOURNAMENT_STATUS,
  MATCH_OUTCOME,
  MATCH_STATUS,
  REGISTRATION_STATUS,
  type BotDifficultyWire,
} from '@/constants/autoTournament.constants';
import { GAME_PHASE } from '@/constants/room.constants';
import {
  AutoTournament,
  TournamentRegistration,
  type TournamentRegistrationDocument,
} from '@/models/AutoTournament';
import { TournamentMatch, type TournamentMatchDocument } from '@/models/TournamentMatch';
import { botProfileService } from '@/services/bot/botProfile.service';
import { chatService } from '@/services/chat.service';
import { defaultSettings, roomService } from '@/services/room.service';
import { announceToPlayer, announceTournament } from '@/services/tournament/notify';
import type { PlayerScoreDto } from '@/types/game.types';
import type { RoomSettingsDto } from '@/types/room.types';
import type { RuntimeRoom } from '@/types/socket.types';
import { errors } from '@/utils/errors';
import { logger } from '@/utils/logger';

/**
 * Running a bracket match on the existing game engine.
 *
 * ## The whole design, in one paragraph
 *
 * A tournament match is an ordinary room. It is created through the same room
 * service, seated through the same seating code, started through the same
 * `startGame`, played under the same turn order, word selection, drawing relay
 * and scoring, and finished by the same `endGame`. What makes it a *tournament*
 * match is two small things bolted to the side: the room refuses anybody who
 * is not one of the two players, and it carries a back-reference so the result
 * can be reported to the bracket. There is no second engine, no parallel
 * scoring, and no path by which a tournament result is anything other than
 * what the engine computed.
 *
 * ## How a match actually begins
 *
 * The bracket opens the room and tells the two players. Each of them enters —
 * over REST for the code, then over the socket for the seat. As soon as every
 * *human* in the pairing has a live socket in the room, the match starts. If
 * one of them never turns up, the entry deadline decides it instead: a
 * walkover for the player who did, or a cancellation if neither did.
 *
 * Bots need none of that. They are seated the instant the room opens and are
 * never waited for, because there is nothing to wait for.
 *
 * ## Idempotency
 *
 * Every write that decides a match is conditional on the match not already
 * being decided, and advancement happens only on a write that actually
 * modified a row. That is what makes this safe against the three things that
 * genuinely happen: the engine ending a match while a deadline sweep is
 * examining it, two scheduler ticks overlapping, and a restart mid-transition.
 */

/**
 * Rooms whose match is being started right now.
 *
 * `onRoomStateChanged` is called from the engine's broadcast funnel, which
 * fires several times during a single join — a resume check, a state
 * broadcast, a presence line. Without this, two of those could each decide the
 * room is ready and call `startGame` twice; the second would throw
 * `GAME_ALREADY_STARTED`, which is harmless but would be logged as a failure
 * on every single tournament match.
 */
const starting = new Set<string>();

/** The one thing this service needs from the game engine. */
export interface MatchEngine {
  startGame(room: RuntimeRoom, actorId: string): Promise<void>;
}

export class TournamentMatchService {
  /**
   * The game engine, handed over at boot.
   *
   * ## Why it is injected rather than imported
   *
   * `game.service.ts` imports this module — that is how a finished match
   * reaches the bracket — so importing it back would make a cycle whose
   * resolution depends on which module Node happens to load first. The failure
   * mode is a match service holding an undefined engine that silently never
   * starts anything, which is exactly the kind of bug that only appears in
   * production because the test suite imported the modules in the other order.
   *
   * The same arrangement, for the same reason, as the bot driver's engine.
   */
  private engine: MatchEngine | null = null;

  /** Called once at boot, from the bottom of `game.service.ts`. */
  bindEngine(engine: MatchEngine): void {
    this.engine = engine;
  }

  /**
   * The settings every bracket match plays under.
   *
   * Derived from the ordinary defaults rather than invented, so a tournament
   * match is recognisably the same game. Four things are pinned:
   *
   * - **Two seats.** A knockout pairing is one against one.
   * - **Two rounds**, so each player draws once. A single round would decide a
   *   knockout on who happened to draw, which is not a contest.
   * - **Private and unlisted**, so it never appears in the room browser.
   * - **Voice off.** In a two-player match one of the two is always the
   *   drawer, and the drawer may never use voice — so a voice group here could
   *   only ever hold one person talking to nobody. It also settles the "no
   *   voice for AI bots" rule by making it unreachable rather than checked.
   */
  private matchSettings(): RoomSettingsDto {
    return {
      ...defaultSettings(),
      maxPlayers: 2,
      rounds: AUTO_TOURNAMENT_DEFAULTS.matchRounds,
      isPrivate: true,
      allowSpectators: false,
      friendsOnly: false,
      voiceEnabled: false,
      chatEnabled: true,
    };
  }

  // ------------------------------------------------------------ opening one

  /**
   * Opens every match of a tournament that now has both its players.
   *
   * Called after seeding and again after each result lands, which is the only
   * two ways a pairing can become complete. Returns how many were opened, so
   * the caller can tell a round that has started from one that is still
   * waiting on the round below.
   */
  async openReadyMatches(tournamentId: string): Promise<number> {
    const pending = await TournamentMatch.find({
      tournamentId,
      status: MATCH_STATUS.pending,
      slotA: { $ne: null },
      slotB: { $ne: null },
    })
      .lean()
      .exec();

    let opened = 0;
    for (const match of pending) {
      // One match failing must not stop the rest of the round opening. A
      // bracket where three of four quarter-finals started is recoverable;
      // one where a single throw abandoned the loop is not.
      const ok = await this.open(match as TournamentMatchDocument).catch((error: unknown) => {
        logger.exception('opening a tournament match failed', error, {
          tournamentId,
          matchId: String(match._id),
        });
        return false;
      });
      if (ok) opened += 1;
    }

    return opened;
  }

  /** Creates the room for one pairing and tells its players. */
  private async open(match: TournamentMatchDocument): Promise<boolean> {
    const [playerA, playerB] = await Promise.all([
      this.registration(match.slotA),
      this.registration(match.slotB),
    ]);

    if (!playerA || !playerB) return false;

    const participants = [playerA, playerB];
    const humanIds = participants
      .filter((row) => !row.isBot && row.userId)
      .map((row) => String(row.userId));

    // Claim the match before building anything. A second opener finds the
    // status already `READY` and its own update modifies nothing, so only one
    // room is ever created for a pairing.
    const claim = await TournamentMatch.updateOne(
      { _id: match._id, status: MATCH_STATUS.pending },
      { $set: { status: MATCH_STATUS.ready, readyAt: new Date() } },
    ).exec();

    if ((claim.modifiedCount ?? 0) === 0) return false;

    const playerIdOf = (row: TournamentRegistrationDocument): string | null => {
      if (row.isBot) return null; // resolved below, from the bot roster
      return row.userId ? String(row.userId) : null;
    };

    // Bot seats need their play id, which is the ObjectId of the profile row.
    const seatIds = new Map<string, string>();
    const botSeats: {
      playerId: string;
      botId: string;
      displayName: string;
      avatarId: number;
      avatarColorIndex: number;
      difficulty: BotDifficultyWire;
    }[] = [];

    for (const row of participants) {
      if (row.isBot && row.botId) {
        const identity = await botProfileService.byBotId(
          row.botId,
          (row.botDifficulty ?? undefined) as BotDifficultyWire | undefined,
        );
        if (!identity) {
          // A bot that has since been deactivated. Its opponent gets the
          // walkover rather than the bracket stalling on a seat nobody can
          // fill.
          logger.warn('a bracket names a bot that is no longer active', {
            matchId: String(match._id),
            botId: row.botId,
          });
          const survivor = participants.find((other) => other !== row);
          if (survivor) {
            await this.completeMatch({
              matchId: String(match._id),
              winnerRegistrationId: String(survivor._id),
              loserRegistrationId: String(row._id),
              outcome: MATCH_OUTCOME.walkover,
              scoreA: 0,
              scoreB: 0,
            });
          }
          return false;
        }
        seatIds.set(String(row._id), identity.playerId);
        botSeats.push({ ...identity });
        continue;
      }

      const playerId = playerIdOf(row);
      if (playerId) seatIds.set(String(row._id), playerId);
    }

    // The room's identity map, in seat-id terms: the result reporter needs to
    // turn a standings row back into a bracket position.
    const registrationIdByPlayerId: Record<string, string> = {};
    for (const [registrationId, playerId] of seatIds) {
      registrationIdByPlayerId[playerId] = registrationId;
    }

    const allowed = [...seatIds.values()];
    // The host must be a seat that exists. A human where there is one, so the
    // room has an owner who is actually present; otherwise the first bot,
    // which is fine because nothing about a bracket match is host-driven.
    const hostId = humanIds[0] ?? allowed[0];
    if (!hostId) return false;

    const room = await roomService.createProtectedRoom({
      ownerId: hostId,
      settings: this.matchSettings(),
      allowedUserIds: allowed,
      tournament: {
        tournamentId: String(match.tournamentId),
        matchId: String(match._id),
        roundNumber: match.roundNumber,
        matchNumber: match.matchNumber,
        registrationIdByPlayerId,
      },
    });

    // Bots take their seats immediately. There is nothing to wait for and
    // nobody to tell.
    for (const seat of botSeats) roomService.seatBot(room, seat);
    await roomService.persist(room);

    const entryDeadline = new Date(Date.now() + AUTO_TOURNAMENT_DEFAULTS.matchEntryMs);

    await TournamentMatch.updateOne(
      { _id: match._id },
      {
        $set: {
          roomId: room.roomId,
          roomCode: room.code,
          entryDeadlineAt: entryDeadline,
        },
      },
    ).exec();

    for (const userId of humanIds) {
      announceToPlayer(userId, 'matchReady', {
        tournamentId: String(match.tournamentId),
        matchId: String(match._id),
        roundNumber: match.roundNumber,
        matchNumber: match.matchNumber,
        roomCode: room.code,
        entryDeadlineMs: entryDeadline.getTime(),
      });
    }

    announceTournament('bracketUpdated', {
      tournamentId: String(match.tournamentId),
      matchId: String(match._id),
      status: MATCH_STATUS.ready,
    });

    logger.info('tournament match opened', {
      matchId: String(match._id),
      roomId: room.roomId,
      humans: humanIds.length,
      bots: botSeats.length,
    });

    // A pairing of two bots has nothing to wait for. Checked here so an
    // all-AI match — which only exists in a tournament that real people are
    // playing elsewhere in — starts rather than sitting out its deadline.
    await this.startIfEverybodyIsHere(room);

    return true;
  }

  // -------------------------------------------------------------- starting

  /**
   * Starts the match once every human in the pairing is present.
   *
   * Hooked into the engine's broadcast funnel, so "somebody's socket joined"
   * is the trigger rather than a poll. The first two lines are what keep that
   * cheap for the thousands of broadcasts that have nothing to do with a
   * tournament.
   */
  async onRoomStateChanged(room: RuntimeRoom): Promise<void> {
    if (!room.tournament) return;
    if (room.phase !== GAME_PHASE.lobby) return;
    await this.startIfEverybodyIsHere(room);
  }

  /** The readiness test, and the start. */
  private async startIfEverybodyIsHere(room: RuntimeRoom): Promise<void> {
    if (!room.tournament || room.closed) return;
    if (room.phase !== GAME_PHASE.lobby) return;
    if (starting.has(room.roomId)) return;

    const expected = Object.keys(room.tournament.registrationIdByPlayerId);
    if (expected.length < 2) return;

    // Everybody has a seat, and every human seat has a live connection behind
    // it. A bot has no socket by construction, so it is present as soon as it
    // is seated — which is also why the check is on `isBot` rather than on
    // socket count alone.
    for (const playerId of expected) {
      const player = room.players.get(playerId);
      if (!player) return;
      if (!player.isBot && player.socketIds.size === 0) return;
    }

    await this.start(room, 'everybody arrived');
  }

  /**
   * Starts the match.
   *
   * `startGame` is called with the room's own host id because the engine
   * attributes a start to somebody — but nothing here is a host decision. The
   * server decided, on a rule; the host id is just the name it is recorded
   * under.
   */
  private async start(room: RuntimeRoom, reason: string): Promise<void> {
    if (!room.tournament) return;
    if (starting.has(room.roomId)) return;
    if (!this.engine) {
      // Nothing can start a match without the engine. This is a boot-order
      // bug rather than a runtime condition, so it is logged loudly and the
      // deadline sweep is left to decide the match rather than stalling it.
      logger.error('the tournament match service has no engine bound');
      return;
    }

    starting.add(room.roomId);

    try {
      const claimed = await TournamentMatch.updateOne(
        { _id: room.tournament.matchId, status: MATCH_STATUS.ready },
        { $set: { status: MATCH_STATUS.running, startedAt: new Date() } },
      ).exec();

      if ((claimed.modifiedCount ?? 0) === 0) return;

      await chatService.system(room, 'Tournament match starting. Good luck!');
      await this.engine.startGame(room, room.hostId);

      announceTournament('matchStarted', {
        tournamentId: room.tournament.tournamentId,
        matchId: room.tournament.matchId,
        roundNumber: room.tournament.roundNumber,
        matchNumber: room.tournament.matchNumber,
      });

      logger.info('tournament match started', {
        matchId: room.tournament.matchId,
        roomId: room.roomId,
        reason,
      });
    } catch (error) {
      // Put the match back so the deadline sweep can try again or decide it.
      // Leaving it `RUNNING` with no game would stall the round for ever.
      await TournamentMatch.updateOne(
        { _id: room.tournament.matchId, status: MATCH_STATUS.running, gameId: null },
        { $set: { status: MATCH_STATUS.ready, startedAt: null } },
      ).exec();

      logger.exception('starting a tournament match failed', error, {
        matchId: room.tournament.matchId,
        roomId: room.roomId,
      });
    } finally {
      starting.delete(room.roomId);
    }
  }

  // ----------------------------------------------------------- the result

  /**
   * Reports a finished match to the bracket.
   *
   * Called from `gameService.endGame` for every room; the first line makes it
   * free for the ones that are not tournament matches.
   *
   * The winner is the standings' first place, which is the engine's own
   * answer — there is no separate tournament scoring and nothing here
   * recomputes anything. A tie is broken by the scoring service before it gets
   * here; where it still produces two rank-1 rows, the first is taken, because
   * a knockout must produce exactly one survivor and any rule beats none.
   */
  async onMatchGameEnded(
    room: RuntimeRoom,
    standings: readonly PlayerScoreDto[],
  ): Promise<void> {
    const binding = room.tournament;
    if (!binding) return;

    const scoreOf = (playerId: string): number =>
      standings.find((entry) => entry.playerId === playerId)?.score ?? 0;

    const ranked = [...standings].sort((a, b) => a.rank - b.rank || b.score - a.score);
    const first = ranked[0];
    const second = ranked[1];

    const winnerRegistrationId = first
      ? binding.registrationIdByPlayerId[first.playerId]
      : undefined;
    const loserRegistrationId = second
      ? binding.registrationIdByPlayerId[second.playerId]
      : undefined;

    if (!winnerRegistrationId) {
      logger.error('a tournament match ended with no identifiable winner', {
        matchId: binding.matchId,
        roomId: room.roomId,
      });
      return;
    }

    const match = await TournamentMatch.findById(binding.matchId).lean().exec();

    await this.completeMatch({
      matchId: binding.matchId,
      winnerRegistrationId,
      loserRegistrationId: loserRegistrationId ?? null,
      outcome: MATCH_OUTCOME.played,
      gameId: room.gameId,
      scoreA: match?.slotA
        ? scoreOf(this.playerIdFor(binding, String(match.slotA)))
        : 0,
      scoreB: match?.slotB
        ? scoreOf(this.playerIdFor(binding, String(match.slotB)))
        : 0,
    });

    // The room has served its purpose. Closed rather than left to the empty-
    // room sweeper so its code is released immediately and the two players are
    // not sitting in a lobby that will never host another match.
    await roomService.close(room, 'tournament match finished');
  }

  /** The play id behind one bracket seat, for scoring the right slot. */
  private playerIdFor(
    binding: NonNullable<RuntimeRoom['tournament']>,
    registrationId: string,
  ): string {
    for (const [playerId, seat] of Object.entries(binding.registrationIdByPlayerId)) {
      if (seat === registrationId) return playerId;
    }
    return '';
  }

  /**
   * Writes a match result and advances the winner.
   *
   * ## Why advancement is inside the same method as completion
   *
   * Because the condition that makes completion safe is the same one that
   * makes advancement safe. The update filters on the match not already being
   * `COMPLETED`, and everything after it runs only when that update actually
   * modified a row — so a second caller completes nothing and advances
   * nothing. Splitting the two would mean a second place where "has this
   * already happened" has to be worked out, and the answer would have to be
   * re-derived rather than observed.
   */
  async completeMatch(input: {
    matchId: string;
    winnerRegistrationId: string;
    loserRegistrationId: string | null;
    outcome: (typeof MATCH_OUTCOME)[keyof typeof MATCH_OUTCOME];
    gameId?: string | null;
    scoreA: number;
    scoreB: number;
  }): Promise<boolean> {
    const claimed = await TournamentMatch.updateOne(
      { _id: input.matchId, status: { $ne: MATCH_STATUS.completed } },
      {
        $set: {
          status: MATCH_STATUS.completed,
          winnerRegistrationId: input.winnerRegistrationId,
          loserRegistrationId: input.loserRegistrationId,
          outcome: input.outcome,
          gameId: input.gameId ?? null,
          scoreA: input.scoreA,
          scoreB: input.scoreB,
          completedAt: new Date(),
        },
      },
    ).exec();

    // Somebody else already decided this match. Nothing to do, and — crucially
    // — nothing to advance: they did that too.
    if ((claimed.modifiedCount ?? 0) === 0) return false;

    const match = await TournamentMatch.findById(input.matchId).lean().exec();
    if (!match) return false;

    if (input.loserRegistrationId) {
      await TournamentRegistration.updateOne(
        { _id: input.loserRegistrationId },
        {
          $set: {
            status: REGISTRATION_STATUS.eliminated,
            eliminatedInRound: match.roundNumber,
          },
        },
      ).exec();
    }

    await this.advance(match as TournamentMatchDocument, input.winnerRegistrationId);

    announceTournament('matchCompleted', {
      tournamentId: String(match.tournamentId),
      matchId: String(match._id),
      roundNumber: match.roundNumber,
      matchNumber: match.matchNumber,
      winnerRegistrationId: input.winnerRegistrationId,
      outcome: input.outcome,
      scoreA: input.scoreA,
      scoreB: input.scoreB,
    });

    logger.info('tournament match completed', {
      matchId: String(match._id),
      outcome: input.outcome,
      winnerRegistrationId: input.winnerRegistrationId,
    });

    return true;
  }

  /**
   * Puts the winner into the next round's pairing.
   *
   * The destination was decided at seeding — `nextMatchNumber` and
   * `nextMatchSlot` are stored on the match — so this is a write rather than
   * a calculation, and a bracket with byes in it cannot be advanced into a
   * pairing the seeder did not create.
   *
   * The update filters on the target slot still being empty, so a repeated
   * advancement writes nothing rather than overwriting whoever is already
   * there. The final has no destination, which is what ends the tournament.
   */
  private async advance(
    match: TournamentMatchDocument,
    winnerRegistrationId: string,
  ): Promise<void> {
    if (!match.nextMatchNumber || !match.nextMatchSlot) return;

    const slotField = match.nextMatchSlot === 'A' ? 'slotA' : 'slotB';

    await TournamentMatch.updateOne(
      {
        tournamentId: match.tournamentId,
        roundNumber: match.roundNumber + 1,
        matchNumber: match.nextMatchNumber,
        [slotField]: null,
      },
      { $set: { [slotField]: winnerRegistrationId } },
    ).exec();
  }

  // ------------------------------------------------------- entry deadlines

  /**
   * Decides the matches nobody turned up for.
   *
   * Three outcomes, in order of preference:
   *
   * - **Both present** — nothing to do; the match is already running, or is
   *   about to be. The deadline is not a guillotine.
   * - **One present** — a walkover. The player who came gets the round, which
   *   is the only fair reading: they did everything asked of them.
   * - **Neither present** — the match is cancelled and neither advances. The
   *   next round's pairing is left with a gap, which the round-completion
   *   check resolves as a bye for whoever is opposite.
   */
  async sweepEntryDeadlines(): Promise<number> {
    const lapsed = await TournamentMatch.find({
      status: MATCH_STATUS.ready,
      entryDeadlineAt: { $ne: null, $lte: new Date() },
    })
      .limit(50)
      .lean()
      .exec();

    let decided = 0;

    for (const match of lapsed) {
      const handled = await this.decideLapsed(match as TournamentMatchDocument).catch(
        (error: unknown) => {
          logger.exception('deciding a lapsed tournament match failed', error, {
            matchId: String(match._id),
          });
          return false;
        },
      );
      if (handled) decided += 1;
    }

    return decided;
  }

  /** One lapsed match. */
  private async decideLapsed(match: TournamentMatchDocument): Promise<boolean> {
    const room = match.roomId ? roomService.get(String(match.roomId)) : null;

    const [playerA, playerB] = await Promise.all([
      this.registration(match.slotA),
      this.registration(match.slotB),
    ]);
    if (!playerA || !playerB) return false;

    // Who is actually here. A bot is always here; a person is here when their
    // seat holds a live socket.
    const present = (row: TournamentRegistrationDocument): boolean => {
      if (row.isBot) return true;
      if (!room || !row.userId) return false;
      const seat = room.players.get(String(row.userId));
      return Boolean(seat && seat.socketIds.size > 0);
    };

    const aHere = present(playerA);
    const bHere = present(playerB);

    if (aHere && bHere) {
      // Both arrived but the start never fired — a restart between the join
      // and the trigger, most likely. Start it now rather than punishing two
      // people who did turn up.
      if (room) await this.start(room, 'deadline with both present');
      return true;
    }

    if (aHere || bHere) {
      const winner = aHere ? playerA : playerB;
      const loser = aHere ? playerB : playerA;

      if (room) {
        await chatService.system(room, 'Your opponent did not arrive. You advance.');
        await roomService.close(room, 'tournament walkover');
      }

      return this.completeMatch({
        matchId: String(match._id),
        winnerRegistrationId: String(winner._id),
        loserRegistrationId: String(loser._id),
        outcome: MATCH_OUTCOME.walkover,
        scoreA: 0,
        scoreB: 0,
      });
    }

    // Nobody came.
    if (room) await roomService.close(room, 'tournament match abandoned');

    const cancelled = await TournamentMatch.updateOne(
      { _id: match._id, status: MATCH_STATUS.ready },
      { $set: { status: MATCH_STATUS.cancelled, completedAt: new Date() } },
    ).exec();

    if ((cancelled.modifiedCount ?? 0) > 0) {
      await TournamentRegistration.updateMany(
        { _id: { $in: [playerA._id, playerB._id] } },
        {
          $set: {
            status: REGISTRATION_STATUS.eliminated,
            eliminatedInRound: match.roundNumber,
          },
        },
      ).exec();
      return true;
    }

    return false;
  }

  // ------------------------------------------------------------ entry (API)

  /**
   * The code for the room a player's match is in.
   *
   * Refused for anybody who is not one of the two players, and refused before
   * the room exists or after the match is over. Note that this is the *second*
   * gate rather than the only one: the room itself rejects an outsider on
   * `allowedUserIds`, so a leaked code still gets nowhere.
   */
  async enter(input: {
    tournamentId: string;
    matchId: string;
    userId: string;
  }): Promise<{ roomId: string; roomCode: string; match: TournamentMatchDocument }> {
    const match = await TournamentMatch.findOne({
      _id: input.matchId,
      tournamentId: input.tournamentId,
    })
      .lean()
      .exec();

    if (!match) throw errors.notFound('That match does not exist.');

    const [playerA, playerB] = await Promise.all([
      this.registration(match.slotA),
      this.registration(match.slotB),
    ]);

    const isParticipant = [playerA, playerB].some(
      (row) => row && !row.isBot && row.userId && String(row.userId) === input.userId,
    );

    // The same "not found" a stranger gets for a room they may not enter, and
    // for the same reason: confirming that a match id names a real pairing is
    // the only thing worth learning by guessing at one.
    if (!isParticipant) throw errors.notFound('That match does not exist.');

    if (match.status === MATCH_STATUS.completed || match.status === MATCH_STATUS.cancelled) {
      throw errors.invalidAction('That match has already finished.');
    }
    if (!match.roomId || !match.roomCode) {
      throw errors.invalidAction('That match has not opened yet.');
    }

    return {
      roomId: String(match.roomId),
      roomCode: match.roomCode,
      match: match as TournamentMatchDocument,
    };
  }

  // ----------------------------------------------------------------- rounds

  /**
   * Advances a tournament past a finished round, or finishes it.
   *
   * A round is over when none of its matches is still undecided. What happens
   * next depends on what the next round looks like:
   *
   * - **There is no next round** → the tournament is complete and the last
   *   winner has won it.
   * - **There is** → any pairing whose opposite slot is empty because a match
   *   below it was cancelled is resolved as a bye, and the rest are opened.
   */
  async progressRounds(tournamentId: string): Promise<void> {
    const tournament = await AutoTournament.findById(tournamentId).lean().exec();
    if (!tournament) return;
    if (tournament.status !== AUTO_TOURNAMENT_STATUS.running) return;

    const current = tournament.currentRound || 1;

    const unfinished = await TournamentMatch.countDocuments({
      tournamentId,
      roundNumber: current,
      status: { $nin: [MATCH_STATUS.completed, MATCH_STATUS.cancelled] },
    }).exec();

    if (unfinished > 0) {
      // Not done. Open anything in this round that has become playable —
      // which is how a round with a mix of byes and matches gets going.
      await this.openReadyMatches(tournamentId);
      return;
    }

    announceTournament('roundCompleted', { tournamentId, roundNumber: current });

    if (current >= (tournament.totalRounds || 0)) {
      await this.finish(tournamentId, current);
      return;
    }

    // Move the marker on first, conditionally, so two ticks racing here
    // advance the round once.
    const moved = await AutoTournament.updateOne(
      { _id: tournamentId, currentRound: current, status: AUTO_TOURNAMENT_STATUS.running },
      { $set: { currentRound: current + 1 } },
    ).exec();

    if ((moved.modifiedCount ?? 0) === 0) return;

    await this.resolveNextRoundByes(tournamentId, current + 1);
    await this.openReadyMatches(tournamentId);

    announceTournament('bracketUpdated', { tournamentId, roundNumber: current + 1 });
  }

  /**
   * Completes any match in a round that has only one player.
   *
   * This happens when the match below it was cancelled — nobody turned up to
   * either side of it — so one slot of this pairing was never filled. Its
   * occupant advances unopposed, which is the same treatment a first-round bye
   * gets and for the same reason: there is nobody to play.
   */
  private async resolveNextRoundByes(tournamentId: string, roundNumber: number): Promise<void> {
    const lopsided = await TournamentMatch.find({
      tournamentId,
      roundNumber,
      status: MATCH_STATUS.pending,
      $or: [
        { slotA: { $ne: null }, slotB: null },
        { slotA: null, slotB: { $ne: null } },
      ],
    })
      .lean()
      .exec();

    for (const match of lopsided) {
      // Only a genuine dead end, not a pairing still waiting for a result.
      const feedersPending = await TournamentMatch.countDocuments({
        tournamentId,
        roundNumber: roundNumber - 1,
        nextMatchNumber: match.matchNumber,
        status: { $nin: [MATCH_STATUS.completed, MATCH_STATUS.cancelled] },
      }).exec();

      if (feedersPending > 0) continue;

      const survivor = match.slotA ?? match.slotB;
      if (!survivor) continue;

      await this.completeMatch({
        matchId: String(match._id),
        winnerRegistrationId: String(survivor),
        loserRegistrationId: null,
        outcome: MATCH_OUTCOME.bye,
        scoreA: 0,
        scoreB: 0,
      });
    }
  }

  /** Closes out a tournament whose final has been decided. */
  private async finish(tournamentId: string, finalRound: number): Promise<void> {
    const final = await TournamentMatch.findOne({
      tournamentId,
      roundNumber: finalRound,
      status: MATCH_STATUS.completed,
    })
      .sort({ matchNumber: 1 })
      .lean()
      .exec();

    const winnerRegistrationId = final?.winnerRegistrationId
      ? String(final.winnerRegistrationId)
      : null;

    const closed = await AutoTournament.updateOne(
      { _id: tournamentId, status: AUTO_TOURNAMENT_STATUS.running },
      {
        $set: {
          status: AUTO_TOURNAMENT_STATUS.completed,
          winnerRegistrationId,
          completedAt: new Date(),
        },
      },
    ).exec();

    if ((closed.modifiedCount ?? 0) === 0) return;

    if (winnerRegistrationId) {
      await TournamentRegistration.updateOne(
        { _id: winnerRegistrationId },
        { $set: { status: REGISTRATION_STATUS.winner } },
      ).exec();
    }

    const winner = winnerRegistrationId
      ? await this.registration(winnerRegistrationId)
      : null;

    announceTournament('completed', {
      tournamentId,
      winner: winner
        ? {
            registrationId: String(winner._id),
            displayName: winner.displayName,
            isBot: Boolean(winner.isBot),
          }
        : null,
    });

    logger.info('tournament completed', {
      tournamentId,
      winnerRegistrationId,
      winnerIsBot: Boolean(winner?.isBot),
    });
  }

  /** One registration row, or null. */
  private async registration(
    id: unknown,
  ): Promise<TournamentRegistrationDocument | null> {
    if (!id) return null;
    return (await TournamentRegistration.findById(String(id))
      .lean()
      .exec()) as TournamentRegistrationDocument | null;
  }
}

export const tournamentMatchService = new TournamentMatchService();
