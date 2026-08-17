import { PLAYER_COUNT } from '@ah/sim';

import type { Codec } from './codec.js';
import type { ClientMessage, ServerMessage, WireInput, WireSnapshot } from './messages.js';
import {
  dequantizePosition,
  dequantizeVelocity,
  quantizePosition,
  quantizeVelocity,
} from './quantize.js';
import type { WireData } from './transport.js';

/**
 * Bit-packed binary wire format.
 *
 * ## Where the savings come from
 *
 * Three separate things, in increasing order of payoff:
 *
 *  1. **No field names.** JSON spends more bytes on `"puck":[` than on the
 *     numbers inside it.
 *  2. **Quantisation.** A position becomes 2 bytes instead of up to 18
 *     characters. See `quantize.ts` for what that costs.
 *  3. **Delta encoding.** Most of a snapshot does not change between ticks —
 *     score, freeze, ownership, the acks — so a bitmask names the handful of
 *     groups that did and the rest is simply absent.
 *
 * ## Why delta encoding is safe here
 *
 * Deltas are relative to the previous snapshot *sent*, so a client that missed
 * one cannot decode the next. That normally demands keyframe machinery and a
 * recovery protocol. It does not here, because the transport is WebSocket: TCP
 * delivers reliably and in order, so no snapshot is ever missing.
 *
 * This is a real dividend from the transport choice, and worth naming next to
 * its cost — the same reliability that produces head-of-line blocking is what
 * makes delta encoding a bitmask instead of a subsystem. Keyframes are still
 * emitted periodically and whenever a client joins, so a peer arriving
 * mid-stream has a baseline.
 */

const MSG_SNAPSHOT = 1;
const MSG_WELCOME = 2;
const MSG_PONG = 3;
const MSG_FULL = 4;
const MSG_INPUT = 5;
const MSG_PING = 6;

const FLAG_KEYFRAME = 1;

// Delta groups. A bit per group of fields that tend to change together.
const G_PUCK = 1 << 0;
const G_PADDLE0 = 1 << 1;
const G_PADDLE1 = 1 << 2;
const G_SCORE = 1 << 3;
const G_FREEZE = 1 << 4;
const G_TOUCH = 1 << 5;
const G_OWNER = 1 << 6;
const G_ACKS = 1 << 7;
const G_DEPTH = 1 << 8;

/** Keyframe cadence, in snapshots. One per second at 20 Hz. */
const KEYFRAME_INTERVAL = 20;

/** Generous upper bound for one snapshot; the writer never approaches it. */
const SCRATCH_BYTES = 512;

class Writer {
  private readonly view: DataView;
  private offset = 0;

  constructor(private readonly buffer: ArrayBuffer) {
    this.view = new DataView(buffer);
  }

  u8(v: number): void {
    this.view.setUint8(this.offset, v & 0xff);
    this.offset += 1;
  }
  i8(v: number): void {
    this.view.setInt8(this.offset, v);
    this.offset += 1;
  }
  u16(v: number): void {
    this.view.setUint16(this.offset, v, true);
    this.offset += 2;
  }
  i16(v: number): void {
    this.view.setInt16(this.offset, v, true);
    this.offset += 2;
  }
  u32(v: number): void {
    this.view.setUint32(this.offset, v >>> 0, true);
    this.offset += 4;
  }
  i32(v: number): void {
    this.view.setInt32(this.offset, v | 0, true);
    this.offset += 4;
  }
  f64(v: number): void {
    this.view.setFloat64(this.offset, v, true);
    this.offset += 8;
  }

  finish(): ArrayBuffer {
    return this.buffer.slice(0, this.offset);
  }
}

class Reader {
  private readonly view: DataView;
  private offset = 0;

  constructor(buffer: ArrayBuffer) {
    this.view = new DataView(buffer);
  }

  get remaining(): number {
    return this.view.byteLength - this.offset;
  }

