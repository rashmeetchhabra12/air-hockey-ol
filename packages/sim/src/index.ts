/**
 * Deterministic air hockey simulation.
 *
 * This package is imported verbatim by both the client and the server. There is
 * exactly one implementation of the game rules, so client prediction and server
 * authority cannot disagree about what *should* have happened — only about
 * which inputs each side had seen. That distinction is the whole reason
 * reconciliation is able to converge.
 *
 * Constraints this package holds itself to:
 *   - no I/O, no wall clock, no unseeded randomness
 *   - no `Math` calls that are not correctly rounded (see `math.ts`)
 *   - no Node- or browser-specific globals, so it runs unchanged on
 *     Node, workerd, and in the browser
 */

export * from './config.js';
export type {
  Body,
  GameState,
  InputSet,
  Paddle,
  PlayerInput,
  Puck,
  SimEvent,
} from './types.js';
export {
  createInitialState,
  cloneState,
  statesEqual,
  paddleHome,
  paddleBoundsX,
  resetPaddlesHome,
} from './state.js';
export { step, stepMany } from './step.js';
export { advancePuck, sweepCircleVsCircle, goalByPosition, containPuck } from './physics.js';
export { computePuckOwner, updatePuckAuthority } from './authority.js';
export { hashState, hashStateHex } from './hash.js';
export { clamp, length, lengthSq, limitScale } from './math.js';
