/**
 * Fixed-timestep loop.
 *
 * ## Why it is written this way
 *
 * The P0 spike measured a real constraint on the deployment target: Workers
 * freeze `Date.now()` during synchronous execution as a timing-side-channel
 * mitigation, so roughly **18% of timer callbacks observe zero elapsed time**.
 * Two obvious designs both break on that:
 *
 *   - *One tick per timer callback* paces the simulation off timer resolution,
 *     so the rate becomes whatever the platform's timer happens to be —
 *     measured at ~125 callbacks/second, not 60.
 *   - *Advance by the elapsed delta directly* stalls on every frozen callback
 *     and lurches forward on the next.
 *
 * ## Why there is no running accumulator
 *
 * The textbook form keeps a remainder and repeatedly subtracts the tick period
 * from it. That period is `1000 / 60`, which is not representable in binary, so
 * sixty subtractions overshoot one second by an ULP and the sixtieth tick does
 * not drain. It self-corrects on the following second — which is precisely why
 * the spike measured 59.99 Hz rather than a flat 60.00 — but the wobble is
 * avoidable.
 *
 * Instead this tracks total elapsed time and total ticks emitted, and derives
 * the target count by *multiplying* by the integer tick rate:
 *
 *     target = floor(elapsedMs * tickRate / 1000)
 *
 * `1000 * 60 / 1000` is exactly 60. No remainder is carried, so no drift can
 * accumulate, and the tick count depends only on elapsed time.
 */

export interface LoopOptions {
  /** Simulation ticks per second. An integer, and the reason there is no drift. */
  tickRate: number;
  /** Timer interval. Should be meaningfully finer than one tick. */
  timerMs: number;
  /**
   * Maximum ticks simulated in a single callback.
   *
   * Without a cap, a long stall produces a burst of catch-up work that costs
   * more than the stall did, which tends to cause the next stall.
   */
  maxCatchupTicks: number;
  /** Injected so tests and the headless harness can drive a virtual clock. */
  now: () => number;
  onTick: () => void;
}

export interface LoopStats {
  ticks: number;
  callbacks: number;
  maxCallbackGapMs: number;
  /** Callbacks that observed no elapsed time. Expected to be non-zero on Workers. */
  frozenClockCallbacks: number;
  /** Times the catch-up budget was exhausted and backlog was abandoned. */
  catchupClamped: number;
  /** Ticks never simulated because they were abandoned as backlog. */
  ticksDropped: number;
}

export class FixedTimestepLoop {
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastNow = 0;

  /** Total wall time observed since start, in milliseconds. */
  private elapsedMs = 0;
  /** Total ticks accounted for, including any abandoned as backlog. */
  private ticksAccounted = 0;

  private readonly stats: LoopStats = {
    ticks: 0,
    callbacks: 0,
    maxCallbackGapMs: 0,
    frozenClockCallbacks: 0,
    catchupClamped: 0,
    ticksDropped: 0,
  };

  constructor(private readonly options: LoopOptions) {}

  get running(): boolean {
    return this.timer !== null;
  }

  getStats(): Readonly<LoopStats> {
    return this.stats;
  }

  start(): void {
    if (this.timer !== null) return;
    this.lastNow = this.options.now();
    this.elapsedMs = 0;
    this.ticksAccounted = 0;
    this.timer = setInterval(() => this.pump(), this.options.timerMs);
  }

  stop(): void {
    if (this.timer === null) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  /**
   * Advance the loop once.
   *
   * Public so tests and the harness can drive it deterministically off a
   * virtual clock rather than waiting on real timers.
   */
  pump(): void {
    const now = this.options.now();
    const delta = now - this.lastNow;
    this.lastNow = now;

    this.stats.callbacks++;
    if (delta > this.stats.maxCallbackGapMs) this.stats.maxCallbackGapMs = delta;
    if (delta === 0) this.stats.frozenClockCallbacks++;

    // A backwards clock (NTP correction, for instance) must not stall the loop
    // until real time catches back up.
    if (delta > 0) this.elapsedMs += delta;

    const target = Math.floor((this.elapsedMs * this.options.tickRate) / 1000);
    let due = target - this.ticksAccounted;
    if (due <= 0) return;

    if (due > this.options.maxCatchupTicks) {
      // Abandon the backlog outright rather than carrying debt that would keep
      // the loop permanently behind. Accounting for the skipped ticks here is
      // what stops them being re-attempted on the next callback.
      this.stats.catchupClamped++;
      this.stats.ticksDropped += due - this.options.maxCatchupTicks;
      this.ticksAccounted = target - this.options.maxCatchupTicks;
      due = this.options.maxCatchupTicks;
    }

    for (let i = 0; i < due; i++) {
      this.ticksAccounted++;
      this.stats.ticks++;
      this.options.onTick();
    }
  }
}
