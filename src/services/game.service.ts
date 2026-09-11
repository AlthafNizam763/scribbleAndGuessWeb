import { MIN_PLAYERS_TO_START, TIMING } from '@/constants/game.constants';
import { CONNECTION, GAME_PHASE } from '@/constants/room.constants';
import {
  SERVER_DRAW_CLEAR,
  SERVER_GAME_END,
  SERVER_GAME_HINT,
  SERVER_GAME_ROUND_END,
  SERVER_GAME_ROUND_START,
  SERVER_GAME_STATE,
  SERVER_GAME_WORD_CHOICES,
  SERVER_ROOM_STATE,
} from '@/constants/socket.constants';
import { emitPerViewer, emitToRoom, emitToUser } from '@/config/socket';
import { gameRepository } from '@/repositories/game.repository';
import { roundRepository } from '@/repositories/round.repository';
import { userRepository } from '@/repositories/user.repository';
import { chatService } from '@/services/chat.service';
import { hintSchedule, letterCount, maskWord, nextHintIndices } from '@/services/hint.service';
import { roomService } from '@/services/room.service';
import { scoringService } from '@/services/scoring.service';
import { TIMER, timerService } from '@/services/timer.service';
import { wordService } from '@/services/word.service';
import type {
  GameResultDto,
  GameStateDto,
  PlayerScoreDto,
  RoundResultDto,
  WordItemDto,
} from '@/types/game.types';
import type { RuntimePlayer, RuntimeRoom, RuntimeRound } from '@/types/socket.types';
import { errors } from '@/utils/errors';
import { logger } from '@/utils/logger';
import { evaluateGuess, normalizeGuess } from '@/utils/normalizeGuess';
import { shuffled } from '@/utils/random';

/**
 * The authoritative game engine (brief sections 17 to 19, 28 to 34, 46 to 48).
 *
 * ## One state machine, here
 *
 * ```
 *   lobby -> starting -> word_selection -> drawing -> round_result
 *                  ^          ^                            |
 *                  |          +------- next turn ----------+
 *                  |                                       |
 *                  |                               final_result -> lobby
 *                  |
 *               paused  <-- any live phase, the moment the room drops below
 *                           MIN_PLAYERS_TO_START active players
 * ```
 *
 * Every transition is driven either by a host action or by a timer this
 * process owns. Nothing a client sends can move the game forward except by
 * asking, and every ask is checked (brief section 71).
 *
 * ## Why `paused` is here and not in the UI
 *
 * A two-player game whose second player walks out has no legal next state: one
 * person cannot both draw and guess. Leaving the phase on `drawing` and merely
 * hiding the canvas would keep the engine running — the buzzer would still
 * fire, the next turn would still be scheduled, and points would still be
 * awarded for a round nobody could play. So the engine parks the match in
 * `paused` instead: the round is abandoned, every turn timer is cancelled, and
 * nothing resumes until `resumeIfPossible` sees the room back at strength.
 *
 * ## The one rule that shapes the whole file
 *
 * The word is secret. It lives in `room.round.word`, it is sent to exactly one
 * socket when it is chosen, and it appears in a broadcast only after
 * `round.ended` is true. That is why `serializeGameState` takes a viewer id and
 * why state goes out through `emitPerViewer` rather than a room broadcast.
 */

export class GameService {
  // ------------------------------------------------------------- serialising

  /**
   * The game state as one recipient is allowed to see it.
   *
   * `viewerId` decides two things: whether `word` is populated, and whether
   * `wordChoices` is. Both are empty for everybody but the drawer, and `word`
   * opens up to the whole room once the turn has ended.
   */
  serializeGameState(room: RuntimeRoom, viewerId: string): GameStateDto {
    const round = room.round;

    if (!round) {
      return {
        roomCode: room.code,
        phase: room.phase,
        currentRound: room.currentRound,
        totalRounds: room.totalRounds,
        turnIndex: room.turnIndex,
        drawerId: null,
        word: null,
        maskedWord: '',
        wordLength: 0,
        hintIndices: [],
        turnStartMs: 0,
        turnEndMs: 0,
        correctGuesserIds: [],
        roundScores: {},
        wordChoices: [],
      };
    }

    const isDrawer = round.drawerId === viewerId;
    const revealed = isDrawer || round.ended;
    const word = round.word;

    return {
      roomCode: room.code,
      phase: room.phase,
      currentRound: room.currentRound,
      totalRounds: room.totalRounds,
      turnIndex: room.turnIndex,
      drawerId: round.drawerId,

      word: revealed ? word : null,
      maskedWord: word ? maskWord(word, round.hintIndices) : '',

      // In `hidden` mode even the length is withheld until the first hint
      // lands, which is the whole point of that mode.
      wordLength:
        word && (room.settings.wordMode !== 'hidden' || round.hintsRevealed > 0 || round.ended)
          ? letterCount(word)
          : 0,

      hintIndices: [...round.hintIndices],
      turnStartMs: round.turnStartMs,
      turnEndMs: round.turnEndMs,
      correctGuesserIds: [...round.correctOrder],
      roundScores: Object.fromEntries(round.scoreDeltas),

      // Choices are the drawer's alone, and only while they are choosing.
      wordChoices:
        isDrawer && room.phase === GAME_PHASE.wordSelection
          ? round.wordChoices.map(toWordItem)
          : [],
    };
  }

