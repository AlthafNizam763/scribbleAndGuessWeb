import { emitToRoom } from '@/config/socket';
import { BOT_LIMITS, type BotDifficultyWire } from '@/constants/autoTournament.constants';
import { CHAT_TYPE, GAME_PHASE } from '@/constants/room.constants';
import {
  SERVER_DRAW_APPEND,
  SERVER_DRAW_BEGIN,
  SERVER_DRAW_END,
} from '@/constants/socket.constants';
import { botDrawerService, type DrawStep } from '@/services/bot/botDrawer.service';
import { botGuesserService, type Candidate } from '@/services/bot/botGuesser.service';
import { chatService } from '@/services/chat.service';
import { drawingService } from '@/services/drawing.service';
import { wordService } from '@/services/word.service';
import type { GameStateDto } from '@/types/game.types';
import type { RuntimePlayer, RuntimeRoom } from '@/types/socket.types';
import { logger } from '@/utils/logger';
import { normalizeGuess } from '@/utils/normalizeGuess';

/**
 * The thing that makes a bot play.
 *
 * ## One reconciler, no event bus
 *
 * `reconcile` is called from `gameService.broadcastState`, which is the single
 * funnel every state change in the engine already passes through — a turn
 * opening, the pen changing hands, a pause, a resume, a departure. Hanging the
 * bots there means there is no list of call sites that each have to remember
 * to notify them, which is the same reasoning that put `voiceService.reconcile`
 * in the same place.
 *
 * It is also what makes a room with no bots cost nothing: the first line is a
 * scan of the seats, and an ordinary room returns before anything else happens.
 *
 * ## Bots act through the engine, never around it
 *
 * A bot's word choice goes through `gameService.selectWord`, which checks it is
 * the drawer and that the index is one the server offered. A bot's guess goes
 * through `gameService.submitGuess`, which judges it, refuses a second one and
 * awards the points. A bot's strokes go through `drawingService.begin` and
 * `.append`, which sanitise and store them exactly as a person's. There is no
 * scoring path, no drawing path and no turn-advancing path that exists only
 * for bots — which is what "do not create a duplicate game engine" means here,
 * and it is also why a bot cannot cheat: it is subject to every rule because
 * it is going through every rule.
 *
 * ## Why the engine is injected rather than imported
 *
 * `game.service.ts` imports this module to call `reconcile`. If this module
 * imported it back, the two would form a cycle whose behaviour depends on
 * which one Node happens to load first. So the engine hands itself over at
 * boot — see the bottom of `game.service.ts` — and this file imports nothing
 * from it but types, which are erased.
 *
 * ## Task lifetime
 *
 * Every timer a bot holds is registered in one map keyed by room, and every
 * path that ends a turn, a match or a room clears it. A bot that was drawing
 * when its turn was abandoned stops mid-stroke and its remaining steps are
 * dropped, because the alternative — packets arriving for a round that ended —
 * is how a board ends up with marks nobody drew.
 */

/** What the bots need from the game engine, and nothing more. */
export interface BotEngine {
  serializeGameState(room: RuntimeRoom, viewerId: string): GameStateDto;
  selectWord(room: RuntimeRoom, userId: string, index: number): Promise<void>;
  submitGuess(input: {
    room: RuntimeRoom;
    userId: string;
    text: string;
  }): Promise<{ verdict: 'correct' | 'close' | 'wrong'; points: number }>;
}

/**
 * What a bot is currently busy with.
 *
 * ## Why the kind is part of the task and not implied by the phase
 *
 * A drawer does two things in one turn: it picks a word, and then it draws.
 * Both are work for the same bot in the same round, and the "is this already
 * running?" check is `same seat, same round`. Without a kind, the finished
 * word-selection task answers yes for the drawing that should follow it — and
 * the bot picks a word and then stands there for eighty seconds.
 *
 * That is not hypothetical: it is what happened, and it took an end-to-end run
 * to see it, because every unit test set the phase to `drawing` directly and
 * so never had a selection task lying around.
 */
type BotWork = 'selecting' | 'drawing' | 'guessing';