  u8(): number {
    const v = this.view.getUint8(this.offset);
    this.offset += 1;
    return v;
  }
  i8(): number {
    const v = this.view.getInt8(this.offset);
    this.offset += 1;
    return v;
  }
  u16(): number {
    const v = this.view.getUint16(this.offset, true);
    this.offset += 2;
    return v;
  }
  i16(): number {
    const v = this.view.getInt16(this.offset, true);
    this.offset += 2;
    return v;
  }
  u32(): number {
    const v = this.view.getUint32(this.offset, true);
    this.offset += 4;
    return v;
  }
  i32(): number {
    const v = this.view.getInt32(this.offset, true);
    this.offset += 4;
    return v;
  }
  f64(): number {
    const v = this.view.getFloat64(this.offset, true);
    this.offset += 8;
    return v;
  }
}

function quad(q: readonly number[]): [number, number, number, number] {
  return [q[0]!, q[1]!, q[2]!, q[3]!];
}

function cloneSnapshot(s: WireSnapshot): WireSnapshot {
  return {
    t: 'snap',
    tick: s.tick,
    puck: quad(s.puck),
    pads: s.pads.map(quad),
    tgts: s.tgts.map((p) => [p[0], p[1]] as [number, number]),
    score: s.score.slice(),
    frz: s.frz,
    touch: s.touch,
    touchTick: s.touchTick,
    own: s.own,
    ownEp: s.ownEp,
    acks: s.acks.slice(),
    depth: s.depth.slice(),
  };
}

/** Compare after quantisation: only differences the wire can express matter. */
function bodyDiffers(a: readonly number[], b: readonly number[], velocity: boolean): boolean {
  for (let i = 0; i < a.length; i++) {
    const q = i >= 2 && velocity ? quantizeVelocity : quantizePosition;
    if (q(a[i]!) !== q(b[i]!)) return true;
  }
  return false;
}

/**
 * Create a stateful binary codec.
 *
 * Stateful because delta encoding needs a baseline. Each side keeps its own
 * instance: the server one per room (all clients share a snapshot stream, so
 * they share a baseline), the client one per connection.
 */
