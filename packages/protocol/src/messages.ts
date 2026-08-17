/**
 * Wire message shapes.
 *
 * Field names are short because they are paid for on every snapshot at 20 Hz.
 * They are not *maximally* short: P7 replaces this codec with a binary one and
 * publishes the before/after bandwidth, and that comparison is only honest if
 * the JSON baseline is what a reasonable person would have written rather than
 * something deliberately bloated.
 */

/** One tick of player intent. `seq` is the client's tick counter. */
export interface WireInput {
  seq: number;
  /** Requested paddle target, in rink units. */
  x: number;
  y: number;
}

/** Snapshot of authoritative state. Identical bytes for every recipient. */
export interface WireSnapshot {
  t: 'snap';
  /** Server tick this state represents. */
  tick: number;
  /** Puck as [x, y, vx, vy]. */
  puck: [number, number, number, number];
  /** Paddles as [x, y, vx, vy], indexed by slot. */
  pads: Array<[number, number, number, number]>;
  /**
   * Paddle seek targets as [x, y], indexed by slot.
   *
   * Carried even though it looks derivable, because it is not: a paddle keeps
   * moving toward its stored target on ticks where no input arrives. During
   * reconciliation the client replays only its *own* unacknowledged inputs, so
   * without the opponent's target it would leave that paddle stationary while
   * the server kept it moving. The paddles strike the puck, so that discrepancy
   * would propagate straight into the predicted puck position.
   */
  tgts: Array<[number, number]>;
  score: number[];
  /** Remaining post-goal freeze ticks. */
  frz: number;
  /** Slot that last struck the puck, or -1. */
  touch: number;
  /**
   * Tick of that strike, or -1.
   *
   * Carried even though nothing reads it yet. It is part of the state hash, so
   * omitting it makes a reconciled client disagree with the server whenever a
   * strike happened in server history but not during the client's replay — a
   * desync that appears only at certain tick counts and is miserable to trace.
   * P5's transient authority will read it directly.
   */
  touchTick: number;
  /** Slot entitled to predict the puck, or -1. Drives strategy C. */
  own: number;
  /**
   * Ownership version, incremented on every handoff.
   *
   * Diagnostic rather than load-bearing: it makes authority churn measurable,
   * which is how the hysteresis margin is tuned. The client's crossfade keys
   * off its own render source changing instead.
   */
  ownEp: number;
  /**
   * Highest input seq the server has consumed, indexed by slot.
   *
   * Indexed rather than per-recipient so one serialisation can be broadcast to
   * everyone — each client simply reads its own slot. This matters because
   * outgoing WebSocket messages dominate the traffic.
   */
  acks: number[];
  /**
   * Buffered inputs the server holds for ticks it has not yet simulated,
   * indexed by slot.
   *
   * Feedback for the client's pacing. Too shallow and its inputs keep arriving
   * late, so it should run further ahead; too deep and it is needlessly ahead of
   * the server, feeling more input latency than the link actually imposes.
   */
  depth: number[];
}

export type ClientMessage =
  | {
      t: 'in';
      /**
       * The most recent inputs, newest last.
       *
       * Sent redundantly — each packet repeats the previous few ticks — so a
       * single dropped packet costs nothing. This is a UDP-era technique and it
       * still pays here, because TCP's retransmission of a *stale* input is
       * worthless to us: by the time it arrives the server has moved on.
       */
      inputs: WireInput[];
    }
  | { t: 'ping'; id: number; sent: number };

export type ServerMessage =
  | { t: 'welcome'; slot: number; tick: number; tickRate: number }
  | WireSnapshot
  | { t: 'pong'; id: number; sent: number; serverTick: number }
  | { t: 'full' };

/** Guard used by every decode path. `NaN` and `Infinity` must never reach the simulation. */
export function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

/** Integers only, and within a sane range — sequence numbers and slots are both bounded. */
export function isSafeInt(v: unknown, min: number, max: number): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max;
}
