/**
 * Steers how far ahead of the server the client simulates.
 *
 * ## Why any steering is needed
 *
 * The client stamps each input with the tick it simulated it at, and the server
 * applies it at that tick. For that to work the input has to *arrive* before the
 * server gets there, which means the client must run ahead by at least the
 * one-way delay.
 *
 * Left alone, the lead settles at almost exactly the round trip — the client
 * emits one input per tick and the server acknowledges one per tick, so the
 * number in flight is conserved. "Almost exactly" is the problem: it leaves no
 * margin, so ordinary jitter puts inputs a tick late, and every late input costs
 * the server a rewind. A little deliberate slack removes most of them.
 *
 * ## How it steers
 *
 * The server reports how many inputs it holds for ticks it has not yet reached.
 * Depth near zero means the client is cutting it fine; a large depth means it is
 * running further ahead than the link requires and the player is feeling input
 * latency for nothing.
 *
 * Corrections are applied by occasionally simulating two ticks in one frame, or
 * none — never by jumping the tick counter. A jump would desynchronise the
 * predicted timeline from the inputs already in flight; running an extra tick
 * simply produces an extra input, which the server consumes exactly as it would
 * any other.
 */

/**
 * Buffered ticks to aim for.
 *
 * ## Why not one
 *
 * The feedback is itself a round trip stale — the depth being reacted to was
 * measured before the snapshot was sent — so steering for a bare minimum
 * converges on a lead with no margin, and ordinary variation then puts inputs
 * past their deadline. Measured at 300 ms RTT, a target of one left the client
 * starved on 40% of ticks despite a nominally sufficient lead.
 *
 * ## Why not six either
 *
 * A bigger lead is not free, and the cost is easy to miss because it lands on a
 * different metric. Running further ahead means *predicting* further ahead, and
 * the puck prediction degrades the further out it reaches, since more of the
 * opponent's unseen input falls inside the window. Raising this to six drove
 * late inputs to zero and simultaneously pushed the predicted puck's error from
 * roughly 7 units to roughly 95 — trading a problem lag compensation already
 * handles for one it cannot.
 *
 * Three is the measured middle: few enough late inputs that rewind absorbs them
 * without a visible correction, and a lead short enough to keep the prediction
 * worth having.
 */
const DEFAULT_TARGET_DEPTH = 3;

/** Bounds on queued correction, so a bad reading cannot send the client sprinting. */
const MIN_ADJUST = -4;
const MAX_ADJUST = 12;

export interface PacerStats {
  /** Ticks of correction still queued. Positive means catching up. */
  queued: number;
  /** Frames that ran an extra tick. */
  speedUps: number;
  /** Frames that ran no tick at all. */
  stalls: number;
  /** Snapshots reporting an empty forward buffer — inputs were arriving late. */
  starvedReports: number;
}

export class TickPacer {
  private adjust: number;

  private readonly stats: PacerStats = {
    queued: 0,
    speedUps: 0,
    stalls: 0,
    starvedReports: 0,
  };

  /**
   * @param initialLead ticks to run ahead before any feedback arrives. Spent
   *                    over the first frames, so the client establishes a lead
   *                    without a visible jump.
   */
  constructor(
    initialLead = 4,
    private readonly targetDepth = DEFAULT_TARGET_DEPTH,
  ) {
    this.adjust = initialLead;
    this.stats.queued = initialLead;
  }

  getStats(): Readonly<PacerStats> {
    return this.stats;
  }

  /** Feed the server's reported forward-buffer depth for this client. */
  observe(depth: number): void {
    if (depth < 1) {
      // The server had nothing queued for the tick it just simulated, so this
      // client's inputs are arriving at or after their deadline. Correct
      // aggressively: running late costs a server rewind on every input and,
      // worse, a visible correction whenever the client reconciles against a
      // snapshot the server is about to revise.
      this.stats.starvedReports++;
      this.adjust += 3;
    } else if (depth < this.targetDepth) {
      this.adjust += 1;
    } else if (depth > this.targetDepth + 1) {
      /**
       * Overshooting is not free, and the cost is easy to overlook because it
       * does not show up as latency on the local paddle.
       *
       * A larger lead means the client predicts further ahead of the server,
       * which widens the gap between the predicted puck and the interpolated
       * one. Under strategy C the display switches between those two sources
       * whenever authority changes hands, so every extra tick of lead makes
       * that switch a bigger visible jump. On a fast link the deadband was wide
       * enough that the lead never shrank below its starting value, and the puck
       * appeared to teleport on a connection with no latency at all.
       *
       * Still asymmetric — three ticks up when starved, one down when fat —
       * because arriving late is much worse than arriving early.
       */
      this.adjust -= 1;
    }

    if (this.adjust > MAX_ADJUST) this.adjust = MAX_ADJUST;
    if (this.adjust < MIN_ADJUST) this.adjust = MIN_ADJUST;
    this.stats.queued = this.adjust;
  }

  /**
   * How many simulation ticks to run this frame. Normally 1.
   *
   * Returning 2 pushes the client further ahead; returning 0 lets the server
   * catch up. Both are single-tick corrections, so the pacing changes gradually
   * rather than in a jolt.
   */
  ticksThisFrame(): number {
    if (this.adjust > 0) {
      this.adjust--;
      this.stats.queued = this.adjust;
      this.stats.speedUps++;
      return 2;
    }
    if (this.adjust < 0) {
      this.adjust++;
      this.stats.queued = this.adjust;
      this.stats.stalls++;
      return 0;
    }
    return 1;
  }

  reset(initialLead = 4): void {
    this.adjust = initialLead;
    this.stats.queued = initialLead;
  }
}