  /** Broadcasts room state, then per-recipient game state. */
  async broadcastState(room: RuntimeRoom): Promise<void> {
    emitToRoom(room.roomId, SERVER_ROOM_STATE, { room: roomService.serializeRoom(room) });
    await emitPerViewer(room.roomId, SERVER_GAME_STATE, (viewerId) => ({
      game: this.serializeGameState(room, viewerId),
    }));
  }

  // ------------------------------------------------- the minimum-player rule

  /**
   * The players who count towards the minimum.
   *
   * A `reconnecting` player still counts. They hold their seat, their score and
   * their correct-guess status for the whole reconnect grace period (brief
   * section 38), so treating a tunnel or a locked phone as a departure would
   * tear down a game that is about to carry on perfectly well. Only a player
   * the room has actually written off — `disconnected`, set when their grace
   * period expires and they are removed — stops counting.
   */
  private activePlayers(room: RuntimeRoom): RuntimePlayer[] {
    return [...room.players.values()].filter((p) => p.connection !== CONNECTION.disconnected);
  }

  /** Whether the room can legally run a turn right now. */
  hasEnoughPlayers(room: RuntimeRoom): boolean {
    return this.activePlayers(room).length >= MIN_PLAYERS_TO_START;
  }

  /** Whether a phase is one the minimum-player rule applies to. */
  private isLive(phase: RuntimeRoom['phase']): boolean {
    return (
      phase === GAME_PHASE.starting ||
      phase === GAME_PHASE.wordSelection ||
      phase === GAME_PHASE.drawing ||
      phase === GAME_PHASE.roundEnd
    );
  }

  /**
   * Parks a running match because the room no longer has enough players.
   *
   * The turn in progress is *abandoned*, not finished: nobody is awarded
   * anything, the word is never revealed as an answer and the board is wiped,
   * because a turn one player watched alone is not a turn that was played. The
   * match itself survives — scores, round number and turn order all stay — so
   * that `resumeIfPossible` can pick it up exactly where it stopped.
   *
   * Returns whether it actually paused, so callers can skip the work they were
   * about to do to a match that is no longer running.
   */
  async pauseForMissingPlayers(room: RuntimeRoom): Promise<boolean> {
    if (room.closed) return false;
    if (!this.isLive(room.phase)) return false;
    if (this.hasEnoughPlayers(room)) return false;

    // Everything booked below belongs to a turn that will never finish: the
    // selection deadline, the buzzer, the hints, the all-guessed grace, the
    // scoreboard pause and the countdown into the first turn. The per-player
    // reconnect timers are left alone on purpose — those are exactly what
    // brings the missing player back.
    timerService.cancelTurnTimers(room);
    timerService.cancel(room, TIMER.roundResult);
    timerService.cancel(room, TIMER.startCountdown);

    // --- the critical section: every state change, before anything awaits ---
    //
    // Two players can leave in the same tick, and each arrives here on its own
    // async chain. Node runs this synchronously, so the second call finds the
    // phase already `paused` at its `isLive` check above and returns false
    // rather than pausing the room a second time and announcing it twice. The
    // same technique guards double-scoring in `submitGuess`.
    const round = room.round;
    // Marked ended before it is dropped, so any timer already past its
    // `room.closed` check finds a round it must not touch.
    if (round) round.ended = true;

    const abandonedBoard = room.board.strokes;

    room.round = null;
    room.board = { strokes: [], redoStack: [] };
    room.phase = GAME_PHASE.paused;

    for (const player of room.players.values()) {
      player.hasGuessed = false;
      player.guessOrder = null;
      player.roundScore = 0;
    }
    // ----------------------------------------------------------------------

    if (round) {
      await roundRepository
        .finish(round.roundId, {
          scoreDeltas: {},
          snapshot: abandonedBoard,
          endReason: 'aborted',
        })
        .catch((error: unknown) => {
          logger.exception('recording an aborted round failed', error, {
            roomId: room.roomId,
            roundId: round.roundId,
          });
        });
    }

    await roomService.persist(room);

    // The board goes too. Leaving the abandoned drawing up would hand the next
    // guessers a free look at a word that is about to be offered again.
    emitToRoom(room.roomId, SERVER_DRAW_CLEAR, {});
    await this.broadcastState(room);
    await chatService.system(
      room,
      `Waiting for more players. ${MIN_PLAYERS_TO_START} are needed to play.`,
    );

    logger.info('game paused for missing players', {
      roomId: room.roomId,
      active: this.activePlayers(room).length,
      required: MIN_PLAYERS_TO_START,
    });

    return true;
  }

