import {
  AUTHORITY_CONTEST_RADIUS,
  AUTHORITY_HYSTERESIS,
  PLAYER_COUNT,
  RINK_WIDTH,
  SLOT_LEFT,
  SLOT_RIGHT,
} from './config.js';
import { length } from './math.js';
import type { GameState } from './types.js';

/**
 * Transient puck authority.
 *
 * ## The problem it solves
 *
 * Predicting the puck (strategy B) makes it exactly right at the median and
 * badly wrong in the tail, because the puck is influenced by an opponent whose
 * input has not arrived. Never predicting it (strategy A) makes it consistently
 * stale. Neither is satisfactory, and the reason is that they answer a single
 * question for the whole rink when the honest answer varies by situation:
 *
 *   *is this client's own input what decides what the puck does next?*
 *
 * When the puck is in your half and heading for your paddle, yes — so predict
 * it, and your strike lands the instant you make it. When it is at the far end
 * being played by your opponent, no — so draw real data, late, and be right.
 *
 * ## Why ownership is derived, not claimed
 *
 * The server simulates all physics, so it already knows where the puck is and
 * who is near it. A protocol where clients *claim* the puck would add a
 * conflict-resolution problem, an attack surface, and no information the server
 * did not already hold. Ownership is therefore a pure function of authoritative
 * state, computed identically on both sides, and published in the snapshot.
 *
 * The genuine concurrency question — what happens when both players strike in
 * the same tick — is settled inside the collision solver, which resolves
 * contacts in time-of-impact order and breaks exact ties by slot index. That is
 * deterministic, so every participant reaches the same answer without
 * negotiating.
 */

/** Which half of the rink a point falls in. */
function halfOf(x: number): number {
  return x < RINK_WIDTH / 2 ? SLOT_LEFT : SLOT_RIGHT;
}

/**
 * Decide who, if anyone, may predict the puck this tick.
 *
 * @returns a slot index, or -1 when the puck is contested or in open play.
 */
export function computePuckOwner(state: GameState): number {
  // Nobody owns a dead puck: during the post-goal freeze it is not moving and
  // there is nothing to predict.
  if (state.freezeTicks > 0) return -1;

  let owner = halfOf(state.puck.x);

  // Hysteresis: an established owner keeps the puck until it has clearly left
  // their half, so a puck loitering on the line does not flip repeatedly.
  if (state.puckOwner >= 0 && owner !== state.puckOwner) {
    const line = RINK_WIDTH / 2;
    const beyond = owner === SLOT_LEFT ? line - state.puck.x : state.puck.x - line;
    if (beyond < AUTHORITY_HYSTERESIS) {
      owner = state.puckOwner;
    }
  }

  const opponent = owner === SLOT_LEFT ? SLOT_RIGHT : SLOT_LEFT;
  const paddle = state.paddles[opponent];
  if (paddle) {
    /**
     * Contested: the other paddle is close enough to strike, so this player's
     * input no longer decides the outcome and nobody may predict it.
     *
     * Proximity alone is not enough. Paddles cannot cross the centre line, so
     * the opponent's sits pinned at it whenever the puck is in this half —
     * permanently "near" a puck it often cannot reach. Requiring the puck to be
     * heading *towards* them as well is what makes the rule mean something: a
     * receding puck has already left their reach.
     *
     * This is also the case that matters most. A puck travelling towards you is
     * one you are about to hit, and that is exactly when ownership — and so
     * prediction, and so an instant-feeling strike — should be yours.
     */
    const approaching = owner === SLOT_LEFT ? state.puck.vx >= 0 : state.puck.vx <= 0;
    if (approaching) {
      const gap = length(state.puck.x - paddle.x, state.puck.y - paddle.y);
      if (gap < AUTHORITY_CONTEST_RADIUS) return -1;
    }
  }

  return owner < PLAYER_COUNT ? owner : -1;
}

/**
 * Apply the ownership decision, bumping the epoch on any change.
 *
 * Mutates in place; called from `step` after the puck has moved.
 */
export function updatePuckAuthority(state: GameState): void {
  const owner = computePuckOwner(state);
  if (owner === state.puckOwner) return;
  state.puckOwner = owner;
  state.puckOwnerEpoch++;
}