/** One bot's live work inside one room. */
interface BotTask {
  playerId: string;
  /** Which of the three things this task is. */
  kind: BotWork;
  /** The turn this task belongs to, so a stale timer can recognise itself. */
  roundId: string;
  timer: NodeJS.Timeout | null;
  /** Remaining drawing steps, for a drawer. */
  steps: DrawStep[];
  /** Words already tried this turn, for a guesser. */
  tried: Set<string>;
  attempts: number;
  cancelled: boolean;
}

/**
 * Live tasks, by room id then player id.
 *
 * On `globalThis` for the same reason the room registry is: a Next.js hot
 * reload in development must not orphan a set of running timers that nothing
 * can reach to cancel.
 */
const globalTasks = globalThis as typeof globalThis & {
  __scribbleBotTasks?: Map<string, Map<string, BotTask>>;
};

const tasks: Map<string, Map<string, BotTask>> = (globalTasks.__scribbleBotTasks ??= new Map());

/** How many bots hold a live timer right now, across every room. */
function workerCount(): number {
  let total = 0;
  for (const perRoom of tasks.values()) total += perRoom.size;
  return total;
}

export class BotPlayerService {
  private engine: BotEngine | null = null;

  /** Called once at boot by the game engine. */
  bindEngine(engine: BotEngine): void {
    this.engine = engine;
  }

  /** Whether a room has any AI seats at all. The cheap early exit. */
  hasBots(room: RuntimeRoom): boolean {
    for (const player of room.players.values()) {
      if (player.isBot) return true;
    }
    return false;
  }

  /**
   * Brings the bots into line with the room's current state.
   *
   * Safe to call as often as the engine broadcasts, which is what it does:
   * every branch is a no-op unless something actually changed for that bot.
   */
  reconcile(room: RuntimeRoom): void {
    if (room.closed) {
      this.clearRoom(room.roomId);
      return;
    }
    if (!this.hasBots(room)) return;
    if (!this.engine) return;

    const round = room.round;

    // Outside a live turn no bot has anything to do, and anything it *was*
    // doing belongs to a turn that is over.
    if (!round || round.ended || room.phase === GAME_PHASE.paused) {
      this.clearRoom(room.roomId);
      return;
    }

    if (room.phase === GAME_PHASE.wordSelection) {
      const drawer = room.players.get(round.drawerId);
      if (drawer?.isBot) this.scheduleWordSelection(room, drawer);
      return;
    }

    if (room.phase !== GAME_PHASE.drawing) return;

    for (const player of room.players.values()) {
      if (!player.isBot) continue;

      if (player.userId === round.drawerId) {
        this.startDrawing(room, player);
        continue;
      }

      // A bot that already got it this turn is done, exactly as a person is.
      if (player.hasGuessed) {
        this.cancelTask(room.roomId, player.userId);
        continue;
      }

      this.startGuessing(room, player);
    }
  }

  // ------------------------------------------------------------ word choice

  /** Takes one of the offered words, after a beat so it does not look instant. */
  private scheduleWordSelection(room: RuntimeRoom, drawer: RuntimePlayer): void {
    const round = room.round;
    if (!round) return;

    // Already choosing for this turn; a second broadcast must not restart it.
    const existing = tasks.get(room.roomId)?.get(drawer.userId);
    if (existing && existing.roundId === round.roundId && existing.kind === 'selecting') {
      return;
    }

    const task = this.claim(room, drawer.userId, round.roundId, 'selecting');
    if (!task) return;

    task.timer = this.after(BOT_LIMITS.warmUpMs, () => {
      if (task.cancelled) return;
      if (room.round !== round || room.phase !== GAME_PHASE.wordSelection) return;

      const index = botDrawerService.chooseWordIndex(round.wordChoices);

      void this.engine
        ?.selectWord(room, drawer.userId, index)
        .catch((error: unknown) => {
          // The word-selection deadline will pick a word for the bot, so a
          // failure here costs a moment rather than the turn.
          logger.exception('bot word selection failed', error, {
            roomId: room.roomId,
            botId: drawer.botId,
          });
        });
    });
  }

  // --------------------------------------------------------------- drawing