  /**
   * Restarts a paused match once the room is back at strength.
   *
   * Called from every path that seats a socket — create, join and reconnect —
   * so a game comes back on its own rather than waiting for the host to notice
   * and press something.
   */
  async resumeIfPossible(room: RuntimeRoom): Promise<void> {
    if (room.closed) return;
    if (room.phase !== GAME_PHASE.paused) return;
    if (!this.hasEnoughPlayers(room)) return;

    // Anyone seated while the match was down joins the rotation for the rest
    // of it. The ordinary mid-match joiner deliberately does not draw this
    // game, but a paused room is the one case where that rule would deadlock:
    // pausing at two players and resuming at two *different* ones would leave
    // a turn order with nobody in it still here to take a turn.
    for (const userId of room.players.keys()) {
      if (!room.turnOrder.includes(userId)) room.turnOrder.push(userId);
    }
    // Departures shortened `turnOrder` underneath the cursor; `length` is the
    // legal "this pass is done" value, so anything past it is clamped back.
    if (room.turnIndex > room.turnOrder.length) room.turnIndex = room.turnOrder.length;

    room.phase = GAME_PHASE.starting;
    await roomService.persist(room);
    await this.broadcastState(room);
    await chatService.system(room, 'Enough players are here. Resuming...');

    logger.info('game resumed', {
      roomId: room.roomId,
      active: this.activePlayers(room).length,
    });

    // The same beat `startGame` uses, for the same reason: clients get to play
    // their countdown before the word-choice sheet appears.
    timerService.schedule(room, TIMER.startCountdown, TIMING.startCountdownSeconds * 1000, () => {
      void this.beginTurn(room).catch((error: unknown) => {
        logger.exception('resuming a paused game failed', error, { roomId: room.roomId });
      });
    });
  }

  // ------------------------------------------------------------------ start

  /**
   * Starts a match (brief section 18).
   *
   * Turn order is shuffled once, here, and then fixed for the whole game: the
   * drawer for turn N has to be the same answer every time it is asked, even
   * after somebody leaves. The client is never consulted (brief section 19).
   */
  async startGame(room: RuntimeRoom, actorId: string): Promise<void> {
    roomService.assertHost(room, actorId);

    if (room.phase !== GAME_PHASE.lobby && room.phase !== GAME_PHASE.gameEnd) {
      throw errors.gameAlreadyStarted();
    }

    const connected = [...room.players.values()].filter((p) => p.connection !== 'disconnected');
    if (connected.length < MIN_PLAYERS_TO_START) {
      throw errors.invalidAction(`You need at least ${MIN_PLAYERS_TO_START} players to start.`);
    }

    this.resetScores(room);

    room.turnOrder = shuffled(connected.map((player) => player.userId));
    room.turnIndex = 0;
    room.turnNumber = 0;
    room.currentRound = 1;
    room.totalRounds = room.settings.rounds;
    room.usedWords = new Set();
    room.phase = GAME_PHASE.starting;

    const game = await gameRepository.create({
      roomId: room.roomId,
      roomCode: room.code,
      totalRounds: room.totalRounds,
      turnOrder: room.turnOrder,
    });
    room.gameId = String(game._id);

    await roomService.persist(room);
    await this.broadcastState(room);
    await chatService.system(room, 'The game is starting!');

    logger.info('game started', {
      roomId: room.roomId,
      gameId: room.gameId,
      players: room.turnOrder.length,
      rounds: room.totalRounds,
    });

    // A beat on "starting" so clients can play their countdown before the
    // first word-choice sheet appears.
    timerService.schedule(room, TIMER.startCountdown, TIMING.startCountdownSeconds * 1000, () => {
      void this.beginTurn(room);
    });
  }

  /** Zeroes every score and per-turn flag, for a new match. */
  private resetScores(room: RuntimeRoom): void {
    for (const player of room.players.values()) {
      player.score = 0;
      player.roundScore = 0;
      player.hasGuessed = false;
      player.guessOrder = null;
      player.isReady = false;
    }
  }