export function createBinaryCodec(): Codec & { forceKeyframe(): void } {
  const scratch = new ArrayBuffer(SCRATCH_BYTES);

  /** Server side: last snapshot encoded. */
  let encodeBaseline: WireSnapshot | null = null;
  let sinceKeyframe = 0;
  let pendingKeyframe = true;

  /** Client side: last snapshot decoded. */
  let decodeBaseline: WireSnapshot | null = null;

  function writeSnapshot(w: Writer, snap: WireSnapshot): void {
    const keyframe = pendingKeyframe || encodeBaseline === null || sinceKeyframe >= KEYFRAME_INTERVAL;

    w.u8(MSG_SNAPSHOT);
    w.u8(keyframe ? FLAG_KEYFRAME : 0);
    w.u32(snap.tick);

    const base = keyframe ? null : encodeBaseline;

    let mask = 0;
    if (!base || bodyDiffers(snap.puck, base.puck, true)) mask |= G_PUCK;
    for (let slot = 0; slot < PLAYER_COUNT; slot++) {
      const bit = slot === 0 ? G_PADDLE0 : G_PADDLE1;
      const changed =
        !base ||
        bodyDiffers(snap.pads[slot]!, base.pads[slot]!, true) ||
        bodyDiffers(snap.tgts[slot]!, base.tgts[slot]!, false);
      if (changed) mask |= bit;
    }
    if (!base || snap.score.some((v, i) => v !== base.score[i])) mask |= G_SCORE;
    if (!base || snap.frz !== base.frz) mask |= G_FREEZE;
    if (!base || snap.touch !== base.touch || snap.touchTick !== base.touchTick) mask |= G_TOUCH;
    if (!base || snap.own !== base.own || snap.ownEp !== base.ownEp) mask |= G_OWNER;
    if (!base || snap.acks.some((v, i) => v !== base.acks[i])) mask |= G_ACKS;
    if (!base || snap.depth.some((v, i) => v !== base.depth[i])) mask |= G_DEPTH;

    w.u16(mask);

    if (mask & G_PUCK) {
      w.u16(quantizePosition(snap.puck[0]));
      w.u16(quantizePosition(snap.puck[1]));
      w.i16(quantizeVelocity(snap.puck[2]));
      w.i16(quantizeVelocity(snap.puck[3]));
    }
    for (let slot = 0; slot < PLAYER_COUNT; slot++) {
      if (!(mask & (slot === 0 ? G_PADDLE0 : G_PADDLE1))) continue;
      const p = snap.pads[slot]!;
      const t = snap.tgts[slot]!;
      w.u16(quantizePosition(p[0]));
      w.u16(quantizePosition(p[1]));
      w.i16(quantizeVelocity(p[2]));
      w.i16(quantizeVelocity(p[3]));
      w.u16(quantizePosition(t[0]));
      w.u16(quantizePosition(t[1]));
    }
    if (mask & G_SCORE) for (let i = 0; i < PLAYER_COUNT; i++) w.u8(snap.score[i] ?? 0);
    if (mask & G_FREEZE) w.u8(snap.frz);
    if (mask & G_TOUCH) {
      w.i8(snap.touch);
      w.i32(snap.touchTick);
    }
    if (mask & G_OWNER) {
      w.i8(snap.own);
      w.u32(snap.ownEp);
    }
    if (mask & G_ACKS) for (let i = 0; i < PLAYER_COUNT; i++) w.i32(snap.acks[i] ?? -1);
    if (mask & G_DEPTH) for (let i = 0; i < PLAYER_COUNT; i++) w.u8(snap.depth[i] ?? 0);

    encodeBaseline = cloneSnapshot(snap);
    sinceKeyframe = keyframe ? 1 : sinceKeyframe + 1;
    pendingKeyframe = false;
  }

  function readSnapshot(r: Reader): WireSnapshot | null {
    const flags = r.u8();
    const tick = r.u32();
    const keyframe = (flags & FLAG_KEYFRAME) !== 0;

    if (!keyframe && decodeBaseline === null) {
      // Arrived mid-stream with no baseline. Not an error: a keyframe follows
      // within a second, and the client simply has nothing to show until then.
      return null;
    }

    const snap: WireSnapshot = keyframe
      ? {
          t: 'snap',
          tick,
          puck: [0, 0, 0, 0],
          pads: Array.from({ length: PLAYER_COUNT }, () => [0, 0, 0, 0] as [number, number, number, number]),
          tgts: Array.from({ length: PLAYER_COUNT }, () => [0, 0] as [number, number]),
          score: new Array<number>(PLAYER_COUNT).fill(0),
          frz: 0,
          touch: -1,
          touchTick: -1,
          own: -1,
          ownEp: 0,
          acks: new Array<number>(PLAYER_COUNT).fill(-1),
          depth: new Array<number>(PLAYER_COUNT).fill(0),
        }
      : { ...cloneSnapshot(decodeBaseline!), tick };

    const mask = r.u16();

    if (mask & G_PUCK) {
      snap.puck = [
        dequantizePosition(r.u16()),
        dequantizePosition(r.u16()),
        dequantizeVelocity(r.i16()),
        dequantizeVelocity(r.i16()),
      ];
    }
    for (let slot = 0; slot < PLAYER_COUNT; slot++) {
      if (!(mask & (slot === 0 ? G_PADDLE0 : G_PADDLE1))) continue;
      snap.pads[slot] = [
        dequantizePosition(r.u16()),
        dequantizePosition(r.u16()),
        dequantizeVelocity(r.i16()),
        dequantizeVelocity(r.i16()),
      ];
      snap.tgts[slot] = [dequantizePosition(r.u16()), dequantizePosition(r.u16())];
    }
    if (mask & G_SCORE) for (let i = 0; i < PLAYER_COUNT; i++) snap.score[i] = r.u8();
    if (mask & G_FREEZE) snap.frz = r.u8();
    if (mask & G_TOUCH) {
      snap.touch = r.i8();
      snap.touchTick = r.i32();
    }
    if (mask & G_OWNER) {
      snap.own = r.i8();
      snap.ownEp = r.u32();
    }
    if (mask & G_ACKS) for (let i = 0; i < PLAYER_COUNT; i++) snap.acks[i] = r.i32();
    if (mask & G_DEPTH) for (let i = 0; i < PLAYER_COUNT; i++) snap.depth[i] = r.u8();

    decodeBaseline = cloneSnapshot(snap);
    return snap;
  }

  return {
    name: 'binary',

    /** Forces the next snapshot to be self-contained, for a peer joining mid-stream. */
    forceKeyframe(): void {
      pendingKeyframe = true;
    },

    encodeServer(msg: ServerMessage): WireData {
      const w = new Writer(scratch);
      switch (msg.t) {
        case 'snap':
          writeSnapshot(w, msg);
          return w.finish();
        case 'welcome':
          w.u8(MSG_WELCOME);
          w.u8(msg.slot);
          w.u32(msg.tick);
          w.u16(msg.tickRate);
          return w.finish();
        case 'pong':
          w.u8(MSG_PONG);
          w.u32(msg.id);
          // Full precision: this feeds the RTT estimate, not the simulation.
          w.f64(msg.sent);
          w.i32(msg.serverTick);
          return w.finish();
        case 'full':
          w.u8(MSG_FULL);
          return w.finish();
      }
    },

    decodeServer(data: WireData): ServerMessage | null {
      if (typeof data === 'string') return null;
      try {
        const r = new Reader(data);
        switch (r.u8()) {
          case MSG_SNAPSHOT:
            return readSnapshot(r);
          case MSG_WELCOME:
            return { t: 'welcome', slot: r.u8(), tick: r.u32(), tickRate: r.u16() };
          case MSG_PONG:
            return { t: 'pong', id: r.u32(), sent: r.f64(), serverTick: r.i32() };
          case MSG_FULL:
            return { t: 'full' };
          default:
            return null;
        }
      } catch {
        // A truncated or malformed frame must not take the connection down.
        return null;
      }
    },

    encodeClient(msg: ClientMessage): WireData {
      const w = new Writer(scratch);
      if (msg.t === 'in') {
        w.u8(MSG_INPUT);
        w.u8(msg.inputs.length);
        const first = msg.inputs[0]!;
        w.u32(first.seq);
        for (const input of msg.inputs) {
          // Ticks in a batch are consecutive, so only the offset is carried.
          w.u8(input.seq - first.seq);
          w.u16(quantizePosition(input.x));
          w.u16(quantizePosition(input.y));
        }
        return w.finish();
      }
      w.u8(MSG_PING);
      w.u32(msg.id);
      w.f64(msg.sent);
      return w.finish();
    },

    decodeClient(data: WireData): ClientMessage | null {
      if (typeof data === 'string') return null;
      try {
        const r = new Reader(data);
        const type = r.u8();
        if (type === MSG_INPUT) {
          const count = r.u8();
          if (count === 0 || count > 8) return null;
          const first = r.u32();
          const inputs: WireInput[] = [];
          for (let i = 0; i < count; i++) {
            const seq = first + r.u8();
            inputs.push({
              seq,
              x: dequantizePosition(r.u16()),
              y: dequantizePosition(r.u16()),
            });
          }
          // Trailing bytes mean the frame was not what it claimed to be.
          return r.remaining === 0 ? { t: 'in', inputs } : null;
        }
        if (type === MSG_PING) {
          return { t: 'ping', id: r.u32(), sent: r.f64() };
        }
        return null;
      } catch {
        return null;
      }
    },
  };
}