  /**
   * Starts a bot's drawing for the turn.
   *
   * Idempotent: a task already running for this round is left alone, so the
   * several broadcasts that happen during a drawing turn — a hint landing, a
   * guesser scoring — do not each restart the picture.
   */
  private startDrawing(room: RuntimeRoom, drawer: RuntimePlayer): void {
    const round = room.round;
    if (!round || !round.word) return;

    // Already drawing this turn. Checked on the *kind* as well as the round:
    // the word-selection task that ran moments ago belongs to this same round
    // and this same seat, and matching on those alone would make the drawing
    // look like work that was already under way.
    const existing = tasks.get(room.roomId)?.get(drawer.userId);
    if (existing && existing.roundId === round.roundId && existing.kind === 'drawing') {
      return;
    }

    const task = this.claim(room, drawer.userId, round.roundId, 'drawing');
    if (!task) return;

    const plan = botDrawerService.plan({
      // The drawer's own word, which is what the server already told the
      // drawer. Read from the round rather than from a serialisation, because
      // this *is* the drawer.
      word: round.word,
      difficulty: drawer.botDifficulty ?? 'NORMAL',
      authorId: drawer.userId,
      turnMs: Math.max(1_000, round.turnEndMs - Date.now()),
    });

    if (!plan.matchedTemplate) {
      // Logged without the word, like every other line in the engine: a log
      // anybody can read is not the place for a live round's answer. The
      // length and difficulty are enough to find the gap in the library.
      logger.warn('bot drawing fell back to a generic template', {
        roomId: room.roomId,
        botId: drawer.botId,
        wordLength: round.word.length,
        difficulty: round.wordDifficulty,
      });
    }

    task.steps = plan.steps;
    this.runNextDrawStep(room, task, round.roundId);
  }

  /** Sends one drawing step, then books the next. */
  private runNextDrawStep(room: RuntimeRoom, task: BotTask, roundId: string): void {
    const step = task.steps.shift();
    if (!step) {
      this.cancelTask(room.roomId, task.playerId);
      return;
    }

    task.timer = this.after(step.delayMs, () => {
      if (task.cancelled) return;

      const round = room.round;
      // The turn moved on underneath this timer. Dropping the rest of the plan
      // is the whole reason each step re-checks rather than trusting the
      // cancellation that should have happened.
      if (!round || round.ended || round.roundId !== roundId) {
        this.cancelTask(room.roomId, task.playerId);
        return;
      }
      if (room.phase !== GAME_PHASE.drawing || round.drawerId !== task.playerId) {
        this.cancelTask(room.roomId, task.playerId);
        return;
      }

      this.emitDrawStep(room, step);
      this.runNextDrawStep(room, task, roundId);
    });
  }

  /**
   * Puts one step on the board and relays it.
   *
   * The same two calls the socket handler makes for a person, in the same
   * order: the board is the authority and the broadcast is a consequence of
   * it, so a stroke the service refused is never relayed.
   *
   * Broadcast to the whole room rather than to everyone-but-the-author,
   * because the author is this process. A human drawer is excluded from their
   * own stroke echo because their client already painted it; a bot has no
   * client to have painted anything.
   */
  private emitDrawStep(room: RuntimeRoom, step: DrawStep): void {
    switch (step.kind) {
      case 'begin': {
        const stroke = drawingService.sanitizeStroke(
          { ...step.stroke, ts: Date.now() },
          step.stroke.a,
        );
        if (!drawingService.begin(room, stroke)) return;
        emitToRoom(room.roomId, SERVER_DRAW_BEGIN, { stroke });
        return;
      }
      case 'append': {
        const points = drawingService.sanitizePoints(step.points);
        if (points.length === 0) return;
        if (!drawingService.append(room, step.strokeId, points)) return;
        emitToRoom(room.roomId, SERVER_DRAW_APPEND, { strokeId: step.strokeId, points });
        return;
      }
      case 'end':
        emitToRoom(room.roomId, SERVER_DRAW_END, { strokeId: step.strokeId });
    }
  }

  // -------------------------------------------------------------- guessing

