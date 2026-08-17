import {
  clamp,
  cloneState,
  length,
  paddleBoundsX,
  paddleHome,
  PADDLE_RADIUS,
  PUCK_RADIUS,
  RINK_HEIGHT,
  RINK_WIDTH,
  SLOT_LEFT,
  step,
  TICK_RATE,
  type GameState,
} from '@ah/sim';

/**
 * Scripted opponent.
 *
 * ## Why it exists
 *
 * Mostly to solve a product problem rather than a technical one. A visitor who
 * opens this alone finds nobody to play, and a multiplayer demo with no
 * opponent demonstrates nothing. It is also what makes the spectator mode
 * possible, which is the only version of the demo that works on a phone with
 * no interaction at all.
 *
 * ## How it predicts
 *
 * By rolling the **real simulation** forward — the same `step()` the server
 * runs — rather than extrapolating a straight line. That comes almost free
 * given a deterministic, side-effect-free simulation, and it means the bot
 * correctly anticipates wall bounces and post ricochets, which a linear guess
 * cannot. It is the same property that makes rollback and the headless harness
 * work, used for a third purpose.
 *
 * ## How it is made beatable
 *
 * A bot with perfect information and instant reactions is unplayable and, worse,
 * boring. Two knobs spoil it deliberately: it acts on a view of the world a few
 * ticks old, and it aims at a point slightly off from the correct one. Both
 * scale with difficulty, and both are seeded so a given bot plays the same way
 * twice.
 */

export interface BotOptions {
  slot: number;
  /** 0 is hapless, 1 is very hard. Scales reaction delay and aim error. */
  difficulty?: number;
  seed?: number;
}

/** How far ahead to search for the puck arriving. One second is plenty at 60 Hz. */
const LOOKAHEAD_TICKS = TICK_RATE;

/**
 * Ticks between trajectory searches.
 *
 * Rolling the simulation forward is the expensive part, and the answer changes
 * meaningfully only when the puck is struck. Re-deriving it every tick would
 * cost 60x more for no benefit.
 */
const REPLAN_INTERVAL = 5;

/** Contact distance at which the bot switches from positioning to striking. */
const STRIKE_RANGE = (PADDLE_RADIUS + PUCK_RADIUS) * 2.2;

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface BotTarget {
  x: number;
  y: number;
}

export class Bot {
  private readonly slot: number;
  private readonly difficulty: number;
  private readonly random: () => number;

  /** Delayed view of the world, so the bot reacts like something with eyes. */
  private readonly memory: GameState[] = [];
  private readonly reactionTicks: number;

  private plan: BotTarget | null = null;
  private planAge = 0;
  private aimErrorX = 0;
  private aimErrorY = 0;

  constructor(options: BotOptions) {
    this.slot = options.slot;
    this.difficulty = clamp(options.difficulty ?? 0.65, 0, 1);
    this.random = mulberry32(options.seed ?? 0x5eed ^ (options.slot + 1));

    // 10 ticks (~165 ms) at the bottom, 2 (~33 ms) at the top. Human reaction
    // to a visual cue is around 200 ms, so even the hardest setting is not
    // pretending to be superhuman so much as very attentive.
    this.reactionTicks = Math.max(1, Math.round(10 - this.difficulty * 8));
  }

  /**
   * Choose where to move.
   *
   * @param observed the bot's best view of the world. Callers should pass what
   *                 a client would actually have — a predicted or interpolated
   *                 state — not authoritative truth, or the bot quietly gets
   *                 information no player could have.
   */
  decide(observed: GameState): BotTarget {
    const view = this.remember(observed);
    const bounds = paddleBoundsX(this.slot);
    const home = paddleHome(this.slot);

    this.planAge++;
    if (this.plan === null || this.planAge >= REPLAN_INTERVAL) {
      this.plan = this.makePlan(view, home);
      this.planAge = 0;
      this.rollAimError();
    }

    const puck = view.puck;
    const paddle = view.paddles[this.slot];
    const gap = paddle ? length(puck.x - paddle.x, puck.y - paddle.y) : Number.POSITIVE_INFINITY;

    // Within reach: stop positioning and drive through the puck toward the
    // opponent's goal, which is what actually scores.
    const target = gap < STRIKE_RANGE ? this.strikeThrough(puck) : this.plan;

    return {
      x: clamp(target.x + this.aimErrorX, bounds.minX, bounds.maxX),
      y: clamp(target.y + this.aimErrorY, PADDLE_RADIUS, RINK_HEIGHT - PADDLE_RADIUS),
    };
  }