  // ------------------------------------------------------------- turn setup

  /**
   * Opens a turn: picks the drawer, offers words and starts the choice clock.
   *
   * The drawer is `turnOrder[turnIndex]`, skipping anyone who has left. If the
   * whole order is exhausted the round is over and the next one starts, or the
   * game ends.
   */
  async beginTurn(room: RuntimeRoom): Promise<void> {
    if (room.closed) return;

    // Checked here as well as on the way out of a turn: this is the single
    // door every turn comes through — the start countdown, the scoreboard
    // advance and a resume all land on it — so a room that lost somebody in
    // the gap between those two moments still cannot open a turn.
    if (!this.hasEnoughPlayers(room)) {
      await this.pauseForMissingPlayers(room);
      return;
    }

    const drawerId = this.nextDrawerId(room);

    if (drawerId === null) {
      // Nobody left in this pass. Move to the next round, or finish.
      if (room.currentRound >= room.totalRounds) {
        await this.endGame(room);
        return;
      }
      room.currentRound += 1;
      room.turnIndex = 0;
      await this.beginTurn(room);
      return;
    }

    const drawer = room.players.get(drawerId);
    if (!drawer) {
      // Raced with a departure; try the next seat.
      room.turnIndex += 1;
      await this.beginTurn(room);
      return;
    }

    for (const player of room.players.values()) {
      player.hasGuessed = false;
      player.guessOrder = null;
      player.roundScore = 0;
    }

    room.board = { strokes: [], redoStack: [] };
    room.turnNumber += 1;
    room.phase = GAME_PHASE.wordSelection;

    const choices = await wordService.pickChoices({
      settings: room.settings,
      usedWords: room.usedWords,
      count: room.settings.wordChoiceCount,
    });

    if (choices.length === 0) {
      logger.error('no words available for a turn', { roomId: room.roomId });
      await chatService.system(room, 'No words are available. Ending the game.');
      await this.endGame(room);
      return;
    }

    const roundDocument = await roundRepository.create({
      gameId: room.gameId ?? '',
      roomId: room.roomId,
      roundNumber: room.currentRound,
      turnNumber: room.turnNumber,
      drawerId,
      drawerName: drawer.username,
      wordChoices: choices.map((choice) => ({ ...toWordItem(choice), aliases: choice.aliases })),
    });

    const round: RuntimeRound = {
      roundId: String(roundDocument._id),
      roundNumber: room.currentRound,
      turnNumber: room.turnNumber,
      drawerId,
      word: null,
      wordDifficulty: 'medium',
      wordAliases: [],
      wordChoices: choices.map((choice) => ({ ...toWordItem(choice), aliases: choice.aliases })),
      hintIndices: [],
      hintsRevealed: 0,
      turnStartMs: 0,
      turnEndMs: 0,
      correctOrder: [],
      scoreDeltas: new Map(),
      ended: false,
    };
    room.round = round;

    await gameRepository.updateProgress(room.gameId ?? '', {
      phase: room.phase,
      currentRound: room.currentRound,
      turnIndex: room.turnIndex,
      currentRoundId: round.roundId,
    });

    // The board is wiped for everyone before the new drawer starts.
    emitToRoom(room.roomId, SERVER_DRAW_CLEAR, {});

    // Choices go to the drawer's sockets only — never to the room.
    emitToUser(drawerId, SERVER_GAME_WORD_CHOICES, {
      choices: round.wordChoices.map(toWordItem),
    });

    await this.broadcastState(room);
    await chatService.system(room, `${drawer.username} is choosing a word.`);

    // A drawer who never chooses must not stall the room: take a word for them.
    timerService.schedule(
      room,
      TIMER.wordSelection,
      room.settings.wordSelectSeconds * 1000,
      () => {
        const fallback = wordService.autoSelect(round.wordChoices);
        if (!fallback) return;
        void this.applyWordSelection(room, fallback).catch((error: unknown) => {
          logger.exception('auto word selection failed', error, { roomId: room.roomId });
        });
      },
    );
  }

  /**
   * The next drawer, or null when this pass around the table is done.
   *
   * Advances `turnIndex` past anyone who has left the room, so a departure
   * mid-match shortens the round rather than producing a turn with no drawer.
   */
  private nextDrawerId(room: RuntimeRoom): string | null {
    while (room.turnIndex < room.turnOrder.length) {
      const candidate = room.turnOrder[room.turnIndex];
      if (candidate && room.players.has(candidate)) return candidate;
      room.turnIndex += 1;
    }
    return null;
  }

  // ---------------------------------------------------------- word selection

