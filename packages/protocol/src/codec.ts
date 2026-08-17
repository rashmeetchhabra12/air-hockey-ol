import type { ClientMessage, ServerMessage, WireInput, WireSnapshot } from './messages.js';
import { isFiniteNumber, isSafeInt } from './messages.js';
import type { WireData } from './transport.js';

/**
 * Encoding is swappable so P7 can introduce a bit-packed binary codec behind the
 * same interface and the harness can measure both without touching netcode.
 */
export interface Codec {
  readonly name: string;
  encodeClient(msg: ClientMessage): WireData;
  encodeServer(msg: ServerMessage): WireData;
  /** Returns `null` for anything malformed. Callers must treat that as a hostile peer. */
  decodeClient(data: WireData): ClientMessage | null;
  decodeServer(data: WireData): ServerMessage | null;
}

/** Largest input batch accepted, matching the client's redundancy window with slack. */
const MAX_INPUT_BATCH = 8;

/** Sequence numbers are tick counters; this bounds them well beyond any real session. */
const MAX_SEQ = 2 ** 31;

/**
 * Rink coordinates are bounded, so anything wildly outside is malformed rather
 * than merely out of bounds. The simulation clamps legal-but-outside targets
 * itself; this only rejects values that indicate a broken or hostile client.
 */
const COORD_LIMIT = 1e6;

function isValidInput(v: unknown): v is WireInput {
  if (typeof v !== 'object' || v === null) return false;
  const o = v as Record<string, unknown>;
  return (
    isSafeInt(o['seq'], 0, MAX_SEQ) &&
    isFiniteNumber(o['x']) &&
    isFiniteNumber(o['y']) &&
    Math.abs(o['x']) <= COORD_LIMIT &&
    Math.abs(o['y']) <= COORD_LIMIT
  );
}

function parse(data: WireData): unknown {
  if (typeof data !== 'string') return null;
  try {
    return JSON.parse(data);
  } catch {
    return null;
  }
}

function isQuad(v: unknown): v is [number, number, number, number] {
  return Array.isArray(v) && v.length === 4 && v.every(isFiniteNumber);
}

function isPair(v: unknown): v is [number, number] {
  return Array.isArray(v) && v.length === 2 && v.every(isFiniteNumber);
}

function decodeSnapshot(o: Record<string, unknown>): WireSnapshot | null {
  if (!isSafeInt(o['tick'], 0, MAX_SEQ)) return null;
  if (!isQuad(o['puck'])) return null;
  if (!Array.isArray(o['pads']) || !o['pads'].every(isQuad)) return null;
  if (!Array.isArray(o['tgts']) || !o['tgts'].every(isPair)) return null;
  if (o['tgts'].length !== o['pads'].length) return null;
  if (!Array.isArray(o['score']) || !o['score'].every(isFiniteNumber)) return null;
  if (!isFiniteNumber(o['frz'])) return null;
  if (!isFiniteNumber(o['touch'])) return null;
  if (!isFiniteNumber(o['touchTick'])) return null;
  if (!isFiniteNumber(o['own'])) return null;
  if (!isFiniteNumber(o['ownEp'])) return null;
  if (!Array.isArray(o['acks']) || !o['acks'].every(isFiniteNumber)) return null;
  if (!Array.isArray(o['depth']) || !o['depth'].every(isFiniteNumber)) return null;

  return {
    t: 'snap',
    tick: o['tick'],
    puck: o['puck'],
    pads: o['pads'] as Array<[number, number, number, number]>,
    tgts: o['tgts'] as Array<[number, number]>,
    score: o['score'] as number[],
    frz: o['frz'],
    touch: o['touch'],
    touchTick: o['touchTick'],
    own: o['own'],
    ownEp: o['ownEp'],
    acks: o['acks'] as number[],
    depth: o['depth'] as number[],
  };
}

/**
 * JSON codec — the P1 baseline.
 *
 * Deliberately the straightforward implementation. Its measured bandwidth is
 * the number P7's binary codec is compared against, and that comparison is only
 * meaningful if this side of it is honest.
 */
export const jsonCodec: Codec = {
  name: 'json',

  encodeClient(msg) {
    return JSON.stringify(msg);
  },

  encodeServer(msg) {
    return JSON.stringify(msg);
  },

  decodeClient(data) {
    const raw = parse(data);
    if (typeof raw !== 'object' || raw === null) return null;
    const o = raw as Record<string, unknown>;

    if (o['t'] === 'in') {
      const inputs = o['inputs'];
      if (!Array.isArray(inputs)) return null;
      // A client could otherwise pin the server by sending an enormous batch.
      if (inputs.length === 0 || inputs.length > MAX_INPUT_BATCH) return null;
      if (!inputs.every(isValidInput)) return null;
      return { t: 'in', inputs: inputs as WireInput[] };
    }

    if (o['t'] === 'ping') {
      if (!isSafeInt(o['id'], 0, MAX_SEQ)) return null;
      if (!isFiniteNumber(o['sent'])) return null;
      return { t: 'ping', id: o['id'], sent: o['sent'] };
    }

    return null;
  },

  decodeServer(data) {
    const raw = parse(data);
    if (typeof raw !== 'object' || raw === null) return null;
    const o = raw as Record<string, unknown>;

    switch (o['t']) {
      case 'welcome':
        if (!isSafeInt(o['slot'], 0, 8)) return null;
        if (!isSafeInt(o['tick'], 0, MAX_SEQ)) return null;
        if (!isSafeInt(o['tickRate'], 1, 1000)) return null;
        return { t: 'welcome', slot: o['slot'], tick: o['tick'], tickRate: o['tickRate'] };

      case 'snap':
        return decodeSnapshot(o);

      case 'pong':
        if (!isSafeInt(o['id'], 0, MAX_SEQ)) return null;
        if (!isFiniteNumber(o['sent'])) return null;
        if (!isFiniteNumber(o['serverTick'])) return null;
        return { t: 'pong', id: o['id'], sent: o['sent'], serverTick: o['serverTick'] };

      case 'full':
        return { t: 'full' };

      case 'roster': {
        const names = o['names'];
        if (!Array.isArray(names) || names.length > 8) return null;
        if (!names.every((n) => typeof n === 'string' && n.length <= 64)) return null;
        return { t: 'roster', names: names as string[] };
      }

      default:
        return null;
    }
  },
};

/** Byte size of an encoded payload, for bandwidth accounting. */
export function wireSize(data: WireData): number {
  if (typeof data === 'string') {
    // Snapshots are all ASCII digits and punctuation, so this is exact for our
    // traffic; TextEncoder would be correct in general but costs an allocation
    // on a path that runs 20 times a second per client.
    return data.length;
  }
  return data.byteLength;
}