  /** Starts, or leaves running, a bot's guessing for the turn. */
  private startGuessing(room: RuntimeRoom, bot: RuntimePlayer): void {
    const round = room.round;
    if (!round) return;

    const existing = tasks.get(room.roomId)?.get(bot.userId);
    if (existing && existing.roundId === round.roundId && existing.kind === 'guessing') {
      return;
    }

    const task = this.claim(room, bot.userId, round.roundId, 'guessing');
    if (!task) return;

    const difficulty: BotDifficultyWire = bot.botDifficulty ?? 'NORMAL';

    // The first attempt is deliberately late: guessing off a blank canvas is
    // noise, and it would spend the rate-limit budget the bot needs later.
    this.scheduleGuess(
      room,
      task,
      round.roundId,
      difficulty,
      BOT_LIMITS.warmUpMs + botGuesserService.nextDelayMs(difficulty),
    );
  }

  /** Books one guess attempt. */
  private scheduleGuess(
    room: RuntimeRoom,
    task: BotTask,
    roundId: string,
    difficulty: BotDifficultyWire,
    delayMs: number,
  ): void {
    task.timer = this.after(delayMs, () => {
      void this.attemptGuess(room, task, roundId, difficulty).catch((error: unknown) => {
        logger.exception('bot guess failed', error, {
          roomId: room.roomId,
          playerId: task.playerId,
        });
        this.cancelTask(room.roomId, task.playerId);
      });
    });
  }

  /** One guess attempt, through the same path a person's goes through. */
  private async attemptGuess(
    room: RuntimeRoom,
    task: BotTask,
    roundId: string,
    difficulty: BotDifficultyWire,
  ): Promise<void> {
    if (task.cancelled) return;

    const round = room.round;
    const bot = room.players.get(task.playerId);

    if (!round || round.ended || round.roundId !== roundId || room.phase !== GAME_PHASE.drawing) {
      this.cancelTask(room.roomId, task.playerId);
      return;
    }
    if (!bot || bot.hasGuessed || round.drawerId === task.playerId) {
      this.cancelTask(room.roomId, task.playerId);
      return;
    }
    if (task.attempts >= BOT_LIMITS.maxGuessAttemptsPerTurn) {
      this.cancelTask(room.roomId, task.playerId);
      return;
    }

    task.attempts += 1;

    // The *guesser's* view, built by the same serialiser that fills a human
    // guesser's `s:game:state`. `word` is null in it, because this bot is not
    // the drawer — which is the mechanism, not a convention: there is no
    // argument to this method through which the answer could arrive.
    const state = this.engine?.serializeGameState(room, task.playerId);
    if (!state) {
      this.cancelTask(room.roomId, task.playerId);
      return;
    }

    const pool = await this.candidates(room);

    const guess = botGuesserService.nextGuess({
      view: {
        maskedWord: state.maskedWord,
        wordLength: state.wordLength,
        hintIndices: state.hintIndices,
        strokes: room.board.strokes,
        progress: progressOf(round.turnStartMs, round.turnEndMs),
      },
      pool,
      tried: task.tried,
      difficulty,
    });

    // Re-checked after the await: a pool load is a cache hit almost always,
    // but "almost always" is not "always", and a turn can end inside one.
    if (task.cancelled || room.round !== round || round.ended) return;

    if (guess) {
      task.tried.add(normalizeGuess(guess));

      const { verdict } = await this.engine!.submitGuess({
        room,
        userId: task.playerId,
        text: guess,
      });

      if (verdict === 'correct') {
        await chatService.correctGuess(room, bot.username, task.playerId);
        this.cancelTask(room.roomId, task.playerId);
        return;
      }

      // A wrong guess is shown to the room, exactly as a person's is. That is
      // most of what makes a bot read as a player: the room watches it try.
      if (room.settings.chatEnabled) {
        await chatService.broadcast({
          room,
          senderId: task.playerId,
          senderName: bot.username,
          text: guess,
          type: CHAT_TYPE.guess,
        });
      }
    }

    if (task.cancelled) return;
    this.scheduleGuess(
      room,
      task,
      roundId,
      difficulty,
      botGuesserService.nextDelayMs(difficulty),
    );
  }

