/**
 * P0 architectural spike.
 *
 * The plan's primary risk is that the whole server design assumes a Durable
 * Object can act as an authoritative 60 Hz simulation host. Two things could
 * make that false, and both need to be measured rather than assumed:
 *
 *  1. **Timer fidelity.** Workers are optimised for short request handlers, not
 *     sustained loops. If `setInterval` is throttled, coalesced, or the isolate
 *     is evicted while sockets are open, the tick rate collapses.
 *
 *  2. **Clock behaviour.** Workers deliberately freeze `Date.now()` during
 *     synchronous execution as a side-channel mitigation — it advances only
 *     across I/O boundaries. A fixed-timestep accumulator is driven entirely by
 *     wall-clock deltas, so if the clock does not advance between timer
 *     callbacks the accumulator either stalls or runaway-catches-up.
 *
 * This worker runs the real accumulator design and reports what actually
 * happens. It is a measurement harness, not production code.
 */

export interface Env {
  ROOM: DurableObjectNamespace;
}

const TICK_RATE = 60;
const TICK_MS = 1000 / TICK_RATE;

/** How often the timer fires. Deliberately finer than the tick so the accumulator does the pacing. */
const TIMER_MS = 8;

/** Cap on catch-up ticks per timer callback, so a long stall cannot spiral. */
const MAX_CATCHUP_TICKS = 5;

interface Report {
  wallElapsedMs: number;
  ticks: number;
  effectiveHz: number;
  timerCallbacks: number;
  /** Longest observed gap between consecutive timer callbacks. */
  maxCallbackGapMs: number;
  /** How many callbacks saw Date.now() unchanged from the previous one. */
  frozenClockCallbacks: number;
  /** Times the catch-up cap was hit — evidence of a real stall. */
  catchupClamped: number;
}

export class TickRoom implements DurableObject {
  private sockets = new Set<WebSocket>();
  private timer: ReturnType<typeof setInterval> | null = null;

  private startedAt = 0;
  private lastNow = 0;
  private accumulatorMs = 0;

  private ticks = 0;
  private timerCallbacks = 0;
  private maxCallbackGapMs = 0;
  private frozenClockCallbacks = 0;
  private catchupClamped = 0;

  constructor(
    private readonly ctx: DurableObjectState,
    private readonly env: Env,
  ) {}

  async fetch(request: Request): Promise<Response> {
    if (request.headers.get('Upgrade') !== 'websocket') {
      return new Response('expected websocket upgrade', { status: 426 });
    }

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];

    server.accept();
    this.sockets.add(server);

    server.addEventListener('close', () => {
      this.sockets.delete(server);
      if (this.sockets.size === 0) this.stopLoop();
    });
    server.addEventListener('error', () => {
      this.sockets.delete(server);
      if (this.sockets.size === 0) this.stopLoop();
    });

    this.startLoop();

    return new Response(null, { status: 101, webSocket: client });
  }

  private startLoop(): void {
    if (this.timer !== null) return;

    const now = Date.now();
    this.startedAt = now;
    this.lastNow = now;
    this.accumulatorMs = 0;
    this.ticks = 0;
    this.timerCallbacks = 0;
    this.maxCallbackGapMs = 0;
    this.frozenClockCallbacks = 0;
    this.catchupClamped = 0;

    this.timer = setInterval(() => this.onTimer(), TIMER_MS);
  }

  private stopLoop(): void {
    if (this.timer === null) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  /**
   * The fixed-timestep accumulator, exactly as the real server would run it.
   *
   * Wall-clock delta feeds an accumulator; whole ticks are drained from it. The
   * simulation therefore advances at a rate decoupled from timer jitter, which
   * is the entire point of a fixed timestep.
   */
  private onTimer(): void {
    const now = Date.now();
    const delta = now - this.lastNow;
    this.lastNow = now;

    this.timerCallbacks++;
    if (delta > this.maxCallbackGapMs) this.maxCallbackGapMs = delta;
    if (delta === 0) this.frozenClockCallbacks++;

    this.accumulatorMs += delta;

    let ticksThisCallback = 0;
    while (this.accumulatorMs >= TICK_MS && ticksThisCallback < MAX_CATCHUP_TICKS) {
      this.accumulatorMs -= TICK_MS;
      this.ticks++;
      ticksThisCallback++;
      this.simulateTickWorkload();
    }

    if (this.accumulatorMs >= TICK_MS) {
      // Could not keep up within the catch-up budget; drop the backlog rather
      // than accumulate an ever-growing debt.
      this.catchupClamped++;
      this.accumulatorMs = 0;
    }

    // Broadcast at 20 Hz, matching the planned snapshot rate.
    if (this.ticks % 3 === 0 && ticksThisCallback > 0) {
      this.broadcast();
    }
  }

  /**
   * Stand-in for one simulation step.
   *
   * The real `step()` is a few hundred floating-point operations over a handful
   * of bodies. This burns a comparable amount of arithmetic so the CPU-time
   * measurement is not trivially optimistic.
   */
  private simulateTickWorkload(): void {
    let acc = this.ticks;
    for (let i = 0; i < 400; i++) {
      acc = (acc * 1.000001 + 0.5) % 100000;
    }
    // Prevent the loop being optimised away entirely.
    if (acc === Number.POSITIVE_INFINITY) throw new Error('unreachable');
  }

  private report(): Report {
    const wallElapsedMs = Date.now() - this.startedAt;
    return {
      wallElapsedMs,
      ticks: this.ticks,
      effectiveHz: wallElapsedMs > 0 ? (this.ticks * 1000) / wallElapsedMs : 0,
      timerCallbacks: this.timerCallbacks,
      maxCallbackGapMs: this.maxCallbackGapMs,
      frozenClockCallbacks: this.frozenClockCallbacks,
      catchupClamped: this.catchupClamped,
    };
  }

  private broadcast(): void {
    const payload = JSON.stringify(this.report());
    for (const socket of this.sockets) {
      try {
        socket.send(payload);
      } catch {
        this.sockets.delete(socket);
      }
    }
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname !== '/ws') {
      return new Response('POST /ws with a websocket upgrade', { status: 404 });
    }
    const id = env.ROOM.idFromName('spike');
    return env.ROOM.get(id).fetch(request);
  },
};
