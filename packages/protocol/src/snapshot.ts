import { cloneState, createInitialState, type GameState } from '@ah/sim';

import type { WireSnapshot } from './messages.js';

/**
 * Project authoritative state onto the wire.
 *
 * Presentation-only fields (`lastGoalBy`, `lastGoalTick`) are omitted: they
 * cannot influence future simulation, and the client derives its goal flash
 * from watching the score change instead. Everything that *does* influence
 * future state is carried, because reconciliation requires the client to be
 * able to reconstruct the server's exact starting point.
 */
export function snapshotFromState(state: GameState, acks: number[]): WireSnapshot {
  const pads: Array<[number, number, number, number]> = [];
  const tgts: Array<[number, number]> = [];

  for (let slot = 0; slot < state.paddles.length; slot++) {
    const p = state.paddles[slot]!;
    pads.push([p.x, p.y, p.vx, p.vy]);
    tgts.push([p.targetX, p.targetY]);
  }

  return {
    t: 'snap',
    tick: state.tick,
    puck: [state.puck.x, state.puck.y, state.puck.vx, state.puck.vy],
    pads,
    tgts,
    score: state.score.slice(),
    frz: state.freezeTicks,
    touch: state.lastTouchedBy,
    touchTick: state.lastTouchTick,
    own: state.puckOwner,
    ownEp: state.puckOwnerEpoch,
    acks: acks.slice(),
    // Filled by the room, which owns the buffers. Defaulted so any other caller
    // still produces a wire-valid snapshot.
    depth: acks.map(() => 0),
  };
}

/**
 * Rebuild simulation state from a snapshot.
 *
 * The result is a valid input to `step()`, which is what makes it a legitimate
 * rollback point: the client adopts this wholesale and replays its own
 * unacknowledged inputs on top.
 *
 * Every field that participates in the state hash is restored here. Anything
 * omitted would leave a reconciled client provably out of step with the server
 * that sent the snapshot, even when the simulation itself is flawless.
 */
export function stateFromSnapshot(snap: WireSnapshot, template?: GameState): GameState {
  const state = template ? cloneState(template) : createInitialState();

  state.tick = snap.tick;
  state.puck.x = snap.puck[0];
  state.puck.y = snap.puck[1];
  state.puck.vx = snap.puck[2];
  state.puck.vy = snap.puck[3];

  for (let slot = 0; slot < state.paddles.length; slot++) {
    const wire = snap.pads[slot];
    const target = snap.tgts[slot];
    if (!wire || !target) continue;
    const paddle = state.paddles[slot]!;
    paddle.x = wire[0];
    paddle.y = wire[1];
    paddle.vx = wire[2];
    paddle.vy = wire[3];
    paddle.targetX = target[0];
    paddle.targetY = target[1];
  }

  for (let slot = 0; slot < state.score.length; slot++) {
    state.score[slot] = snap.score[slot] ?? 0;
  }

  state.freezeTicks = snap.frz;
  state.lastTouchedBy = snap.touch;
  state.lastTouchTick = snap.touchTick;
  state.puckOwner = snap.own;
  state.puckOwnerEpoch = snap.ownEp;

  return state;
}
