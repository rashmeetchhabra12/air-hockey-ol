import { cloneState, PLAYER_COUNT, type GameState, type PlayerInput } from '@ah/sim';

/**
 * Recorded state and inputs, so the server can rewind and re-simulate.
 *
 * ## What this is for
 *
 * A client applies its input at tick T and sees the result immediately. That
 * input reaches the server some tens of milliseconds later, by which time the
 * server is at tick T + n. Applying it *there* would put the paddle in the right
 * place at the wrong moment — the puck has moved on, and a strike that clearly
 * connected on the player's screen simply misses.
 *
 * Lag compensation restores the world to tick T, applies the input where it
 * belongs, and replays forward to the present. The player's view of their own
 * action becomes the authoritative one, which is the entire point: they aimed
 * at what they could see.
 *
 * ## The cost, stated plainly
 *
 * Rewinding is not free and it is not neutral. Replaying n ticks costs n
 * simulation steps, and — more importantly — it retroactively edits a past that
 * the *other* player has already been shown. Their puck can change course
 * because of something their opponent did in what is, for them, the past. That
 * is a real and deliberate trade: it is why the window is bounded rather than
 * unlimited, and why the bound is short enough that the rewritten past is still
 * roughly the present.
 */
export interface HistoryEntry {
  /** State *after* this tick was simulated. */
  state: GameState;
  /** Inputs applied on this tick, indexed by slot. */
  inputs: Array<PlayerInput | null>;
}

export class TickHistory {
  private readonly entries = new Map<number, HistoryEntry>();
  private oldest = Number.POSITIVE_INFINITY;
  private newest = -1;

  constructor(private readonly capacity: number) {}

  get oldestTick(): number {
    return this.entries.size === 0 ? -1 : this.oldest;
  }

  get newestTick(): number {
    return this.newest;
  }

  record(state: GameState, inputs: Array<PlayerInput | null>): void {
    // Clone on the way in. The room mutates its live state, and a history that
    // aliased it would silently rewrite its own past.
    this.entries.set(state.tick, {
      state: cloneState(state),
      inputs: inputs.slice(0, PLAYER_COUNT),
    });

    if (state.tick > this.newest) this.newest = state.tick;
    if (state.tick < this.oldest) this.oldest = state.tick;

    while (this.entries.size > this.capacity) {
      this.entries.delete(this.oldest);
      this.oldest++;
    }
  }

  get(tick: number): HistoryEntry | null {
    return this.entries.get(tick) ?? null;
  }

  /** True when `tick` can still be rewound to and replayed from. */
  canRewindTo(tick: number): boolean {
    // Rewinding to tick T means resuming from the state after T-1.
    return tick - 1 >= this.oldest && tick <= this.newest;
  }

  /**
   * Replace the recorded entries from `fromTick` onward.
   *
   * Used after a rewind, so subsequent rewinds build on the corrected timeline
   * rather than the one that was just discarded.
   */
  overwrite(fromTick: number, replacements: HistoryEntry[]): void {
    for (const entry of replacements) {
      this.entries.set(entry.state.tick, entry);
    }
    if (replacements.length > 0) {
      const last = replacements[replacements.length - 1]!;
      if (last.state.tick > this.newest) this.newest = last.state.tick;
    }
    void fromTick;
  }

  clear(): void {
    this.entries.clear();
    this.oldest = Number.POSITIVE_INFINITY;
    this.newest = -1;
  }
}
