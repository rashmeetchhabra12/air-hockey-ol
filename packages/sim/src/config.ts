/**
 * Simulation constants.
 *
 * Every value here is part of the simulation contract: client and server must
 * agree on all of them exactly, or reconciliation will never converge. They are
 * plain `number` literals rather than anything computed at load time so that
 * both runtimes see identical bits.
 */

/** Simulation ticks per second. The server advances state at exactly this rate. */
export const TICK_RATE = 60;

/**
 * Seconds per tick. `1 / 60` is not exactly representable in binary floating
 * point, but it is inexact *identically* everywhere, which is all determinism
 * requires.
 */
export const DT = 1 / TICK_RATE;

// ---------------------------------------------------------------------------
// Rink geometry. Origin is top-left, +x right, +y down (matches canvas).
// ---------------------------------------------------------------------------

export const RINK_WIDTH = 1000;
export const RINK_HEIGHT = 600;

/** Vertical extent of the goal mouth, centred on each end wall. */
export const GOAL_WIDTH = 220;
export const GOAL_Y_MIN = (RINK_HEIGHT - GOAL_WIDTH) / 2;
export const GOAL_Y_MAX = (RINK_HEIGHT + GOAL_WIDTH) / 2;

/** Goal posts are solid circles at the mouth edges, so shots can ricochet off them. */
export const POST_RADIUS = 7;

// ---------------------------------------------------------------------------
// Bodies
// ---------------------------------------------------------------------------

export const PUCK_RADIUS = 18;
export const PADDLE_RADIUS = 34;

/**
 * Paddles cannot teleport. Without a speed cap a client could jump its paddle
 * onto the puck and impart unbounded impulse, which is both a feel problem and
 * a cheat vector.
 */
export const PADDLE_MAX_SPEED = 900; // units/second

/** Puck speed ceiling, applied after every impulse. Prevents CCD tunnelling blowups. */
export const PUCK_MAX_SPEED = 1800; // units/second

/**
 * Per-tick velocity retention. Air hockey is near-frictionless, so this is
 * close to 1. Multiplication only, so it is bit-deterministic.
 */
export const PUCK_FRICTION = 0.999;

/** Coefficient of restitution for puck/wall and puck/post bounces. */
export const WALL_RESTITUTION = 0.92;

/**
 * Coefficient of restitution for puck/paddle strikes. Above 1 would add energy.
 *
 * Note there is deliberately no separate "paddle velocity transfer" constant:
 * the impulse is solved in the paddle's reference frame and the paddle is
 * treated as infinite mass, so a driven shot already leaves at up to
 * `(1 + PADDLE_RESTITUTION)` times the paddle's own speed. Adding a second knob
 * on top would double-count it.
 */
export const PADDLE_RESTITUTION = 0.95;

// ---------------------------------------------------------------------------
// Solver
// ---------------------------------------------------------------------------

/** Maximum collision resolutions per puck advance before we give up for this tick. */
export const MAX_CCD_ITERATIONS = 8;

/** Positional slop pushed along the contact normal so a resolved pair does not re-collide. */
export const SEPARATION_EPSILON = 0.01;

/** Below this remaining time we consider the tick's motion fully consumed. */
export const TIME_EPSILON = 1e-9;

// ---------------------------------------------------------------------------
// Match rules
// ---------------------------------------------------------------------------

/**
 * Ticks the puck sits frozen at centre before play begins or resumes.
 *
 * Three seconds. Long enough to read the score that just changed and reposition
 * deliberately, rather than discovering play had restarted by conceding again.
 * Paddles still move during the freeze, so it is preparation time and not a
 * pause.
 */
export const FACEOFF_FREEZE_TICKS = TICK_RATE * 3;

// ---------------------------------------------------------------------------
// Puck authority (strategy C)
// ---------------------------------------------------------------------------

/**
 * How far past the centre line the puck must travel before authority changes hands.
 *
 * Without hysteresis a puck hovering on the line would flip ownership every few
 * ticks, and each flip switches the client between predicting the puck and
 * interpolating it — two sources that disagree by roughly a round trip of
 * travel. The result is a puck that visibly stutters in exactly the situation
 * where players are most focused on it.
 */
export const AUTHORITY_HYSTERESIS = 60;

/**
 * How close the *opposing* paddle must come before nobody owns the puck.
 *
 * Ownership is a claim that one player's input determines what happens next. As
 * soon as the other paddle is near enough to strike, that claim is false — so
 * authority lapses and both clients fall back to interpolating real data rather
 * than one of them confidently predicting a collision that has not been decided.
 *
 * Sized as paddle + puck radii plus a margin for the distance a paddle can
 * cover while an input is in flight.
 */
export const AUTHORITY_CONTEST_RADIUS = PADDLE_RADIUS + PUCK_RADIUS + 60;

export const PLAYER_COUNT = 2;

/** Slot 0 defends the left goal, slot 1 defends the right. */
export const SLOT_LEFT = 0;
export const SLOT_RIGHT = 1;
