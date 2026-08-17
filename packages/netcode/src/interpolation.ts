import type { WireSnapshot } from '@ah/protocol';

/**
 * Entity interpolation for everything the client does not predict.
 *
 * ## Why this is a separate mechanism
 *
 * Prediction answers "where is *my* paddle now" by simulating ahead. It cannot
 * answer the same question about the opponent, because their input has not
 * reached us — and inventing one would produce confident, wrong motion that
 * snaps every time a snapshot disagrees.
 *
 * So remote entities are rendered deliberately **in the past**: far enough back
 * that two snapshots always bracket the render time, and their position can be
 * interpolated between known-true states rather than guessed. The cost is a
 * fixed display delay on things you do not control. The benefit is that they
 * move perfectly smoothly and never jump.
 *
 * This is the half of netcode that people forget. Prediction alone fixes your
 * own paddle and leaves the opponent stuttering at the snapshot rate, which
 * looks broken in a completely different way.
 */

/**
 * Fallback delay, used before enough arrivals have been observed to measure one.
 *
 * Two snapshot intervals at 20 Hz.
 */
export const INTERPOLATION_DELAY_MS = 100;

/**
 * Floor on the adaptive delay.
 *
 * Slightly more than one snapshot interval, which is the least that can bracket
 * a render time between two known states. Below this the buffer starves on
 * every frame and remote motion degrades to snapping between snapshots.
 */
const MIN_DELAY_MS = 58;

/** Ceiling, so a single pathological gap cannot pin the delay high for long. */
const MAX_DELAY_MS = 250;

/** Arrival gaps kept for the estimate. Two seconds at 20 Hz. */
const GAP_SAMPLES = 40;

/** Roughly two seconds of history at 20 Hz. Older entries can never be needed. */
const MAX_ENTRIES = 40;

interface Entry {
  snapshot: WireSnapshot;
  receivedAt: number;
}

export interface InterpolatedView {
  paddles: Array<{ x: number; y: number }>;
  puck: { x: number; y: number };
  score: number[];
  /** True when the buffer could not bracket the render time and had to clamp. */
  starved: boolean;
}

export interface InterpolationStats {
  buffered: number;
  /** Frames the buffer could not cover. Sustained non-zero means the delay is too short. */
  starvedFrames: number;
  /** Snapshots discarded for arriving after a newer one had already been used. */
  droppedLate: number;
  /** The delay currently being applied, in milliseconds. */
  delayMs: number;
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

export class SnapshotBuffer {
  private entries: Entry[] = [];
  /** Recent inter-arrival gaps, for sizing the delay to what the link needs. */
  private readonly gaps: number[] = [];
  private lastArrival = 0;

  private readonly stats: InterpolationStats = {
    buffered: 0,
    starvedFrames: 0,
    droppedLate: 0,
    delayMs: INTERPOLATION_DELAY_MS,
  };

  /**
   * How far in the past to render remote entities.
   *
   * Sized from the *observed* spacing of arrivals rather than fixed, because a
   * fixed value has to assume the worst. At 100 ms it made the puck visibly
   * trail even on a flawless local connection — around sixty units at rally
   * speed, three puck-widths — for margin that connection did not need.
   *
   * The delay must cover the largest gap between snapshots, or the render time
   * falls past the newest one and the buffer starves. So it tracks the widest
   * recent gap plus a fraction for headroom, and shrinks again as the link
   * settles. On a clean link that lands near one snapshot interval; under
   * jitter it widens on its own.
   */
  get delayMs(): number {
    if (this.gaps.length < 4) return INTERPOLATION_DELAY_MS;

    let widest = 0;
    for (const gap of this.gaps) {
      if (gap > widest) widest = gap;
    }

    const target = widest * 1.25 + 8;
    return Math.min(MAX_DELAY_MS, Math.max(MIN_DELAY_MS, target));
  }

  getStats(): Readonly<InterpolationStats> {
    return this.stats;
  }

  newest(): WireSnapshot | null {
    return this.entries.length > 0 ? this.entries[this.entries.length - 1]!.snapshot : null;
  }

  clear(): void {
    this.entries = [];
    this.gaps.length = 0;
    this.lastArrival = 0;
  }

