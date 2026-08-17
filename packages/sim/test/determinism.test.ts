import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { hashState, hashStateHex } from '../src/hash.js';
import { createInitialState, statesEqual } from '../src/state.js';
import { step } from '../src/step.js';
import { buildInputScript, stateWithPuckVelocity } from './helpers.js';

/**
 * Determinism is the load-bearing property of this whole project.
 *
 * Client-side prediction works by replaying the player's unacknowledged inputs
 * on top of an authoritative snapshot. That is only sound if replaying the same
 * inputs from the same state yields *bit-identical* results — not merely
 * similar ones. A one-ULP divergence compounds through the collision solver and
 * surfaces as drift that is nearly impossible to attribute after the fact.
 *
 * These tests pin the property down directly instead of waiting to discover its
 * absence through mysterious rubber-banding.
 */

const SRC_DIR = fileURLToPath(new URL('../src', import.meta.url));

/**
 * The next representable double above `x`, for positive finite `x`.
 *
 * JavaScript has no `Math.nextAfter`, so this walks the IEEE-754 bit pattern
 * directly — incrementing the integer interpretation of a positive float yields
 * exactly the next float.
 */
function nextUp(x: number): number {
  const buf = new ArrayBuffer(8);
  const floats = new Float64Array(buf);
  const bits = new BigUint64Array(buf);
  floats[0] = x;
  bits[0] = bits[0]! + 1n;
  return floats[0]!;
}

describe('simulation determinism', () => {
  it('produces identical state hashes for identical input sequences', () => {
    const script = buildInputScript(0xc0ffee, 2000);

    let a = stateWithPuckVelocity(430, -260);
    let b = stateWithPuckVelocity(430, -260);

    for (let i = 0; i < script.length; i++) {
      a = step(a, script[i]!);
      b = step(b, script[i]!);
    }

    expect(hashStateHex(a)).toBe(hashStateHex(b));
    expect(statesEqual(a, b)).toBe(true);
  });

  it('is stable across many independent seeds', () => {
    for (let seed = 1; seed <= 25; seed++) {
      const script = buildInputScript(seed, 400);

      let a = stateWithPuckVelocity(seed * 7, seed * -11);
      let b = stateWithPuckVelocity(seed * 7, seed * -11);

      for (let i = 0; i < script.length; i++) {
        a = step(a, script[i]!);
        b = step(b, script[i]!);
      }

      expect(hashState(a), `seed ${seed} diverged`).toBe(hashState(b));
    }
  });

  it('does not mutate the state passed to step', () => {
    const script = buildInputScript(99, 200);
    const original = stateWithPuckVelocity(500, 310);

    let current = original;
    for (let i = 0; i < script.length; i++) {
      const before = hashState(current);
      const nextState = step(current, script[i]!);
      // The state we handed in must be untouched by the call.
      expect(hashState(current)).toBe(before);
      expect(nextState).not.toBe(current);
      current = nextState;
    }
  });

  /**
   * The rollback property, stated directly.
   *
   * This is precisely what server reconciliation does every time a snapshot
   * arrives: discard the predicted state, adopt the authoritative one, and
   * replay the inputs the server had not yet consumed. If this test fails,
   * reconciliation cannot converge no matter how the netcode is written.
   */
  it('replaying from a mid-run snapshot reproduces the original outcome', () => {
    const TICKS = 1200;
    const SNAPSHOT_AT = 500;
    const script = buildInputScript(0xbeef, TICKS);

    let live = stateWithPuckVelocity(620, -410);
    let snapshot = live;

    for (let i = 0; i < TICKS; i++) {
      if (i === SNAPSHOT_AT) snapshot = live;
      live = step(live, script[i]!);
    }

    // Replay only the tail, starting from the retained snapshot.
    let replayed = snapshot;
    for (let i = SNAPSHOT_AT; i < TICKS; i++) {
      replayed = step(replayed, script[i]!);
    }

    expect(hashStateHex(replayed)).toBe(hashStateHex(live));
    expect(statesEqual(replayed, live)).toBe(true);
  });

  it('replays identically from every snapshot point in a run', () => {
    const TICKS = 300;
    const script = buildInputScript(0x5eed, TICKS);

    const timeline = [stateWithPuckVelocity(700, 240)];
    for (let i = 0; i < TICKS; i++) {
      timeline.push(step(timeline[i]!, script[i]!));
    }
    const finalHash = hashState(timeline[TICKS]!);

    // Every intermediate state must be a valid resume point.
    for (let start = 0; start < TICKS; start += 7) {
      let replayed = timeline[start]!;
      for (let i = start; i < TICKS; i++) {
        replayed = step(replayed, script[i]!);
      }
      expect(hashState(replayed), `resume from tick ${start} diverged`).toBe(finalHash);
    }
  });

  it('hashes distinguish states that differ by a single ULP', () => {
    const a = createInitialState();
    const b = createInitialState();
    b.puck.x = nextUp(b.puck.x);

    // The smallest perturbation the format can represent — far below any
    // tolerance a positional comparison would use, yet enough to send the
    // collision solver down a different branch a few hundred ticks later.
    expect(b.puck.x).not.toBe(a.puck.x);
    expect(Math.abs(b.puck.x - a.puck.x)).toBeLessThan(1e-12);
    expect(hashState(a)).not.toBe(hashState(b));
  });
});

