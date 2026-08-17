/**
 * A growable sample set with percentile readout.
 *
 * Percentiles rather than means throughout. A mean hides exactly the events
 * that matter here: netcode is judged by its worst moments, not its typical
 * ones, and an average correction of 0.3 units is perfectly consistent with a
 * visible lurch twice a second.
 */
export class Samples {
  private readonly values: number[] = [];
  private sorted = false;

  add(value: number): void {
    this.values.push(value);
    this.sorted = false;
  }

  get count(): number {
    return this.values.length;
  }

  private ensureSorted(): void {
    if (this.sorted) return;
    this.values.sort((a, b) => a - b);
    this.sorted = true;
  }

  /** @param p in [0, 1]. Nearest-rank, so the result is always an observed value. */
  percentile(p: number): number {
    if (this.values.length === 0) return 0;
    this.ensureSorted();
    const index = Math.min(
      this.values.length - 1,
      Math.max(0, Math.ceil(p * this.values.length) - 1),
    );
    return this.values[index]!;
  }

  max(): number {
    if (this.values.length === 0) return 0;
    this.ensureSorted();
    return this.values[this.values.length - 1]!;
  }

  mean(): number {
    if (this.values.length === 0) return 0;
    let total = 0;
    for (const v of this.values) total += v;
    return total / this.values.length;
  }
}

export interface Distribution {
  p50: number;
  p95: number;
  p99: number;
  max: number;
}

export function distribution(samples: Samples): Distribution {
  return {
    p50: samples.percentile(0.5),
    p95: samples.percentile(0.95),
    p99: samples.percentile(0.99),
    max: samples.max(),
  };
}
