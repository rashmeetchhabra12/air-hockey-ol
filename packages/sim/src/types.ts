/** A circular body with position and velocity, in rink units and units/second. */
export interface Body {
  x: number;
  y: number;
  vx: number;
  vy: number;
}

export interface Paddle extends Body {
  /**
   * Velocity actually realised this tick after clamping to `PADDLE_MAX_SPEED`
   * and to the player's own half. Collision impulse uses this rather than the
   * requested movement, so an illegal request cannot produce a legal-looking hit.
   */
  vx: number;
  vy: number;
  /**
   * Position the paddle is currently seeking, carried in state rather than read
   * from the input each tick. A tick with no input then degrades to "keep moving
   * toward the last known target" instead of "stop dead", which is what makes a
   * single dropped packet invisible. Because it affects future state, it is part
   * of the hash.
   */
  targetX: number;
  targetY: number;
}

export type Puck = Body;

/**
 * Complete authoritative game state at a single tick.
 *
 * This is the *entire* simulation contract. Anything not in here cannot affect
 * the outcome of `step`, which is what makes rollback and replay sound.
 */
export interface GameState {
  /** Monotonic integer tick counter. Never derived from a wall clock. */
  tick: number;
  /** Fixed-length, indexed by player slot. Order is part of the determinism contract. */
  paddles: Paddle[];
  puck: Puck;
  /** Fixed-length, indexed by player slot. */
  score: number[];
  /** Slot of the last player to strike the puck, or -1. Drives transient authority in P5. */
  lastTouchedBy: number;
  /** Tick of that strike, or -1. */
  lastTouchTick: number;
  /** Ticks remaining in the post-goal freeze. Zero during normal play. */
  freezeTicks: number;
  /**
   * Slot currently entitled to predict the puck, or -1 for nobody.
   *
   * Derived by the server from authoritative state every tick — never claimed
   * by a client. Since the server simulates all of the physics it already knows
   * who is playing the puck, so a claim protocol would add attack surface and
   * no information. See `authority.ts`.
   */
  puckOwner: number;
  /**
   * Monotonic counter, incremented on every ownership change.
   *
   * Observability, not correctness. The visual crossfade keys off the render
   * *source* changing, not off this — an ownership change a client never
   * renders is one it cannot see, and blending on it injects a correction where
   * there was no discontinuity.
   *
   * What it is genuinely good for is measuring authority churn, which is how
   * the hysteresis margin gets tuned: a rising handoff rate means the puck is
   * flip-flopping across the centre line and the margin is too small. Being in
   * the hash also means a divergence in ownership *history* is caught, not just
   * in the current owner.
   */
  puckOwnerEpoch: number;
  /** Slot that scored most recently, or -1. Presentation only. */
  lastGoalBy: number;
  /** Tick of the most recent goal, or -1. Presentation only. */
  lastGoalTick: number;
}

/**
 * One player's intent for one tick.
 *
 * Air hockey input is a target position rather than a direction: the client
 * sends where the player wants the paddle, and the simulation moves it there at
 * a bounded speed. This makes mouse and touch control identical, and it means a
 * dropped input degrades to "keep seeking the last known target" rather than
 * "stop dead".
 */
export interface PlayerInput {
  /** Per-client monotonic sequence number. The server acks the highest it has consumed. */
  seq: number;
  targetX: number;
  targetY: number;
}

/**
 * Inputs for one tick, indexed by player slot.
 *
 * `null` means no input arrived for that slot this tick; the simulation holds
 * the paddle's existing target. Ordering by slot index — never by object key
 * or arrival time — is what keeps the step deterministic.
 */
export type InputSet = ReadonlyArray<PlayerInput | null>;

/** Something worth reacting to that happened during a step. Never affects future state. */
export type SimEvent =
  | { type: 'paddleHit'; slot: number; tick: number; speed: number }
  | { type: 'wallHit'; tick: number; speed: number }
  | { type: 'postHit'; tick: number; speed: number }
  | { type: 'goal'; scoringSlot: number; tick: number };