/**
 * Strip line and block comments so the source scan below inspects executable
 * code only. Without this, the explanatory prose in `math.ts` — which names the
 * very functions being banned — would trip the check.
 */
function stripComments(source: string): string {
  let out = '';
  let i = 0;
  let inLine = false;
  let inBlock = false;
  let inString: string | null = null;

  while (i < source.length) {
    const ch = source[i]!;
    const next = source[i + 1];

    if (inLine) {
      if (ch === '\n') {
        inLine = false;
        out += ch;
      }
      i++;
    } else if (inBlock) {
      if (ch === '*' && next === '/') {
        inBlock = false;
        i += 2;
      } else {
        i++;
      }
    } else if (inString !== null) {
      if (ch === '\\') {
        i += 2;
      } else {
        if (ch === inString) inString = null;
        out += ch;
        i++;
      }
    } else if (ch === '/' && next === '/') {
      inLine = true;
      i += 2;
    } else if (ch === '/' && next === '*') {
      inBlock = true;
      i += 2;
    } else if (ch === '"' || ch === "'" || ch === '`') {
      inString = ch;
      out += ch;
      i++;
    } else {
      out += ch;
      i++;
    }
  }

  return out;
}

describe('determinism guardrails', () => {
  /**
   * ECMAScript requires `+ - * /` and `Math.sqrt` to be correctly rounded, so
   * they are bit-identical on every conformant engine. The transcendental
   * family carries no such guarantee and genuinely differs between V8,
   * JavaScriptCore, and SpiderMonkey — as does `Math.hypot`, which is the
   * dangerous one because it looks like exactly the right tool for computing a
   * vector length.
   *
   * The simulation is written to need none of them. This test keeps it that way.
   */
  const BANNED = [
    'sin', 'cos', 'tan',
    'asin', 'acos', 'atan', 'atan2',
    'sinh', 'cosh', 'tanh', 'asinh', 'acosh', 'atanh',
    'pow', 'exp', 'expm1',
    'log', 'log1p', 'log2', 'log10',
    'hypot', 'cbrt',
    'random',
  ];

  const sources = readdirSync(SRC_DIR)
    .filter((f) => f.endsWith('.ts'))
    .map((f) => ({ name: f, code: stripComments(readFileSync(join(SRC_DIR, f), 'utf8')) }));

  it('finds simulation sources to scan', () => {
    expect(sources.length).toBeGreaterThan(0);
  });

  it.each(BANNED)('never calls Math.%s in simulation code', (fn) => {
    const pattern = new RegExp(`Math\\s*\\.\\s*${fn}\\b`);
    const offenders = sources.filter((s) => pattern.test(s.code)).map((s) => s.name);
    expect(offenders, `Math.${fn} is not correctly rounded across engines`).toEqual([]);
  });

  it('never uses the exponentiation operator', () => {
    // `**` shares Math.pow's semantics and its lack of a rounding guarantee.
    const offenders = sources.filter((s) => /[^*]\*\*[^*]/.test(s.code)).map((s) => s.name);
    expect(offenders).toEqual([]);
  });

  it('never reads a wall clock inside the simulation', () => {
    const pattern = /\bDate\s*\.\s*now\b|\bperformance\s*\.\s*now\b|new\s+Date\b/;
    const offenders = sources.filter((s) => pattern.test(s.code)).map((s) => s.name);
    expect(offenders, 'simulation time must come from the tick counter alone').toEqual([]);
  });
});
