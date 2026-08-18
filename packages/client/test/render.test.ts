import { RINK_HEIGHT, RINK_WIDTH } from '@ah/sim';
import { describe, expect, it } from 'vitest';

import { computeView, screenToRink } from '../src/render.js';

/**
 * The orientation transform, pinned down.
 *
 * The table is drawn on its end, and for slot 1 through a further half turn, so
 * that both players see their own goal at the bottom. That makes the pointer
 * mapping the one piece of code where an inverted sign is not a cosmetic bug:
 * it would send the paddle the wrong way and the game would be unplayable, in a
 * way no other test would notice.
 */

/** Device-space rectangle the table occupies, recomputed the same way. */
function rect(view: ReturnType<typeof computeView>) {
  return {
    x: view.offsetX,
    y: view.offsetY,
    w: RINK_HEIGHT * view.scale,
    h: RINK_WIDTH * view.scale,
  };
}

const CANVAS_W = 800;
const CANVAS_H = 1200;

describe('view transform', () => {
  it('draws the table on its end', () => {
    const view = computeView(CANVAS_W, CANVAS_H);
    const r = rect(view);

    expect(view.portrait).toBe(true);
    // Taller than it is wide, which is the whole point.
    expect(r.h).toBeGreaterThan(r.w);
  });

  it('fits the table inside the canvas with a margin', () => {
    const view = computeView(CANVAS_W, CANVAS_H);
    const r = rect(view);

    expect(r.x).toBeGreaterThan(0);
    expect(r.y).toBeGreaterThan(0);
    expect(r.x + r.w).toBeLessThan(CANVAS_W);
    expect(r.y + r.h).toBeLessThan(CANVAS_H);
    // Centred.
    expect(r.x).toBeCloseTo(CANVAS_W - (r.x + r.w), 6);
    expect(r.y).toBeCloseTo(CANVAS_H - (r.y + r.h), 6);
  });

  it('puts slot 0 defending the bottom of the screen', () => {
    const view = computeView(CANVAS_W, CANVAS_H, false);
    const r = rect(view);

    // Bottom-centre of the drawn table is slot 0's goal mouth, at rink (0, H/2).
    const bottom = screenToRink(view, r.x + r.w / 2, r.y + r.h);
    expect(bottom.x).toBeCloseTo(0, 6);
    expect(bottom.y).toBeCloseTo(RINK_HEIGHT / 2, 6);

    // ...and the top is the goal they are shooting at.
    const top = screenToRink(view, r.x + r.w / 2, r.y);
    expect(top.x).toBeCloseTo(RINK_WIDTH, 6);
    expect(top.y).toBeCloseTo(RINK_HEIGHT / 2, 6);
  });

  it('puts slot 1 defending the bottom too, by turning the view around', () => {
    const view = computeView(CANVAS_W, CANVAS_H, true);
    const r = rect(view);

    // Slot 1's goal is at rink x = RINK_WIDTH, and it must also appear at the
    // bottom — otherwise one of the two players is defending upward.
    const bottom = screenToRink(view, r.x + r.w / 2, r.y + r.h);
    expect(bottom.x).toBeCloseTo(RINK_WIDTH, 6);
    expect(bottom.y).toBeCloseTo(RINK_HEIGHT / 2, 6);

    const top = screenToRink(view, r.x + r.w / 2, r.y);
    expect(top.x).toBeCloseTo(0, 6);
    expect(top.y).toBeCloseTo(RINK_HEIGHT / 2, 6);
  });

  it('maps every corner without mirroring the table', () => {
    for (const flip of [false, true]) {
      const view = computeView(CANVAS_W, CANVAS_H, flip);
      const r = rect(view);

      const corners = [
        screenToRink(view, r.x, r.y),
        screenToRink(view, r.x + r.w, r.y),
        screenToRink(view, r.x, r.y + r.h),
        screenToRink(view, r.x + r.w, r.y + r.h),
      ];

      // The four screen corners must be the four rink corners, in some order —
      // a sign error would fold two of them onto the same point.
      const seen = corners.map((c) => `${Math.round(c.x)},${Math.round(c.y)}`).sort();
      expect(seen).toEqual([`0,0`, `0,${RINK_HEIGHT}`, `${RINK_WIDTH},0`, `${RINK_WIDTH},${RINK_HEIGHT}`].sort());
    }
  });

  it('moves the paddle the same way the pointer moves', () => {
    // Slot 0: dragging the pointer right must increase rink y, and dragging it
    // up (toward the opponent) must increase rink x. Slot 1 sees both reversed,
    // which is exactly what "turned around" means.
    const near = computeView(CANVAS_W, CANVAS_H, false);
    const r = rect(near);
    const mid = { x: r.x + r.w / 2, y: r.y + r.h / 2 };

    const centre = screenToRink(near, mid.x, mid.y);
    expect(screenToRink(near, mid.x + 40, mid.y).y).toBeGreaterThan(centre.y);
    expect(screenToRink(near, mid.x, mid.y - 40).x).toBeGreaterThan(centre.x);

    const far = computeView(CANVAS_W, CANVAS_H, true);
    const farCentre = screenToRink(far, mid.x, mid.y);
    expect(screenToRink(far, mid.x + 40, mid.y).y).toBeLessThan(farCentre.y);
    expect(screenToRink(far, mid.x, mid.y - 40).x).toBeLessThan(farCentre.x);
  });
});