  /**
   * Records the drawer's pick (brief section 22).
   *
   * Three checks, all of them server-side: the caller is the drawer, the turn
   * is still in its choosing phase, and the index names one of the words this
   * server offered. The third matters most — without it a client could send
   * any index, or any word, and draw something that was never on the list.
   */
  async selectWord(room: RuntimeRoom, userId: string, index: number): Promise<void> {
    const round = room.round;
    if (!round) throw errors.gameNotStarted();
    if (round.drawerId !== userId) throw errors.notDrawer();
    if (room.phase !== GAME_PHASE.wordSelection) throw errors.invalidAction('Too late to choose.');

    const choice = round.wordChoices[index];
    if (!choice) throw errors.invalidWord();

    await this.applyWordSelection(room, choice);
  }

  /** Commits a chosen word and starts the drawing turn. */
  private async applyWordSelection(
    room: RuntimeRoom,
    choice: WordItemDto & { aliases: string[] },
  ): Promise<void> {
    const round = room.round;
    if (!round || round.ended || room.phase !== GAME_PHASE.wordSelection) return;

    timerService.cancel(room, TIMER.wordSelection);

    const now = Date.now();
    round.word = choice.text;
    round.wordDifficulty = choice.difficulty;
    round.wordAliases = choice.aliases;
    round.turnStartMs = now;
    round.turnEndMs = now + room.settings.drawTimeSeconds * 1000;
    round.hintIndices = [];
    round.hintsRevealed = 0;

    room.phase = GAME_PHASE.drawing;
    room.usedWords.add(normalizeGuess(choice.text));

    await roundRepository.startTurn(round.roundId, {
      word: choice.text,
      wordDifficulty: choice.difficulty,
      wordAliases: choice.aliases,
      turnStartMs: round.turnStartMs,
      turnEndMs: round.turnEndMs,
    });
    if (room.gameId) await gameRepository.addUsedWord(room.gameId, choice.text);

    // Logged without the word: a log any teammate can read is not the place
    // for the answer to a live round (brief section 69).
    logger.info('turn started', {
      roomId: room.roomId,
      roundId: round.roundId,
      drawerId: round.drawerId,
      turnNumber: round.turnNumber,
      difficulty: choice.difficulty,
    });

    // Per-recipient, not a room broadcast. The client treats `s:game:roundStart`
    // as a *wholesale reset* of its game state — deliberately, so no part of
    // the previous turn's word can survive into the new one. A single shared
    // payload would therefore have to omit the word, and receiving it would
    // erase the word the drawer was just told.
    await emitPerViewer(room.roomId, SERVER_GAME_ROUND_START, (viewerId) => ({
      game: this.serializeGameState(room, viewerId),
    }));
    await this.broadcastState(room);

    this.scheduleHints(room, round);

    // The buzzer, plus a little slack for guesses already in flight.
    timerService.scheduleAt(room, TIMER.turn, round.turnEndMs + TIMING.turnGraceMs, () => {
      void this.endTurn(room, 'timeout').catch((error: unknown) => {
        logger.exception('turn timeout failed', error, { roomId: room.roomId });
      });
    });
  }

  /** Books one timer per hint across the middle of the turn. */
  private scheduleHints(room: RuntimeRoom, round: RuntimeRound): void {
    const schedule = hintSchedule({
      turnStartMs: round.turnStartMs,
      turnEndMs: round.turnEndMs,
      hintCount: room.settings.hintCount,
      firstAtFraction: TIMING.firstHintAtFraction,
      lastAtFraction: TIMING.lastHintAtFraction,
    });

    schedule.forEach((atMs, index) => {
      timerService.scheduleAt(room, TIMER.hint(index), atMs, () => {
        void this.revealHint(room, round, index + 1);
      });
    });
  }

  /** Reveals the `hintNumber`-th letter set and tells the room. */
  private async revealHint(room: RuntimeRoom, round: RuntimeRound, hintNumber: number): Promise<void> {
    if (room.closed || round.ended || !round.word) return;
    if (room.round !== round) return;

    round.hintIndices = nextHintIndices({
      word: round.word,
      current: round.hintIndices,
      totalHints: room.settings.hintCount,
      hintNumber,
    });
    round.hintsRevealed = hintNumber;

    await roundRepository.recordHint(round.roundId, round.hintIndices, hintNumber);

    const masked = maskWord(round.word, round.hintIndices);

    // The drawer knows the word already, so one shared payload is fine here:
    // it carries revealed positions and the mask, never the full word.
    emitToRoom(room.roomId, SERVER_GAME_HINT, {
      hintIndices: [...round.hintIndices],
      maskedWord: masked,
    });

    await emitPerViewer(room.roomId, SERVER_GAME_STATE, (viewerId) => ({
      game: this.serializeGameState(room, viewerId),
    }));
  }

