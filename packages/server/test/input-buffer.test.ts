import { describe, expect, it } from 'vitest';

import { InputBuffer } from '../src/input-buffer.js';

/** `seq` is the tick the client simulated this input at. */
function inputFor(tick: number, x = 0, y = 0) {
  return { seq: tick, targetX: x, targetY: y };
}

const WINDOW = 15;

describe('InputBuffer', () => {
  it('applies each input at the tick it was stamped for', () => {
    const buf = new InputBuffer();
    buf.push(inputFor(10, 111), 5, WINDOW);
    buf.push(inputFor(11, 222), 5, WINDOW);

    // Ticks before the stamped one get nothing; the paddle holds its target.
    expect(buf.take(9)).toBeNull();
    expect(buf.take(10)?.targetX).toBe(111);
    expect(buf.take(11)?.targetX).toBe(222);
    expect(buf.take(12)).toBeNull();
  });

  it('does not care about arrival order', () => {
    const buf = new InputBuffer();
    buf.push(inputFor(12), 5, WINDOW);
    buf.push(inputFor(10), 5, WINDOW);
    buf.push(inputFor(11), 5, WINDOW);

    expect(buf.take(10)?.seq).toBe(10);
    expect(buf.take(11)?.seq).toBe(11);
    expect(buf.take(12)?.seq).toBe(12);
  });

  /**
   * Redundant transmission means duplicates are the normal case, not an error:
   * every packet deliberately repeats the previous few ticks.
   */
  it('recognises duplicates from redundant packets', () => {
    const buf = new InputBuffer();
    expect(buf.push(inputFor(10, 5), 5, WINDOW)).toBe('buffered');
    expect(buf.push(inputFor(10, 999), 5, WINDOW)).toBe('duplicate');
    expect(buf.size).toBe(1);
    expect(buf.take(10)?.targetX).toBe(5);
  });

  /**
   * The distinction lag compensation is built on. An input for a tick already
   * simulated is not simply garbage — if it is recent enough, the server can
   * rewind and honour it.
   */
  it('reports a recoverable straggler as late, not rejected', () => {
    const buf = new InputBuffer();
    buf.take(20); // server has simulated up to tick 20

    expect(buf.push(inputFor(18), 20, WINDOW)).toBe('late');
  });

  it('rejects a straggler older than the rewind window', () => {
    const buf = new InputBuffer();
    buf.take(60);

    // 60 - 15 = 45, so tick 40 is beyond recovery.
    expect(buf.push(inputFor(40), 60, WINDOW)).toBe('rejected');
  });

  it('treats every straggler as unrecoverable when rewind is disabled', () => {
    const buf = new InputBuffer();
    buf.take(20);
    expect(buf.push(inputFor(19), 20, 0)).toBe('rejected');
  });

  it('drops buffered inputs that the simulation has passed', () => {
    const buf = new InputBuffer();
    buf.push(inputFor(10), 5, WINDOW);
    buf.push(inputFor(14), 5, WINDOW);

    // Jumping to 14 makes tick 10's input unusable; it must not linger.
    expect(buf.take(14)?.seq).toBe(14);
    expect(buf.size).toBe(0);
  });

  it('acks the highest tick it has simulated', () => {
    const buf = new InputBuffer();
    expect(buf.ack).toBe(-1);

    buf.push(inputFor(7), 0, WINDOW);
    buf.take(7);
    expect(buf.ack).toBe(7);

    // Ticks with no input still advance the ack: the server did simulate them.
    buf.take(8);
    expect(buf.ack).toBe(8);
  });

  /**
   * The signal the client steers on. Depth near zero means its inputs are
   * arriving at or after their deadline and it should run further ahead.
   */
  it('reports how many inputs are queued beyond the current tick', () => {
    const buf = new InputBuffer();
    for (const tick of [11, 12, 13]) buf.push(inputFor(tick), 10, WINDOW);

    expect(buf.depthAbove(10)).toBe(3);
    expect(buf.depthAbove(12)).toBe(1);
    expect(buf.depthAbove(13)).toBe(0);
  });

  it('bounds memory against a flooding client', () => {
    const buf = new InputBuffer();
    let rejected = 0;
    for (let tick = 0; tick < 1000; tick++) {
      if (buf.push(inputFor(tick), 0, WINDOW) === 'rejected') rejected++;
    }

    expect(buf.size).toBeLessThanOrEqual(64);
    expect(rejected).toBeGreaterThan(0);
  });

  it('lets a rewind replay read an input without consuming it', () => {
    const buf = new InputBuffer();
    buf.push(inputFor(10, 42), 5, WINDOW);

    expect(buf.peek(10)?.targetX).toBe(42);
    expect(buf.peek(10)?.targetX).toBe(42);
    expect(buf.size).toBe(1);
  });

  it('clears state on reset so a slot can be reused', () => {
    const buf = new InputBuffer();
    buf.push(inputFor(7), 0, WINDOW);
    buf.take(7);
    expect(buf.ack).toBe(7);

    buf.reset();
    expect(buf.ack).toBe(-1);
    expect(buf.size).toBe(0);
    // A new occupant's early ticks must not look like stragglers.
    expect(buf.push(inputFor(1), 0, WINDOW)).toBe('buffered');
  });
});
