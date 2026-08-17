import { describe, expect, it } from 'vitest';

import { FixedTimestepLoop } from '../src/loop.js';

const TICK_RATE = 60;

/**
 * Builds a loop driven by a virtual clock.
 *
 * `start()` is never called, so no real timer is involved and `pump()` can be
 * invoked deterministically. `lastNow` initialises to 0, matching the virtual
 * clock's origin.
 */
function makeLoop(maxCatchupTicks = 5) {
  let now = 0;
  let ticks = 0;
  const loop = new FixedTimestepLoop({
    tickRate: TICK_RATE,
    timerMs: 8,
    maxCatchupTicks,
    now: () => now,
    onTick: () => {
      ticks++;
    },
  });
  return {
    loop,
    advance: (ms: number) => {
      now += ms;
    },
    get ticks() {
      return ticks;
    },
  };
}

describe('FixedTimestepLoop', () => {
  it('produces exactly 60 ticks per simulated second at a steady 8ms cadence', () => {
    const h = makeLoop();
    for (let i = 0; i < 125; i++) {
      h.advance(8);
      h.loop.pump();
    }
    // 1000ms of virtual time must yield 60 ticks regardless of callback count.
    expect(h.ticks).toBe(60);
    expect(h.loop.getStats().callbacks).toBe(125);
  });

  /**
   * The behaviour the P0 spike found on the deployment target.
   *
   * Workers freeze `Date.now()` during synchronous execution, so roughly one
   * timer callback in five observes zero elapsed time. A loop that ticked once
   * per callback would run at the timer's rate rather than 60 Hz; a loop that
   * advanced by the raw delta would stall then lurch. The accumulator must make
   * the tick count depend only on elapsed time.
   */
  it('holds 60 Hz when the clock freezes on a fifth of callbacks', () => {
    const h = makeLoop();

    // 1 second of virtual time delivered unevenly: every fifth callback sees a
    // frozen clock and the following one absorbs the doubled span.
    for (let i = 0; i < 125; i++) {
      h.advance(i % 5 === 0 ? 0 : 10);
      h.loop.pump();
    }

    const stats = h.loop.getStats();
    expect(stats.frozenClockCallbacks).toBe(25);
    // 100 callbacks x 10ms = 1000ms of virtual time -> exactly 60 ticks.
    expect(h.ticks).toBe(60);
    expect(stats.catchupClamped).toBe(0);
  });

  it('never ticks while the clock is entirely frozen', () => {
    const h = makeLoop();
    for (let i = 0; i < 50; i++) {
      h.advance(0);
      h.loop.pump();
    }
    expect(h.ticks).toBe(0);
    expect(h.loop.getStats().frozenClockCallbacks).toBe(50);
  });

  it('caps catch-up work and discards the backlog after a long stall', () => {
    const h = makeLoop(5);

    // A two-second stall would be 120 ticks of debt.
    h.advance(2000);
    h.loop.pump();

    expect(h.ticks).toBe(5); // capped
    expect(h.loop.getStats().catchupClamped).toBe(1);
    expect(h.loop.getStats().ticksDropped).toBe(115);

    // Crucially, the discarded backlog must not linger: the next second of
    // normal operation runs at exactly 60 Hz rather than paying off old debt.
    const before = h.ticks;
    for (let i = 0; i < 125; i++) {
      h.advance(8);
      h.loop.pump();
    }
    expect(h.ticks - before).toBe(60);
  });

  it('ignores a clock that jumps backwards', () => {
    const h = makeLoop();

    h.advance(100);
    h.loop.pump();
    const after = h.ticks;
    expect(after).toBeGreaterThan(0);

    // NTP correction or similar. A naive accumulator would go negative here and
    // then stall until the clock caught back up.
    h.advance(-500);
    h.loop.pump();
    expect(h.ticks).toBe(after);

    h.advance(1000);
    h.loop.pump();
    expect(h.ticks).toBeGreaterThan(after);
  });

  it('reports the longest observed callback gap', () => {
    const h = makeLoop();
    h.advance(8);
    h.loop.pump();
    h.advance(140);
    h.loop.pump();
    h.advance(8);
    h.loop.pump();
    expect(h.loop.getStats().maxCallbackGapMs).toBe(140);
  });
});