  // ---------------------------------------------------------------- guessing

  /**
   * Judges a guess (brief sections 29 to 32).
   *
   * ## How double-scoring is prevented
   *
   * `player.hasGuessed` is read and written in one synchronous run of this
   * method, before any `await`. Node runs this on a single thread, so two
   * guesses arriving in the same tick cannot both observe `false` — the second
   * one sees the flag the first set and is rejected. The `await`ed database
   * write afterwards carries its own guard (`recordCorrectGuess` filters on
   * the user not already being in the array), so even a second process could
   * not double-award.
   *
   * Returns what the caller should do with the message: a wrong guess is shown
   * to the room as chat, a correct one is replaced by an announcement, and a
   * close one is whispered back to the guesser alone.
   */
  async submitGuess(input: {
    room: RuntimeRoom;
    userId: string;
    text: string;
  }): Promise<{ verdict: 'correct' | 'close' | 'wrong'; points: number }> {
    const { room, userId, text } = input;
    const round = room.round;
    const player = room.players.get(userId);

    if (!player) throw errors.notMember();
    if (!round || !round.word || room.phase !== GAME_PHASE.drawing || round.ended) {
      // Outside a live turn a "guess" is just chat, and is handled as such.
      return { verdict: 'wrong', points: 0 };
    }

    // The drawer cannot guess their own word. Their messages are not even
    // evaluated, so they cannot leak the answer by typing it.
    if (round.drawerId === userId) return { verdict: 'wrong', points: 0 };

    if (player.hasGuessed) throw errors.alreadyGuessed();

    const verdict = evaluateGuess(text, round.word, round.wordAliases);
    if (verdict !== 'correct') return { verdict, points: 0 };

    // --- the critical section: claim the slot before awaiting anything ---
    player.hasGuessed = true;
    const order = round.correctOrder.length + 1;
    player.guessOrder = order;
    round.correctOrder.push(userId);
    // --------------------------------------------------------------------

    const msTotal = round.turnEndMs - round.turnStartMs;
    const msRemaining = Math.max(0, round.turnEndMs - Date.now());

    const points = scoringService.guesserPoints({
      msRemaining,
      msTotal,
      guessOrder: order,
      difficulty: round.wordDifficulty,
    });

    player.score += points;
    player.roundScore = points;
    round.scoreDeltas.set(userId, points);

    await roundRepository.recordCorrectGuess(round.roundId, {
      userId,
      username: player.username,
      order,
      msRemaining,
      points,
    });

    logger.info('correct guess', {
      roomId: room.roomId,
      userId,
      order,
      points,
      msRemaining,
    });

    await this.afterCorrectGuess(room, round);
    return { verdict: 'correct', points };
  }

  /**
   * Ends the turn early once everybody who can guess has.
   *
   * A short grace first, so the last correct guesser sees their points land
   * and the room reads the announcement rather than being cut straight to the
   * scoreboard.
   */
  private async afterCorrectGuess(room: RuntimeRoom, round: RuntimeRound): Promise<void> {
    await roomService.persist(room);
    await this.broadcastState(room);

    const guessers = [...room.players.values()].filter(
      (player) => player.userId !== round.drawerId && player.connection !== 'disconnected',
    );

    if (guessers.length > 0 && guessers.every((player) => player.hasGuessed)) {
      timerService.schedule(room, TIMER.allGuessed, TIMING.allGuessedGraceSeconds * 1000, () => {
        void this.endTurn(room, 'allGuessed').catch((error: unknown) => {
          logger.exception('early turn end failed', error, { roomId: room.roomId });
        });
      });
    }
  }

  // ------------------------------------------------------------- turn ending