  /**
   * The words this bot may try.
   *
   * The room's own pool, which is the same list the server drew the answer
   * from — so the bot is guessing from the vocabulary of the game rather than
   * from a dictionary. Narrowed to a few hundred entries per turn because a
   * full pool scan per attempt per bot is real work for a decision that does
   * not need it.
   *
   * Note what this is *not*: it is not the round's choices, which are the
   * drawer's alone, and it contains the answer only in the sense that a
   * dictionary does.
   */
  private async candidates(room: RuntimeRoom): Promise<Candidate[]> {
    // `guessablePool` rather than `pool`, and the difference matters: `pool`
    // reports an empty vocabulary on an unseeded word bank, while the turn is
    // still played on a word from the built-in fallback. A bot reading the
    // first would say nothing for the whole turn, with no error anywhere —
    // which is how this was found, in an end-to-end run against a throwaway
    // database.
    const pool = await wordService.guessablePool(room.settings);
    return botGuesserService.narrowPool(pool.map((entry) => ({ text: entry.text })));
  }

  // ------------------------------------------------------------- lifecycle

  /**
   * Reserves the task slot for one bot, or null when the process is at its
   * worker ceiling.
   *
   * The ceiling is the one thing standing between a bug in the bracket and a
   * process full of timers. A bot refused a slot simply does nothing this
   * turn — it is still in the match, still scored, and still eligible next
   * turn — which degrades a busy server rather than breaking it.
   */
  private claim(
    room: RuntimeRoom,
    playerId: string,
    roundId: string,
    kind: BotWork,
  ): BotTask | null {
    this.cancelTask(room.roomId, playerId);

    if (workerCount() >= BOT_LIMITS.maxConcurrentWorkers) {
      logger.warn('bot worker ceiling reached; skipping a bot this turn', {
        roomId: room.roomId,
        playerId,
        workers: workerCount(),
      });
      return null;
    }

    const task: BotTask = {
      playerId,
      kind,
      roundId,
      timer: null,
      steps: [],
      tried: new Set(),
      attempts: 0,
      cancelled: false,
    };

    let perRoom = tasks.get(room.roomId);
    if (!perRoom) {
      perRoom = new Map();
      tasks.set(room.roomId, perRoom);
    }
    perRoom.set(playerId, task);

    return task;
  }

  /** Stops one bot's work. */
  private cancelTask(roomId: string, playerId: string): void {
    const perRoom = tasks.get(roomId);
    const task = perRoom?.get(playerId);
    if (!task) return;

    task.cancelled = true;
    if (task.timer) clearTimeout(task.timer);
    task.timer = null;
    task.steps = [];

    perRoom?.delete(playerId);
    if (perRoom && perRoom.size === 0) tasks.delete(roomId);
  }

  /**
   * Stops every bot in a room.
   *
   * Called at the end of every turn, at the end of every match and when a room
   * closes. Cheap and idempotent, which is why it is called from all three
   * rather than only from the one that seems to matter.
   */
  clearRoom(roomId: string): void {
    const perRoom = tasks.get(roomId);
    if (!perRoom) return;

    for (const task of perRoom.values()) {
      task.cancelled = true;
      if (task.timer) clearTimeout(task.timer);
      task.timer = null;
      task.steps = [];
    }
    tasks.delete(roomId);
  }

  /** Live bot workers, for the metrics gauge. */
  activeWorkers(): number {
    return workerCount();
  }

  /**
   * `setTimeout` that does not hold the process open.
   *
   * Matching `timerService`: a server whose only remaining work is a bot's
   * next brush stroke should still be able to shut down.
   */
  private after(delayMs: number, callback: () => void): NodeJS.Timeout {
    const handle = setTimeout(() => {
      try {
        callback();
      } catch (error) {
        // There is no request to attach a throw to, so it would take the
        // process down. One bot's turn is not worth that.
        logger.exception('bot task threw', error);
      }
    }, Math.max(0, delayMs));

    handle.unref?.();
    return handle;
  }
}

/** How far through the turn we are, 0..1. */
function progressOf(startMs: number, endMs: number): number {
  if (endMs <= startMs) return 1;
  const ratio = (Date.now() - startMs) / (endMs - startMs);
  return ratio < 0 ? 0 : ratio > 1 ? 1 : ratio;
}

export const botPlayerService = new BotPlayerService();
