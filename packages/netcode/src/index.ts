/**
 * Netcode: the mechanisms that hide latency.
 *
 * Deliberately its own package rather than living inside the client. Nothing
 * here touches the DOM, a socket, or a clock it did not receive as an argument,
 * which means the measurement harness drives *this exact code* rather than a
 * reimplementation of it. A benchmark that measures a copy of the system
 * measures nothing.
 */

export { Predictor } from './prediction.js';
export type { PredictionStats } from './prediction.js';

export { SnapshotBuffer, INTERPOLATION_DELAY_MS } from './interpolation.js';
export type { InterpolatedView, InterpolationStats } from './interpolation.js';

export { TickPacer } from './pacer.js';
export type { PacerStats } from './pacer.js';

export { ClientSession } from './session.js';
export type { SessionOptions } from './session.js';

export {
  resolvePuck,
  PuckSmoother,
  PUCK_STRATEGIES,
  MAX_CATCHUP_FRACTION,
  maxPlausibleFrameTravel,
} from './puck.js';
export type { PuckStrategy, PuckResolution, PuckSource, Point } from './puck.js';