  /**
   * Closes the turn, awards the drawer and reveals the answer.
   *
   * This is the only place the word becomes public (brief section 46).
   * `round.ended` is set first, so every serialisation from here on includes
   * it and nothing has to remember to reveal it separately.
   */
  async endTurn(
    room: RuntimeRoom,
    reason: 'timeout' | 'allGuessed' | 'drawerLeft' | 'skipped' | 'aborted',
  ): Promise<void> {
    const round = room.round;
    if (!round || round.ended || room.closed) return;
    // A paused match has already abandoned its round; scoring it now would pay
    // out for a turn nobody was able to play.
    if (room.phase === GAME_PHASE.paused) return;

    round.ended = true;
    timerService.cancelTurnTimers(room);

    const guessers = [...room.players.values()].filter((p) => p.userId !== round.drawerId);
    const drawer = room.players.get(round.drawerId);

    // The drawer's payout depends on how many people read the drawing.
    if (drawer && round.word) {
      const drawerPoints = scoringService.drawerPoints({
        correctGuessers: round.correctOrder.length,
        totalGuessers: guessers.length,
        difficulty: round.wordDifficulty,
      });
      if (drawerPoints > 0) {
        drawer.score += drawerPoints;
        drawer.roundScore = drawerPoints;
        round.scoreDeltas.set(drawer.userId, drawerPoints);
      }
    }

    room.phase = GAME_PHASE.roundEnd;

    const scoreDeltas = Object.fromEntries(round.scoreDeltas);
    const totals = Object.fromEntries(
      [...room.players.values()].map((player) => [player.userId, player.score]),
    );

    const result: RoundResultDto = {
      round: round.roundNumber,
      word: round.word ?? '',
      drawerId: round.drawerId,
      scoreDeltas,
      totals,
      correctOrder: [...round.correctOrder],
    };

    await roundRepository.finish(round.roundId, {
      scoreDeltas,
      snapshot: room.board.strokes,
      endReason: reason,
    });
    await roomService.persist(room);

    emitToRoom(room.roomId, SERVER_GAME_ROUND_END, {
      result,
      game: this.serializeGameState(room, round.drawerId),
    });
    await this.broadcastState(room);

    if (round.word) {
      await chatService.system(room, `The word was "${round.word}".`);
    }

    logger.info('turn ended', {
      roomId: room.roomId,
      roundId: round.roundId,
      reason,
      correctGuessers: round.correctOrder.length,
    });

    // Pause on the scoreboard, then move on.
    timerService.schedule(room, TIMER.roundResult, TIMING.roundEndSeconds * 1000, () => {
      void this.advance(room).catch((error: unknown) => {
        logger.exception('advancing past the round result failed', error, {
          roomId: room.roomId,
        });
      });
    });
  }

  /** Moves to the next turn, the next round, or the end of the game. */
  private async advance(room: RuntimeRoom): Promise<void> {
    if (room.closed) return;
    // The scoreboard timer outlives the pause that cancelled it only if the
    // two raced; either way a paused match does not advance.
    if (room.phase === GAME_PHASE.paused) return;

    if (!this.hasEnoughPlayers(room)) {
      await this.pauseForMissingPlayers(room);
      return;
    }

    room.turnIndex += 1;

    if (room.turnIndex >= room.turnOrder.length) {
      if (room.currentRound >= room.totalRounds) {
        await this.endGame(room);
        return;
      }
      room.currentRound += 1;
      room.turnIndex = 0;
    }

    await this.beginTurn(room);
  }

  // ------------------------------------------------------------- game ending

  /** Computes the standings, records them and broadcasts the result. */
  async endGame(room: RuntimeRoom): Promise<void> {
    if (room.closed) return;

    timerService.cancelAll(room);

    room.phase = GAME_PHASE.gameEnd;
    room.round = null;

    const standings: PlayerScoreDto[] = scoringService
      .standings(
        [...room.players.values()].map((player) => ({
          playerId: player.userId,
          name: player.username,
          avatarId: player.avatarId,
          avatarColorIndex: player.avatarColorIndex,
          score: player.score,
        })),
      )
      .map((entry) => ({
        playerId: entry.playerId,
        name: entry.name,
        avatarId: entry.avatarId,
        avatarColorIndex: entry.avatarColorIndex,
        score: entry.score,
        rank: entry.rank,
      }));

    const winner = standings.find((entry) => entry.rank === 1) ?? null;

    const result: GameResultDto = {
      roomCode: room.code,
      standings,
      totalRounds: room.totalRounds,
    };

    if (room.gameId) {
      await gameRepository.finish(room.gameId, {
        standings,
        winnerId: winner?.playerId ?? null,
      });
    }

    // Lifetime stats. A tie means more than one winner, which is the honest
    // reading of a draw — nobody's record should say they lost.
    await Promise.all(
      standings.map((entry) =>
        userRepository.recordGameResult(entry.playerId, {
          scored: entry.score,
          won: entry.rank === 1,
          bestRoundScore: entry.score,
        }),
      ),
    ).catch((error: unknown) => {
      logger.exception('recording game results failed', error, { roomId: room.roomId });
    });

    await roomService.persist(room);

    emitToRoom(room.roomId, SERVER_GAME_END, { result });
    await this.broadcastState(room);

    if (winner) await chatService.system(room, `${winner.name} wins!`);

    logger.info('game ended', {
      roomId: room.roomId,
      gameId: room.gameId,
      winnerId: winner?.playerId ?? null,
    });

    // Drop back to the lobby so the host can start again (brief section 48).
    timerService.schedule(room, TIMER.gameEnd, TIMING.gameEndSeconds * 1000, () => {
      void this.returnToLobby(room).catch((error: unknown) => {
        logger.exception('returning to the lobby failed', error, { roomId: room.roomId });
      });
    });
  }