  /**
   * Record a snapshot.
   *
   * Jitter reorders packets, so arrival order is not tick order. Entries are
   * kept sorted by tick and duplicates are ignored, which matters because the
   * network simulator deliberately duplicates packets and a real network does
   * so accidentally.
   */
  push(snapshot: WireSnapshot, nowMs: number): void {
    const newest = this.entries[this.entries.length - 1];

    if (newest && snapshot.tick === newest.snapshot.tick) return; // duplicate

    if (newest && snapshot.tick < newest.snapshot.tick) {
      // Out of order. Insert it if it is still ahead of the render window,
      // otherwise it is simply too late to be of any use.
      const oldest = this.entries[0]!;
      if (snapshot.tick <= oldest.snapshot.tick) {
        this.stats.droppedLate++;
        return;
      }
      const at = this.entries.findIndex((e) => e.snapshot.tick > snapshot.tick);
      if (at >= 0 && this.entries[at]?.snapshot.tick !== snapshot.tick) {
        this.entries.splice(at, 0, { snapshot, receivedAt: nowMs });
      } else {
        this.stats.droppedLate++;
      }
    } else {
      if (this.lastArrival > 0) {
        this.gaps.push(nowMs - this.lastArrival);
        while (this.gaps.length > GAP_SAMPLES) this.gaps.shift();
      }
      this.lastArrival = nowMs;
      this.entries.push({ snapshot, receivedAt: nowMs });
    }

    while (this.entries.length > MAX_ENTRIES) this.entries.shift();
    this.stats.buffered = this.entries.length;
    this.stats.delayMs = this.delayMs;
  }

  /**
   * Sample the world as it should be drawn now.
   *
   * @param nowMs client clock
   * @param delayMs how far into the past to render
   */
  sample(nowMs: number, delayMs: number = this.delayMs): InterpolatedView | null {
    if (this.entries.length === 0) return null;

    const renderAt = nowMs - delayMs;

    if (this.entries.length === 1) {
      return this.snap(this.entries[0]!.snapshot, true);
    }

    // Find the pair bracketing the render time.
    let before: Entry | null = null;
    let after: Entry | null = null;
    for (let i = 0; i < this.entries.length - 1; i++) {
      const a = this.entries[i]!;
      const b = this.entries[i + 1]!;
      if (a.receivedAt <= renderAt && renderAt <= b.receivedAt) {
        before = a;
        after = b;
        break;
      }
    }

    if (!before || !after) {
      // Either the buffer has not filled yet, or packets stopped arriving and
      // the render time has run past the newest entry. Clamping is the honest
      // response: extrapolating here invents motion that will need undoing.
      this.stats.starvedFrames++;
      const fallback =
        renderAt < this.entries[0]!.receivedAt
          ? this.entries[0]!
          : this.entries[this.entries.length - 1]!;
      return this.snap(fallback.snapshot, true);
    }

    const span = after.receivedAt - before.receivedAt;
    const t = span > 0 ? (renderAt - before.receivedAt) / span : 0;

    return this.blend(before.snapshot, after.snapshot, t);
  }

  private snap(snapshot: WireSnapshot, starved: boolean): InterpolatedView {
    return {
      paddles: snapshot.pads.map((p) => ({ x: p[0], y: p[1] })),
      puck: { x: snapshot.puck[0], y: snapshot.puck[1] },
      score: snapshot.score.slice(),
      starved,
    };
  }

  private blend(a: WireSnapshot, b: WireSnapshot, t: number): InterpolatedView {
    const paddles = b.pads.map((pb, i) => {
      const pa = a.pads[i] ?? pb;
      return { x: lerp(pa[0], pb[0], t), y: lerp(pa[1], pb[1], t) };
    });

    /**
     * A goal teleports the puck back to centre. Interpolating across that
     * discontinuity would slide it smoothly across the whole rink, which looks
     * like a bug and hides the goal that just happened.
     */
    const scored = a.score.some((s, i) => s !== b.score[i]);
    const puck = scored
      ? { x: b.puck[0], y: b.puck[1] }
      : { x: lerp(a.puck[0], b.puck[0], t), y: lerp(a.puck[1], b.puck[1], t) };

    return { paddles, puck, score: b.score.slice(), starved: false };
  }
}
