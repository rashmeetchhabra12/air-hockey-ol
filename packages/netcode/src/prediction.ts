import { stateFromSnapshot, type WireSnapshot } from '@ah/protocol';
import {
  cloneState,
  createInitialState,
  length,
  PLAYER_COUNT,
  step,
  type GameState,
  type InputSet,
  type PlayerInput,
} from '@ah/sim';

/**
 * Client-side prediction and server reconciliation.
 *
 * ## The idea
 *
 * A snapshot describes the world as it was roughly half a round trip ago. If the
 * client simply rendered it, every action would visibly lag by that much. So the
 * client keeps its own copy of the simulation and applies the player's input
 * immediately — the paddle responds on the very frame the pointer moves.
 *
 * The prediction is a guess, and the server is the authority. When a snapshot
 * arrives the client throws its prediction away, adopts the authoritative state,
 * and replays every input the server had **not yet consumed** at that point.
 * Steady state has roughly one round trip of inputs outstanding, so replaying
 * them advances the authoritative state forward to "now" — which is precisely
 * where the player already believes their paddle is.
 *
 * When the prediction was right, the replayed result equals what was on screen
 * and nothing visibly happens. That is the normal case, and it is why correct
 * netcode looks like no netcode at all.
 *
 * ## Why this can work at all
 *
 * Only because `step()` is deterministic and both sides run the identical
 * module. Replay reproduces the server's arithmetic exactly rather than
 * approximately, so predictions converge instead of drifting.
 * `sim/test/determinism.test.ts` pins that property down directly.
 */

/** Visual correction blend time. Long enough to be invisible, short enough to stay responsive. */
const CORRECTION_SMOOTH_MS = 110;

/**
 * Errors below this are ignored entirely.
 *
 * Floating-point replay is exact, so a non-zero error means a genuine
 * disagreement — but a sub-pixel one is not worth spending a correction on.
 */
const CORRECTION_DEADZONE = 0.05;

/**
 * Cap on replay depth per snapshot.
 *
 * One round trip of inputs is normal. Hundreds means the connection has
 * collapsed, and replaying them all would freeze the tab trying to catch up.
 */
const MAX_REPLAY_INPUTS = 240;

/**
 * Puck corrections larger than this are snapped rather than blended.
 *
 * A goal teleports the puck to centre, and a contested rally can move it
 * hundreds of units in a tick. Easing across a discontinuity that big would
 * send the puck gliding across the rink to catch up, which reads as a bug and
 * hides the event that caused it. Small disagreements are drift and should be
 * smoothed; large ones are a different world and should be accepted at once.
 */
const PUCK_SNAP_THRESHOLD = 140;

export interface PredictionStats {
  /** Inputs awaiting acknowledgement. Tracks round-trip time in ticks. */
  unackedInputs: number;
  /** Inputs replayed during the most recent reconciliation. */
  lastReplayCount: number;
  /** Positional disagreement found by the most recent reconciliation, in rink units. */
  lastErrorUnits: number;
  /** Corrections exceeding the dead zone since connecting. */
  corrections: number;
  /** Reconciliations performed since connecting. */
  reconciliations: number;
  /** Replays truncated by the cap. Non-zero means the connection is in trouble. */
  replayTruncated: number;
  /** Snapshots refused for describing an older tick than one already applied. */
  staleSnapshotsIgnored: number;

  /**
   * Positional disagreement about the *puck* at the most recent reconciliation.
   *
   * Only meaningful under puck strategy B or C, where the client predicts the
   * puck. It is the price of that prediction: unlike the local paddle, the puck
   * is influenced by an opponent whose input has not arrived, so the client is
   * guessing and will sometimes be wrong.
   */
  lastPuckErrorUnits: number;
  /** Puck corrections exceeding the dead zone. */
  puckCorrections: number;
  /** Puck corrections large enough to be snapped rather than blended. */
  puckSnaps: number;
}

export class Predictor {
  /** Predicted state, advanced every client tick and corrected on every snapshot. */
  private state: GameState = createInitialState();

  /** Inputs sent but not yet acknowledged, oldest first. */
  private unacked: PlayerInput[] = [];

  /** Newest snapshot tick already folded in, so reordered ones can be refused. */
  private lastAppliedTick = -1;