  /** Resets the room to a lobby, keeping the code, the seats and the settings. */
  async returnToLobby(room: RuntimeRoom): Promise<void> {
    if (room.closed) return;

    room.phase = GAME_PHASE.lobby;
    room.round = null;
    room.gameId = null;
    room.board = { strokes: [], redoStack: [] };
    room.turnOrder = [];
    room.turnIndex = 0;
    room.turnNumber = 0;
    room.currentRound = 0;
    room.usedWords = new Set();

    for (const player of room.players.values()) {
      player.isReady = false;
      player.hasGuessed = false;
      player.guessOrder = null;
      player.roundScore = 0;
    }

    await roomService.persist(room);
    await this.broadcastState(room);
  }

  /**
   * "Play again" (brief section 48).
   *
   * Resets scores and starts a fresh match against the same room. The room
   * code, the seats and the settings survive, which is the whole point: the
   * group stays together and nobody has to share a new code.
   */
  async playAgain(room: RuntimeRoom, actorId: string): Promise<void> {
    roomService.assertHost(room, actorId);

    if (room.phase !== GAME_PHASE.gameEnd && room.phase !== GAME_PHASE.lobby) {
      throw errors.gameAlreadyStarted();
    }

    await this.returnToLobby(room);
    await this.startGame(room, actorId);
  }

  // --------------------------------------------------- drawer disconnection

  /**
   * Handles the drawer dropping out (brief section 39).
   *
   * The game is not torn down. The turn is held for a short grace period, and
   * if the drawer comes back it simply carries on — their board is still here,
   * and so is the countdown. If they do not, the turn ends and play moves to
   * the next drawer.
   */
  onDrawerDisconnected(room: RuntimeRoom): void {
    const round = room.round;
    if (!round || round.ended || room.closed) return;

    void chatService.system(room, 'The drawer lost connection. Waiting a moment...');

    timerService.schedule(room, TIMER.drawerGrace, TIMING.drawerReconnectGraceMs, () => {
      const drawer = room.players.get(round.drawerId);
      if (drawer && drawer.connection === 'connected') return;

      void chatService.system(room, 'The drawer did not come back.');
      void this.endTurn(room, 'drawerLeft').catch((error: unknown) => {
        logger.exception('ending a turn after a drawer left failed', error, {
          roomId: room.roomId,
        });
      });
    });
  }

  /** Cancels the grace period when the drawer returns. */
  onDrawerReconnected(room: RuntimeRoom): void {
    timerService.cancel(room, TIMER.drawerGrace);
  }

  /**
   * Handles any player leaving mid-match.
   *
   * The minimum-player rule is checked first and before anything reads
   * `room.round`, because it is the one case that applies in *every* live
   * phase — including the two this method used to return from immediately:
   * the countdown before the first turn, where there is no round yet, and the
   * scoreboard between turns, where the round has already ended. Leaving in
   * either of those is exactly how a two-player game used to end up with one
   * player and a next turn scheduled for them alone.
   *
   * Past that, two things can still end a turn early: the drawer going, or so
   * many guessers going that everyone still present has already guessed.
   */
  async onPlayerLeft(room: RuntimeRoom, userId: string): Promise<void> {
    if (room.closed) return;

    if (await this.pauseForMissingPlayers(room)) return;

    const round = room.round;
    if (!round || round.ended) return;

    if (round.drawerId === userId) {
      await chatService.system(room, 'The drawer left.');
      await this.endTurn(room, 'drawerLeft');
      return;
    }

    const guessers = [...room.players.values()].filter(
      (player) => player.userId !== round.drawerId && player.connection !== 'disconnected',
    );

    if (guessers.length === 0) {
      await this.endTurn(room, 'skipped');
      return;
    }

    if (room.phase === GAME_PHASE.drawing && guessers.every((player) => player.hasGuessed)) {
      await this.endTurn(room, 'allGuessed');
    }
  }
}

/** Strips the alias list, which is server-side data the client never needs. */
function toWordItem(choice: { text: string; category: string; difficulty: string }): WordItemDto {
  return {
    text: choice.text,
    category: choice.category as WordItemDto['category'],
    difficulty: choice.difficulty as WordItemDto['difficulty'],
  };
}

export const gameService = new GameService();
