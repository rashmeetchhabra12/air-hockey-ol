import { PUCK_MAX_SPEED } from '@ah/sim';

import type { InterpolatedView } from './interpolation.js';
import type { Predictor } from './prediction.js';

/**
 * How the puck is decided for display.
 *
 * All strategies stay in the codebase and switch at runtime. Keeping them is
 * the point of the project rather than an accident of its history: showing the
 * progression with measured numbers demonstrates an understanding of the
 * tradeoff space, where shipping only the last one would demonstrate having
 * memorised an answer.
 *
 * - **interpolate** (A) — drawn from authoritative snapshots, in the past.
 *   Always genuinely correct data, but shown at a different instant from the
 *   paddle about to hit it. Your own strikes feel delayed.
 *
 * - **predict** (B) — drawn from the client's own simulation, at the same
 *   instant as the local paddle. Strikes respond immediately. The cost is that
 *   the puck is influenced by an opponent whose input has not arrived, so the
 *   prediction is wrong whenever they are near it.
 *
 * - **authority** (C) — predict the puck only while the server says this client
 *   owns it. Gets B's responsiveness for the player actually playing the puck,
 *   and A's correctness for the one who is not.
 */
export type PuckStrategy = 'interpolate' | 'predict' | 'authority';

export const PUCK_STRATEGIES: readonly PuckStrategy[] = ['interpolate', 'predict', 'authority'];

export interface Point {
  x: number;
  y: number;
}

export type PuckSource = 'interpolated' | 'predicted';

export interface PuckResolution {
  position: Point;
  /** Which mechanism actually produced this frame's position. */
  source: PuckSource;
  /** Server-assigned owner at the time of this frame, or -1. */
  owner: number;
}

/**
 * Decide where to draw the puck this frame.
 *
 * Pure: everything it consults is state it was handed, so the same call in the
 * browser and in the harness produces the same answer.
 */
export function resolvePuck(
  strategy: PuckStrategy,
  predictor: Predictor,
  interpolated: InterpolatedView | null,
  localSlot: number,
): PuckResolution {
  const owner = predictor.getState().puckOwner;

  const predicted = (): PuckResolution => ({
    position: predictor.getRenderedPuck(),
    source: 'predicted',
    owner,
  });

  const fromSnapshots = (): PuckResolution | null =>
    interpolated ? { position: interpolated.puck, source: 'interpolated', owner } : null;

  switch (strategy) {
    case 'predict':
      return predicted();

    case 'authority':
      // Predict only while this client is the one whose input decides what the
      // puck does next. When the opponent owns it — or nobody does, because it
      // is contested — their inputs matter and we have not seen them, so
      // real-but-late data beats a confident guess.
      return owner === localSlot ? predicted() : (fromSnapshots() ?? predicted());

    case 'interpolate':
    default:
      // Falls back to the prediction only before the first snapshots arrive,
      // when there is nothing to interpolate between.
      return fromSnapshots() ?? predicted();
  }
}

/** Blend time for a handoff. Long enough to hide the jump, short enough not to smear. */
const HANDOFF_SMOOTH_MS = 130;

/** Below this the residual offset is not worth carrying. */
const HANDOFF_DEADZONE = 0.05;

/**
 * Ceiling on how fast the blend may close a gap, as a fraction of the puck's own
 * speed limit.
 *
 * Exponential decay alone is not enough. A handoff at 200 ms RTT spans roughly a
 * third of a second of puck travel — some six hundred units at speed — and
 * easing that away over 130 ms moves the puck at about 4500 units/s, two and a
 * half times faster than a puck can physically travel. The result is not a
 * smooth correction but a visible rocket, which is the very artefact the blend
 * exists to prevent.
 *
 * Capping the rate means a large handoff simply takes longer to reconcile,
 * during which the puck looks like it is moving somewhat fast — which is a thing
 * pucks do.
 */
export const MAX_CATCHUP_FRACTION = 0.6;