  /** Reused so a 60 Hz tick does not allocate an input array. */
  private readonly scratch: Array<PlayerInput | null> = new Array(PLAYER_COUNT).fill(null);

  /**
   * Residual visual offset from the last correction, decayed toward zero.
   *
   * Snapping the rendered paddle to the reconciled position would make every
   * correction visible as a jolt, so the *simulation* takes the correction
   * immediately while the *rendering* catches up over a few frames.
   */
  private offsetX = 0;
  private offsetY = 0;

  /** Same mechanism as the paddle offset, applied to the predicted puck. */
  private puckOffsetX = 0;
  private puckOffsetY = 0;

  private readonly stats: PredictionStats = {
    unackedInputs: 0,
    lastReplayCount: 0,
    lastErrorUnits: 0,
    corrections: 0,
    reconciliations: 0,
    replayTruncated: 0,
    staleSnapshotsIgnored: 0,
    lastPuckErrorUnits: 0,
    puckCorrections: 0,
    puckSnaps: 0,
  };

  constructor(private slot: number) {}

  setSlot(slot: number): void {
    this.slot = slot;
  }

  getState(): GameState {
    return this.state;
  }

  getStats(): Readonly<PredictionStats> {
    return this.stats;
  }

  /** Own paddle position as it should be drawn, including the decaying correction. */
  getRenderedSelf(): { x: number; y: number } {
    const paddle = this.state.paddles[this.slot];
    if (!paddle) return { x: 0, y: 0 };
    return { x: paddle.x + this.offsetX, y: paddle.y + this.offsetY };
  }

  /**
   * Predicted puck position as it should be drawn.
   *
   * Used by puck strategies B and C. Drawn from the prediction, it sits at the
   * same instant as the local paddle — which is the whole point. Under strategy
   * A the puck comes from interpolated snapshots instead and is therefore shown
   * at a different time from the paddle about to hit it.
   */
  getRenderedPuck(): { x: number; y: number } {
    return {
      x: this.state.puck.x + this.puckOffsetX,
      y: this.state.puck.y + this.puckOffsetY,
    };
  }

  /**
   * Advance the prediction one tick with a freshly sampled input.
   *
   * Called at a fixed 60 Hz, matching the server, so predicted and
   * authoritative timelines advance at the same rate.
   */
  predict(input: PlayerInput): void {
    this.unacked.push(input);
    // Bound memory if snapshots stop arriving entirely.
    if (this.unacked.length > MAX_REPLAY_INPUTS * 2) this.unacked.shift();

    this.state = step(this.state, this.inputsFor(input));
    this.stats.unackedInputs = this.unacked.length;
  }

  /**
   * Adopt authoritative state and replay everything the server had not consumed.
   *
   * The remote paddle is replayed with a `null` input, meaning "keep seeking your
   * stored target". That target rides on the wire precisely so this replay can
   * move the opponent the way the server will, rather than leaving them frozen —
   * they strike the puck, so a stationary stand-in would corrupt the predicted
   * puck as well as the paddle.
   */
  reconcile(snapshot: WireSnapshot): void {
    /**
     * Snapshots arrive in transmission order only on a perfect link. Jitter
     * reorders them, so a snapshot describing tick 100 can land after one
     * describing tick 103.
     *
     * Applying it would rewind the prediction to older authoritative state and
     * throw away the newer information already incorporated. Replay would still
     * converge — it is deterministic — but the remote paddle would regress to a
     * stale position and be carried forward by "keep seeking the last known
     * target" instead of the real data already received, which is strictly
     * worse and costs a full replay to do.
     */
    if (snapshot.tick <= this.lastAppliedTick) {
      this.stats.staleSnapshotsIgnored++;
      return;
    }
    this.lastAppliedTick = snapshot.tick;

    const previous = this.state.paddles[this.slot];
    const beforeX = previous?.x ?? 0;
    const beforeY = previous?.y ?? 0;
    const beforePuckX = this.state.puck.x;
    const beforePuckY = this.state.puck.y;

    let rebuilt = stateFromSnapshot(snapshot, this.state);

    const ack = snapshot.acks[this.slot] ?? -1;
    // Everything at or below the ack is now part of authoritative history.
    this.unacked = this.unacked.filter((input) => input.seq > ack);

    if (this.unacked.length > MAX_REPLAY_INPUTS) {
      this.stats.replayTruncated++;
      this.unacked = this.unacked.slice(-MAX_REPLAY_INPUTS);
    }

    for (const input of this.unacked) {
      rebuilt = step(rebuilt, this.inputsFor(input));
    }

    this.state = rebuilt;
    this.stats.reconciliations++;
    this.stats.lastReplayCount = this.unacked.length;
    this.stats.unackedInputs = this.unacked.length;

    this.reconcilePuck(beforePuckX, beforePuckY);

    const corrected = this.state.paddles[this.slot];
    if (!corrected) return;

    const errorX = beforeX - corrected.x;
    const errorY = beforeY - corrected.y;
    const error = length(errorX, errorY);
    this.stats.lastErrorUnits = error;

    if (error > CORRECTION_DEADZONE) {
      this.stats.corrections++;
      // Carry the discrepancy into the visual offset so the on-screen paddle
      // does not jump. The simulation itself is already corrected.
      this.offsetX += errorX;
      this.offsetY += errorY;
    }
  }