  /** Buffer states and return one a few ticks old, so reactions are not instant. */
  private remember(state: GameState): GameState {
    this.memory.push(cloneState(state));
    while (this.memory.length > this.reactionTicks + 1) this.memory.shift();
    return this.memory[0] ?? state;
  }

  private rollAimError(): void {
    // Up to ~55 units off at the easiest setting, ~6 at the hardest.
    const spread = 6 + (1 - this.difficulty) * 50;
    this.aimErrorX = (this.random() * 2 - 1) * spread;
    this.aimErrorY = (this.random() * 2 - 1) * spread;
  }

  /**
   * Where to be.
   *
   * If the puck is coming, intercept it: roll the simulation forward until it
   * enters this player's half, and wait just behind where it will arrive so the
   * strike drives it forward rather than merely blocking it. Otherwise hold a
   * defensive position, shading toward the puck's side of the goal.
   */
  private makePlan(view: GameState, home: BotTarget): BotTarget {
    const arrival = this.predictArrival(view);

    if (arrival) {
      // Sit behind the arrival point, on the goal side, so contact pushes the
      // puck up-rink instead of stopping it dead.
      const behind = PADDLE_RADIUS + PUCK_RADIUS * 0.8;
      return {
        x: this.slot === SLOT_LEFT ? arrival.x - behind : arrival.x + behind,
        y: arrival.y,
      };
    }

    return {
      x: home.x,
      y: RINK_HEIGHT / 2 + (view.puck.y - RINK_HEIGHT / 2) * 0.55,
    };
  }

  /** Aim through the puck at the opposing goal, so contact sends it there. */
  private strikeThrough(puck: { x: number; y: number }): BotTarget {
    const goalX = this.slot === SLOT_LEFT ? RINK_WIDTH : 0;
    const goalY = RINK_HEIGHT / 2;

    const dx = goalX - puck.x;
    const dy = goalY - puck.y;
    const d = length(dx, dy);
    if (d === 0) return { x: puck.x, y: puck.y };

    // Overshoot well past the puck: the paddle seeks this point and meets the
    // puck on the way, so the further through it aims the harder the strike
    // lands. Aiming only as far as the contact point produces a nudge, and a
    // rally of nudges is slow to watch.
    const push = (PADDLE_RADIUS + PUCK_RADIUS) * 2.4;
    return { x: puck.x + (dx / d) * push, y: puck.y + (dy / d) * push };
  }

  /**
   * Roll the real simulation forward to find where the puck enters this
   * player's half.
   *
   * Genuine reuse of `step()`, so wall bounces and post ricochets are
   * anticipated correctly. Both paddles are held still during the search — the
   * bot does not get to know what its opponent is about to do, and its own
   * future movement is the thing being solved for.
   */
  private predictArrival(view: GameState): BotTarget | null {
    const half = RINK_WIDTH / 2;
    // Inclusive on both sides, so a puck sitting exactly on the centre line is
    // contested rather than ignored. Strict comparisons leave a dead zone at
    // x = 500 — which is precisely where play starts and where every goal
    // resets it — so neither bot would ever attack and the puck would sit
    // untouched for the whole match.
    const inMyHalf = (x: number): boolean => (this.slot === SLOT_LEFT ? x <= half : x >= half);

    // Already here: play it where it is.
    if (inMyHalf(view.puck.x)) return { x: view.puck.x, y: view.puck.y };

    // A nearly stationary puck is not coming to anyone, so go and fetch it
    // rather than waiting for motion that will never start.
    const speed = length(view.puck.vx, view.puck.vy);
    if (speed < 40) return { x: view.puck.x, y: view.puck.y };

    const approaching = this.slot === SLOT_LEFT ? view.puck.vx < 0 : view.puck.vx > 0;
    if (!approaching) return null;

    let future = view;
    for (let i = 0; i < LOOKAHEAD_TICKS; i++) {
      future = step(future, [null, null]);
      if (inMyHalf(future.puck.x)) {
        return { x: future.puck.x, y: future.puck.y };
      }
      // A goal resets the puck to centre; anything past that is meaningless.
      if (future.freezeTicks > 0) return null;
    }
    return null;
  }
}