/**
 * The fastest the displayed puck can legitimately move in one frame: its own
 * speed limit plus the blend's catch-up allowance.
 *
 * Exported because measurement needs it. Anything faster than this did not
 * travel, it was relocated — and a detector that guessed the figure instead
 * would flag ordinary catch-up as a teleport.
 */
export function maxPlausibleFrameTravel(frameMs: number): number {
  // The 5% tolerance matters: the catch-up cap is set so that full-speed motion
  // *plus* full catch-up lands exactly on this bound, so without slack a frame
  // doing both legitimately is a coin-flip away from being called a teleport.
  return ((PUCK_MAX_SPEED * (1 + MAX_CATCHUP_FRACTION)) / 1000) * frameMs * 1.05;
}

/**
 * Hides the discontinuity when the puck changes source.
 *
 * Predicted and interpolated positions describe the same puck at two different
 * instants, roughly a round trip apart. Switching between them therefore
 * teleports it — backwards on handing authority away, forwards on taking it
 * back — by however far the puck travels in that time, which at speed is most
 * of the rink.
 *
 * The fix is the same one used for reconciliation corrections: the *logic*
 * switches source immediately, while the *picture* carries the difference as an
 * offset that decays. The player sees the puck accelerate briefly rather than
 * jump.
 */
export class PuckSmoother {
  private offsetX = 0;
  private offsetY = 0;
  private lastShown: Point | null = null;
  private lastSource: PuckSource | null = null;

  /** Handoffs blended so far, for the debug overlay and measurement. */
  handoffs = 0;

  /**
   * Blend if the puck changed source since the last frame.
   *
   * Keyed on the *render source* rather than on the ownership epoch. Ownership
   * is re-derived every tick and its version therefore changes constantly, but
   * a change only produces a visible discontinuity when it actually moves this
   * client between predicting and interpolating. Keying on the epoch fires on
   * every ownership change including ones this client never renders — under
   * strategy B, where the source is always the prediction, that injected a
   * spurious offset on almost every frame.
   *
   * An ownership change this client does not render is, by definition, one it
   * cannot see.
   */
  apply(raw: PuckResolution, deltaMs: number): Point {
    const changed = this.lastSource !== null && raw.source !== this.lastSource;

    if (changed && this.lastShown) {
      // Carry the gap between the two timelines into the visual offset.
      this.offsetX += this.lastShown.x - raw.position.x;
      this.offsetY += this.lastShown.y - raw.position.y;
      this.handoffs++;
    }

    this.lastSource = raw.source;

    if (this.offsetX !== 0 || this.offsetY !== 0) {
      // Framerate-independent decay: the same wall-clock time produces the same
      // catch-up at 60 Hz or 144 Hz.
      const retain = Math.exp(-deltaMs / HANDOFF_SMOOTH_MS);
      const magnitude = Math.sqrt(this.offsetX * this.offsetX + this.offsetY * this.offsetY);
      const wanted = magnitude * (1 - retain);
      const allowed = ((PUCK_MAX_SPEED * MAX_CATCHUP_FRACTION) / 1000) * deltaMs;

      // Shrink by whichever is smaller, so a large gap closes at a plausible
      // speed instead of instantly.
      const shrink = Math.min(wanted, allowed);
      const scale = magnitude > 0 ? Math.max(0, 1 - shrink / magnitude) : 0;

      this.offsetX *= scale;
      this.offsetY *= scale;
      if (Math.abs(this.offsetX) + Math.abs(this.offsetY) < HANDOFF_DEADZONE) {
        this.offsetX = 0;
        this.offsetY = 0;
      }
    }

    const shown = {
      x: raw.position.x + this.offsetX,
      y: raw.position.y + this.offsetY,
    };
    this.lastShown = shown;
    return shown;
  }

  reset(): void {
    this.offsetX = 0;
    this.offsetY = 0;
    this.lastShown = null;
    this.lastSource = null;
  }
}
