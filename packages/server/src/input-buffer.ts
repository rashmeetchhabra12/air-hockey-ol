import type { PlayerInput } from '@ah/sim';

/**
 * Hard cap on buffered inputs per client.
 *
 * Bounds memory against a client that floods, and bounds how far ahead a client
 * may run before the server simply stops accepting its intentions.
 */
const MAX_PENDING = 64;

export type PushResult =
  /** Stored for its tick, which the server has not yet simulated. */
  | 'buffered'
  /** Arrived after the server had already simulated that tick. */
  | 'late'
  /** Already held, or already consumed. Normal, given redundant transmission. */
  | 'duplicate'
  /** Older than the rewind window, or beyond the buffer cap. */
  | 'rejected';

/**
 * Per-client input buffer, keyed by the tick the input was meant for.
 *
 * ## Why keyed by tick
 *
 * An earlier version consumed one input per tick in arrival order, which meant
 * the server applied a given input at whatever tick it happened to reach the
 * front of the queue. Client and server then ran the same inputs at *different*
 * ticks whenever a packet was lost or delayed, and their timelines diverged.
 *
 * Stamping each input with the tick the client simulated it at makes the two
 * sides agree by construction: the server applies input for tick T at tick T, or
 * — if it arrives late — rewinds and replays so that it still lands there. That
 * is what makes lag compensation expressible at all.
 */
export class InputBuffer {
  private readonly pending = new Map<number, PlayerInput>();
  /** Highest tick consumed so far, so stragglers can be recognised. */
  private lastConsumedTick = -1;

  /** Highest tick whose input has been applied. This is what gets acked. */
  get ack(): number {
    return this.lastConsumedTick;
  }

  get size(): number {
    return this.pending.size;
  }

  /**
   * How many inputs are buffered for ticks the server has not yet reached.
   *
   * Reported to the client so it can steer how far ahead it runs: too shallow
   * and inputs arrive late, too deep and the player is needlessly ahead of the
   * server and feeling more input latency than the link requires.
   */
  depthAbove(tick: number): number {
    let n = 0;
    for (const key of this.pending.keys()) {
      if (key > tick) n++;
    }
    return n;
  }

  /**
   * @param currentTick the tick the server has most recently simulated
   * @param rewindWindow how far back a late input may still be honoured
   */
  push(input: PlayerInput, currentTick: number, rewindWindow: number): PushResult {
    const target = input.seq;

    if (this.pending.has(target)) return 'duplicate';
    if (target <= this.lastConsumedTick) {
      // Already simulated. Recoverable only if it is inside the rewind window.
      return target > currentTick - rewindWindow ? 'late' : 'rejected';
    }

    if (this.pending.size >= MAX_PENDING) return 'rejected';

    this.pending.set(target, input);
    return 'buffered';
  }

  /**
   * Take the input intended for exactly this tick.
   *
   * `null` is a normal outcome, not an error: the simulation keeps the paddle
   * seeking its stored target, so a missing input degrades to slightly stale
   * intent rather than a stalled paddle.
   */
  take(tick: number): PlayerInput | null {
    const input = this.pending.get(tick);
    if (input === undefined) {
      if (tick > this.lastConsumedTick) this.lastConsumedTick = tick;
      return null;
    }

    this.pending.delete(tick);
    this.lastConsumedTick = tick;

    // Anything still buffered for an earlier tick can never be used now.
    for (const key of this.pending.keys()) {
      if (key < tick) this.pending.delete(key);
    }

    return input;
  }

  /** Peek without consuming, for rewind replay. */
  peek(tick: number): PlayerInput | null {
    return this.pending.get(tick) ?? null;
  }

  reset(): void {
    this.pending.clear();
    this.lastConsumedTick = -1;
  }
}