  /**
   * Fold a puck disagreement into the visual offset.
   *
   * Unlike the local paddle, the puck genuinely cannot be predicted reliably:
   * it is influenced by an opponent whose input has not arrived, so the
   * client's replay moves their paddle by "keep seeking the last known target"
   * and is simply wrong whenever they did something else. Small errors are
   * eased away; a large one means the worlds diverged outright and is taken
   * immediately.
   */
  private reconcilePuck(beforeX: number, beforeY: number): void {
    const errorX = beforeX - this.state.puck.x;
    const errorY = beforeY - this.state.puck.y;
    const error = length(errorX, errorY);
    this.stats.lastPuckErrorUnits = error;

    if (error <= CORRECTION_DEADZONE) return;

    if (error > PUCK_SNAP_THRESHOLD) {
      // A goal reset or a contested collision resolved differently. Blending
      // across it would send the puck sliding to catch up.
      this.stats.puckSnaps++;
      this.puckOffsetX = 0;
      this.puckOffsetY = 0;
      return;
    }

    this.stats.puckCorrections++;
    this.puckOffsetX += errorX;
    this.puckOffsetY += errorY;
  }

  /** Decay the visual corrections. Called once per rendered frame. */
  decayCorrection(deltaMs: number): void {
    // Exponential decay, framerate-independent: the same wall-clock time
    // produces the same amount of catch-up at 60 Hz or 144 Hz.
    const retain = Math.exp(-deltaMs / CORRECTION_SMOOTH_MS);

    if (this.offsetX !== 0 || this.offsetY !== 0) {
      this.offsetX *= retain;
      this.offsetY *= retain;
      if (length(this.offsetX, this.offsetY) < CORRECTION_DEADZONE) {
        this.offsetX = 0;
        this.offsetY = 0;
      }
    }

    if (this.puckOffsetX !== 0 || this.puckOffsetY !== 0) {
      this.puckOffsetX *= retain;
      this.puckOffsetY *= retain;
      if (length(this.puckOffsetX, this.puckOffsetY) < CORRECTION_DEADZONE) {
        this.puckOffsetX = 0;
        this.puckOffsetY = 0;
      }
    }
  }

  /** Adopt a snapshot wholesale, discarding history. Used on first sync and after a stall. */
  resync(snapshot: WireSnapshot): void {
    this.state = stateFromSnapshot(snapshot);
    this.unacked = [];
    this.lastAppliedTick = snapshot.tick;
    this.offsetX = 0;
    this.offsetY = 0;
    this.puckOffsetX = 0;
    this.puckOffsetY = 0;
    this.stats.unackedInputs = 0;
  }

  /** Snapshot of the predicted state, for the debug overlay. */
  cloneStateForDebug(): GameState {
    return cloneState(this.state);
  }

  private inputsFor(input: PlayerInput): InputSet {
    for (let i = 0; i < this.scratch.length; i++) this.scratch[i] = null;
    this.scratch[this.slot] = input;
    return this.scratch as InputSet;
  }
}
