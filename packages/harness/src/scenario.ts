import {
  ClientSession,
  Predictor,
  PuckSmoother,
  maxPlausibleFrameTravel,
  resolvePuck,
  SnapshotBuffer,
  TickPacer,
  type PuckStrategy,
} from '@ah/netcode';
import {
  createBinaryCodec,
  jsonCodec,
  quantizeTarget,
  type Codec,
  type NetworkConditions,
  type WireSnapshot,
} from '@ah/protocol';
import { GameRoom } from '@ah/server';
import { FixedTimestepLoop } from '@ah/server/loop';
import {
  clamp,
  cloneState,
  createInitialState,
  length,
  PADDLE_RADIUS,
  RINK_HEIGHT,
  RINK_WIDTH,
  SLOT_LEFT,
  step,
  TICK_RATE,
  paddleBoundsX,
  paddleHome,
  type GameState,
} from '@ah/sim';

import { VirtualLink, type LinkMode } from './link.js';
import { distribution, Samples, type Distribution } from './metrics.js';
import { mulberry32 } from './rng.js';

/**
 * Headless scenario runner.
 *
 * Drives the **real** `GameRoom`, `FixedTimestepLoop`, `ClientSession`,
 * `Predictor`, and `SnapshotBuffer` across a simulated network on a virtual
 * clock. Nothing here is a stand-in for production code; the only simulated
 * component is the network itself, which is the thing under study.
 *
 * Virtual time means a minute of gameplay measures in milliseconds and every
 * run is reproducible from its seed — a benchmark whose packet losses cannot be
 * replayed is an anecdote.
 */

const quantizeTarget2 = (p: { x: number; y: number }): { x: number; y: number } =>
  quantizeTarget(p.x, p.y);

/** Virtual milliseconds per step. Finer than a tick, so the accumulator paces. */
const STEP_MS = 1;

const PING_INTERVAL_MS = 1000;

export interface ScenarioConfig {
  label: string;
  seconds: number;
  conditions: NetworkConditions;
  mode: LinkMode;
  seed: number;
  /**
   * Prediction and interpolation on, or the P1 path: render the newest snapshot
   * directly. This is the netcode ON/OFF toggle, measured.
   */
  netcode: boolean;
  /** Defaults to `interpolate` (strategy A). */
  puckStrategy?: PuckStrategy;
  /** Ticks of server rewind allowed for late inputs. Zero disables lag compensation. */
  rewindWindowTicks?: number;
  /** Wire format. Defaults to JSON, the baseline the binary codec is measured against. */
  codec?: 'json' | 'binary';
}

export interface ScenarioResult {
  label: string;
  config: ScenarioConfig;

  /**
   * Disagreement found at reconciliation, in rink units.
   *
   * Zero on a clean link, because replay reproduces the server's arithmetic
   * exactly. Non-zero means inputs were lost or arrived too late to be used.
   */
  correction: Distribution;
  correctionsPerSecond: number;

  /**
   * How far the paddle on screen sits from where a zero-latency local game
   * would have drawn it.
   *
   * This is the headline number: it quantifies "does it feel local". Prediction
   * should hold it near zero regardless of RTT; without it, the figure grows in
   * proportion to latency.
   */
  paddleLagUnits: Distribution;

  /**
   * How far into the past the displayed puck actually is, in milliseconds.
   *
   * Measured by matching the on-screen puck against a recorded history of
   * authoritative positions and reporting the age of the closest match.
   *
   * Reported as *time* rather than distance on purpose. Distance is confounded
   * by puck speed, which varies between scenarios because the bots play
   * differently under different latency — it produced numbers that were not even
   * monotonic in RTT. Time is directly comparable across scenarios and has a
   * predictable expected value: roughly the interpolation delay plus half the
   * round trip.
   *
   * Under strategy A this is the full cost of never predicting the puck. It is
   * the number strategies B and C exist to reduce.
   */
  puckDisplayLagMs: Distribution;

  /**
   * How wrong the displayed puck was about the moment it claimed to depict,
   * in rink units.
   *
   * Recorded when the client draws tick T and resolved once the server reaches
   * T. This is the one number that makes the puck strategies comparable:
   *
   * - **interpolate** — large, because the picture was of an older moment.
   * - **predict** — the client's actual prediction error: near zero while the
   *   puck is uncontested, and growing when the opponent is near it, since
   *   their input had not arrived.
   */
  puckErrorUnits: Distribution;
  /**
   * The same error, split by whether this client held puck authority.
   *
   * The aggregate understates strategy C, because it averages over frames where
   * the puck is at the far end of the rink and the player is watching rather
   * than playing. Splitting shows what C actually does: take B's accuracy for
   * the frames where you are about to hit the puck, and A's correctness for the
   * ones where your opponent is.
   */
  puckErrorWhileOwned: Distribution;
  puckErrorWhileNotOwned: Distribution;
  /**
   * How often the displayed puck jumps further in one frame than it physically
   * could, and by how much.
   *
   * The other half of the tradeoff, and the half positional error cannot see. A
   * puck that is consistently 200 units stale still moves *smoothly*; a puck
   * that is usually exact but occasionally snaps 300 units sideways reads as
   * broken, even though its average error is far lower.
   *
   * Strategy A never jumps — interpolation only ever moves between real
   * positions. B jumps whenever a prediction is corrected. C should jump rarely,
   * because it predicts only when the prediction is trustworthy and crossfades
   * the handoffs.
   */
  puckJumpsPerSecond: number;
  puckJumpUnits: Distribution;
  /** Puck corrections per second at reconciliation. Zero unless the puck is predicted. */
  puckCorrectionsPerSecond: number;
  /** Authority handoffs blended per second. Meaningful only under strategy C. */
  puckHandoffsPerSecond: number;
  /** Fraction of frames this client was entitled to predict the puck. */
  puckOwnedRatio: number;

  /** Observed one-way delivery latency, including any head-of-line waiting. */
  deliveryToClientMs: Distribution;
  deliveryToServerMs: Distribution;

  bytesUpPerSecond: number;
  bytesDownPerSecond: number;

  /** Fraction of frames the interpolation buffer could not cover. */
  starvedFrameRatio: number;
  retransmits: number;
  dropped: number;
  goals: number;

  /** Server rewinds performed, and the average depth of each. */
  rewindsPerSecond: number;
  averageRewindTicks: number;
  /** Inputs that arrived after their tick had been simulated. */
  lateInputsPerSecond: number;
  /** Late inputs beyond the rewind window, discarded outright. */
  tooLatePerSecond: number;
  /** How far ahead of the server the client was running, in ticks. */
  leadTicks: Distribution;
  /** Snapshots reporting an empty forward buffer — inputs arriving at their deadline. */
  starvedReportsPerSecond: number;
  tickSkew: Distribution;
}

/**
 * A rolling record of where the puck authoritatively was.
 *
 * Lets the harness ask a question the client cannot answer for itself: given
 * the puck currently on screen, how old is that picture? Matching a displayed
 * position against recorded history and reporting the age of the closest entry
 * gives a figure in milliseconds, directly comparable across scenarios.
 *
 * Kept here rather than in the server, because nothing in production needs it —
 * P6's rewind buffer will serve a different purpose and answer to different
 * constraints.
 */
class PuckHistory {
  private readonly ticks: number[] = [];
  private readonly xs: number[] = [];
  private readonly ys: number[] = [];
  /** Increments on every goal, so matching never spans a teleport. */
  private readonly epochs: number[] = [];

  private epoch = 0;
  private lastScoreTotal = 0;
  private currentTick = 0;
  private currentSpeed = 0;

  /** One second of history. Older than that and the display is broken anyway. */
  private readonly capacity = TICK_RATE;

  record(state: GameState): void {
    const total = (state.score[0] ?? 0) + (state.score[1] ?? 0);
    if (total !== this.lastScoreTotal) {
      this.lastScoreTotal = total;
      this.epoch++;
    }

    this.currentTick = state.tick;
    this.currentSpeed = length(state.puck.vx, state.puck.vy);
    this.ticks.push(state.tick);
    this.xs.push(state.puck.x);
    this.ys.push(state.puck.y);
    this.epochs.push(this.epoch);

    if (this.ticks.length > this.capacity) {
      this.ticks.shift();
      this.xs.shift();
      this.ys.shift();
      this.epochs.shift();
    }
  }

  /**
   * Age in milliseconds of the recorded position closest to `shown`.
   *
   * @returns `null` when no confident match exists — during a post-goal
   *          teleport, when the closest entry is still far away, or when the
   *          puck is barely moving.
   *
   * The slow-puck exclusion matters: position-matching is ill-conditioned when
   * successive ticks sit almost on top of each other, because any of a dozen
   * history entries is an equally good match and the reported age becomes
   * arbitrary. Without this gate the p99 was dominated by moments when the puck
   * was nearly stationary and its display lag was, in any meaningful sense,
   * irrelevant.
   */
  ageOf(shown: { x: number; y: number }): number | null {
    // At 200 units/s the puck moves ~3.3 units per tick — comfortably more than
    // the matching tolerance, so the nearest entry is unambiguous.
    if (this.currentSpeed < 200) return null;

    let bestTick = -1;
    let bestDistance = Number.POSITIVE_INFINITY;

    for (let i = 0; i < this.ticks.length; i++) {
      // Never match across a goal: the puck teleports, so positions either side
      // of one are not on the same trajectory.
      if (this.epochs[i] !== this.epoch) continue;
      const d = length(this.xs[i]! - shown.x, this.ys[i]! - shown.y);
      if (d < bestDistance) {
        bestDistance = d;
        bestTick = this.ticks[i]!;
      }
    }

    // A puck moves at most 30 units per tick, so anything further out than that
    // is not a trajectory match and would report a meaningless age.
    if (bestTick < 0 || bestDistance > 30) return null;

    return ((this.currentTick - bestTick) * 1000) / TICK_RATE;
  }

  get tick(): number {
    return this.currentTick;
  }

  get currentEpoch(): number {
    return this.epoch;
  }

  /**
   * Authoritative puck position at an exact tick, if still in history.
   *
   * Enables the deferred comparison that makes the puck strategies measurable
   * against each other: record what was on screen when the *client* was at tick
   * T, then resolve it once the server reaches T and ask how wrong the picture
   * was about that moment.
   *
   * For a predicted puck that is prediction error. For an interpolated one it
   * is staleness expressed in distance. Both are "how wrong was the picture",
   * which is the only question a player would recognise.
   */
  positionAt(tick: number): { x: number; y: number; epoch: number } | null {
    for (let i = this.ticks.length - 1; i >= 0; i--) {
      if (this.ticks[i] === tick) {
        return { x: this.xs[i]!, y: this.ys[i]!, epoch: this.epochs[i]! };
      }
    }
    return null;
  }
}

/**
 * A synthetic player.
 *
 * Chases the puck's **last known position** rather than its true one, because
 * that is all a real player can see. Letting the script peek at authoritative
 * state would quietly remove the very latency the harness exists to measure.
 */
class SimulatedPlayer {
  readonly predictor: Predictor;
  readonly buffer = new SnapshotBuffer();
  readonly session: ClientSession;

  /** Zero-latency reference: the same inputs with no network at all. */
  private ideal: GameState = createInitialState();

  readonly correction = new Samples();
  readonly paddleLag = new Samples();
  readonly puckLagMs = new Samples();
  readonly puckError = new Samples();
  readonly puckErrorOwned = new Samples();
  readonly puckErrorNotOwned = new Samples();
  readonly puckJumps = new Samples();
  readonly lead = new Samples();
  readonly tickSkew = new Samples();
  private readonly smoother = new PuckSmoother();
  private lastShownPuck: { x: number; y: number } | null = null;

  /** Frames awaiting the server to reach the tick they were drawn for. */
  private readonly pending: Array<{
    tick: number;
    x: number;
    y: number;
    epoch: number;
    owned: boolean;
  }> = [];

  private readonly pacer = new TickPacer();
  private lastCorrectionCount = 0;
  /** Tick stamp used only when prediction is disabled. */
  private fallbackTick = 1;
  private measuring = false;
  private framesSampled = 0;
  private framesStarved = 0;
  private framesOwned = 0;

  constructor(
    readonly slot: number,
    link: VirtualLink,
    private readonly netcode: boolean,
    private readonly puckStrategy: PuckStrategy,
    codec: Codec,
    private readonly now: () => number,
    private readonly random: () => number,
  ) {
    this.predictor = new Predictor(slot);
    this.session = new ClientSession(link.clientSide, {
      codec,
      now,
      onSnapshot: (snapshot) => this.onSnapshot(snapshot),
    });
  }

  get starvedRatio(): number {
    return this.framesSampled === 0 ? 0 : this.framesStarved / this.framesSampled;
  }

  get ownedRatio(): number {
    return this.framesSampled === 0 ? 0 : this.framesOwned / this.framesSampled;
  }

  get handoffs(): number {
    return this.smoother.handoffs;
  }

  private onSnapshot(snapshot: WireSnapshot): void {
    this.buffer.push(snapshot, this.now());
    if (!this.netcode) return;
    this.predictor.reconcile(snapshot);
    this.pacer.observe(snapshot.depth[this.slot] ?? 0);
  }

  get pacerStats() {
    return this.pacer.getStats();
  }

  /** One client tick: decide intent, predict, transmit. */
  tick(): void {
    if (!this.session.ready) return;

    // Rounded through the wire's grid before predicting, so codec choice is a
    // pure bandwidth decision and never changes what is simulated.
    const target = quantizeTarget2(this.chooseTarget());
    // The pacer occasionally asks for two ticks or none, steering how far ahead
    // of the server this client runs so its inputs arrive before their deadline.
    const ticks = this.netcode ? this.pacer.ticksThisFrame() : 1;

    for (let i = 0; i < ticks; i++) {
      // Inputs are stamped with the tick they are simulated at, so the server
      // can apply each one where it belongs rather than where it arrived. With
      // netcode off nothing predicts, so the predictor's tick never advances
      // and a plain counter has to stand in for it.
      const tick = this.netcode ? this.predictor.getState().tick + 1 : this.fallbackTick++;
      this.session.queueInput({ seq: tick, x: target.x, y: target.y });

      const simInput = { seq: tick, targetX: target.x, targetY: target.y };
      if (this.netcode) this.predictor.predict(simInput);

      // Reference timeline: what the player would see with no network involved.
      this.ideal = step(this.ideal, this.slot === 0 ? [simInput, null] : [null, simInput]);
    }

    const stats = this.predictor.getStats();
    if (stats.corrections > this.lastCorrectionCount) {
      // Only after warm-up: the pacer needs a moment to find the right lead, and
      // that connection transient is not what these percentiles are about.
      if (this.measuring) this.correction.add(stats.lastErrorUnits);
      this.lastCorrectionCount = stats.corrections;
    }
  }

  /** Discard everything gathered during warm-up and begin measuring steady state. */
  startMeasuring(): void {
    this.measuring = true;
    this.lastCorrectionCount = this.predictor.getStats().corrections;

    /**
     * Rebase the zero-latency reference onto the current predicted state.
     *
     * Built from the first tick, the reference applies *every* input this player
     * ever generated — including the ones sent during connection for ticks the
     * server had already simulated, before the pacer had established a lead.
     * The server legitimately never applied those, so the reference drifts
     * permanently away from any timeline the player could actually have seen,
     * and the gap shows up as a paddle-lag tail that no netcode change can
     * close. Rebasing makes it mean what it claims: what a local game would
     * show *from here*, given the same inputs.
     */
    this.ideal = cloneState(this.predictor.getState());
  }

  /** One rendered frame: sample what is on screen and compare it to truth. */
  sampleFrame(frameMs: number, history: PuckHistory): void {
    const newest = this.buffer.newest();
    if (!newest) return;

    this.framesSampled++;
    this.predictor.decayCorrection(frameMs);

    let shownPaddle: { x: number; y: number };
    let shownPuck: { x: number; y: number };
    let owned = false;

    if (this.netcode) {
      const view = this.buffer.sample(this.now());
      if (!view) return;
      if (view.starved) this.framesStarved++;
      shownPaddle = this.predictor.getRenderedSelf();

      const resolved = resolvePuck(this.puckStrategy, this.predictor, view, this.slot);
      owned = resolved.owner === this.slot;
      if (owned) this.framesOwned++;
      shownPuck = this.smoother.apply(resolved, frameMs);
    } else {
      const pad = newest.pads[this.slot]!;
      shownPaddle = { x: pad[0], y: pad[1] };
      shownPuck = { x: newest.puck[0], y: newest.puck[1] };
    }

    this.lead.add(this.predictor.getState().tick - newest.tick);
    this.tickSkew.add(Math.abs(this.predictor.getState().tick - this.ideal.tick));
    this.recordPuckJump(shownPuck, frameMs);
    this.recordPuckSample(shownPuck, history, owned);

    const idealPaddle = this.ideal.paddles[this.slot]!;
    // Only sampled while the paddle is actually travelling. A parked paddle
    // agrees with every timeline trivially, so including those frames would
    // measure how often the bot happens to be idle rather than how far behind
    // the display is — and that varies between scenarios for reasons unrelated
    // to netcode.
    if (length(idealPaddle.vx, idealPaddle.vy) > 50) {
      this.paddleLag.add(length(shownPaddle.x - idealPaddle.x, shownPaddle.y - idealPaddle.y));
    }

    const lag = history.ageOf(shownPuck);
    if (lag !== null) this.puckLagMs.add(lag);
  }

  /**
   * Flag a displayed puck that moved further in one frame than it physically
   * could.
   *
   * The puck cannot exceed PUCK_MAX_SPEED, so at 60 Hz it covers at most 30
   * units per frame. Anything beyond that did not travel — it was relocated by
   * a correction or a source change, which is exactly what a player perceives
   * as the puck teleporting.
   */
  private recordPuckJump(shown: { x: number; y: number }, frameMs: number): void {
    const previous = this.lastShownPuck;
    this.lastShownPuck = { x: shown.x, y: shown.y };
    if (!previous) return;

    const moved = length(shown.x - previous.x, shown.y - previous.y);
    // Derived from the simulation and blend constants rather than guessed: a
    // hardcoded threshold flagged ordinary catch-up as a teleport and made
    // strategy C look worse than it is.
    if (moved > maxPlausibleFrameTravel(frameMs)) this.puckJumps.add(moved);
  }

  /**
   * Queue this frame's puck for later comparison, and resolve any queued frames
   * whose tick the server has now reached.
   *
   * Deferred because the client renders a tick the server has not simulated
   * yet. Asking "was that right?" is only answerable in arrears.
   */
  private recordPuckSample(
    shown: { x: number; y: number },
    history: PuckHistory,
    owned: boolean,
  ): void {
    this.pending.push({
      tick: this.predictor.getState().tick,
      x: shown.x,
      y: shown.y,
      epoch: history.currentEpoch,
      owned,
    });

    while (this.pending.length > 0) {
      const oldest = this.pending[0]!;
      if (oldest.tick > history.tick) break; // server has not got there yet
      this.pending.shift();

      const truth = history.positionAt(oldest.tick);
      // A goal between drawing and resolving makes the comparison meaningless:
      // the puck teleported, and no display could have been "right" about it.
      if (!truth || truth.epoch !== oldest.epoch) continue;

      const error = length(oldest.x - truth.x, oldest.y - truth.y);
      this.puckError.add(error);
      if (oldest.owned) this.puckErrorOwned.add(error);
      else this.puckErrorNotOwned.add(error);
    }

    // Bound memory if the server falls a long way behind.
    while (this.pending.length > TICK_RATE * 2) this.pending.shift();
  }

  /**
   * Where to move next.
   *
   * Attack when the puck is in this player's half; otherwise fall back toward
   * home and cover the goal.
   *
   * The retreat is not cosmetic. An earlier version simply tracked the puck's x
   * clamped into its own half, which pins the paddle against the centre line
   * whenever the puck is on the far side — where it then jams the puck against
   * the line. Measured, that produced a puck sitting in one half **98%** of the
   * time and permanently contested authority, which is not air hockey and made
   * every puck measurement meaningless. Bots that produce degenerate gameplay
   * silently invalidate the numbers taken from them.
   *
   * Reads the puck from what the client last received, never from authoritative
   * state — a synthetic player that peeks past the network would quietly remove
   * the latency the harness exists to measure.
   */
  private chooseTarget(): { x: number; y: number } {
    const newest = this.buffer.newest();
    const bounds = paddleBoundsX(this.slot);
    const home = paddleHome(this.slot);

    if (!newest) return { x: home.x, y: home.y };

    const puckX = newest.puck[0];
    const puckY = newest.puck[1];
    // Inclusive on both sides so that a puck sitting exactly on the centre line
    // is contested rather than ignored. Strict comparisons leave a dead zone at
    // x = 500 — which is precisely where play starts and where every goal resets
    // it, so neither player ever attacked and the puck never moved again.
    const half = RINK_WIDTH / 2;
    const inMyHalf = this.slot === SLOT_LEFT ? puckX <= half : puckX >= half;

    // Small jitter so the two players never settle into a perfectly symmetric
    // loop that produces the same rally forever.
    const wobble = (this.random() - 0.5) * 40;

    if (inMyHalf) {
      return {
        x: clamp(puckX, bounds.minX, bounds.maxX),
        y: clamp(puckY + wobble, PADDLE_RADIUS, RINK_HEIGHT - PADDLE_RADIUS),
      };
    }

    // Hold defensive depth, shading toward the puck's side of the goal.
    return {
      x: home.x,
      y: clamp(
        RINK_HEIGHT / 2 + (puckY - RINK_HEIGHT / 2) * 0.6 + wobble,
        PADDLE_RADIUS,
        RINK_HEIGHT - PADDLE_RADIUS,
      ),
    };
  }
}

export function runScenario(config: ScenarioConfig): ScenarioResult {
  let now = 0;
  const random = mulberry32(config.seed);

  // One codec instance per side. The binary codec is stateful — it delta-encodes
  // against the previous snapshot — so the server needs exactly one for the room
  // (all clients share the snapshot stream, and therefore the baseline) and each
  // client needs its own.
  const useBinary = config.codec === 'binary';
  const serverCodec = useBinary ? createBinaryCodec() : jsonCodec;

  const room = new GameRoom({
    codec: serverCodec,
    ...(config.rewindWindowTicks === undefined
      ? {}
      : { rewindWindowTicks: config.rewindWindowTicks }),
  });
  const links: VirtualLink[] = [];
  const players: SimulatedPlayer[] = [];

  for (let slot = 0; slot < 2; slot++) {
    const link = new VirtualLink(config.conditions, config.mode, random, () => now);
    links.push(link);
    room.join(link.serverSide);
    players.push(
      new SimulatedPlayer(
        slot,
        link,
        config.netcode,
        config.puckStrategy ?? 'interpolate',
        useBinary ? createBinaryCodec() : jsonCodec,
        () => now,
        random,
      ),
    );
  }

  // The genuine server loop and a client loop of the same construction, both on
  // virtual time. Neither is a harness-specific reimplementation.
  const history = new PuckHistory();

  const serverLoop = new FixedTimestepLoop({
    tickRate: TICK_RATE,
    timerMs: 8,
    maxCatchupTicks: 5,
    now: () => now,
    onTick: () => {
      room.tick();
      history.record(room.getState());
    },
  });

  const frameMs = 1000 / TICK_RATE;
  let nextFrameAt = 0;
  let nextPingAt = 0;

  const clientLoop = new FixedTimestepLoop({
    tickRate: TICK_RATE,
    timerMs: 8,
    maxCatchupTicks: 5,
    now: () => now,
    onTick: () => {
      for (const player of players) player.tick();
    },
  });

  const totalMs = config.seconds * 1000;

  // Give the connection a moment to complete the welcome handshake before the
  // measurement window opens, so warm-up does not pollute the percentiles.
  // Long enough for the pacer to converge on a lead, not merely for the first
  // packets to arrive: measuring during that ramp reports the cost of
  // connecting rather than the cost of playing.
  const warmupMs = Math.max(2000, config.conditions.rttMs * 8);
  let measuring = false;
  const baseline = { rewinds: 0, resimulated: 0, late: 0, tooLate: 0 };

  while (now < totalMs) {
    now += STEP_MS;

    for (const link of links) link.deliverDue();

    serverLoop.pump();
    clientLoop.pump();

    if (now >= nextPingAt) {
      nextPingAt = now + PING_INTERVAL_MS;
      for (const player of players) {
        if (player.session.ready) player.session.sendPing();
      }
    }

    if (now >= nextFrameAt) {
      nextFrameAt = now + frameMs;
      if (!measuring && now >= warmupMs) {
        measuring = true;
        for (const player of players) player.startMeasuring();
        baseline.rewinds = room.stats.rewinds;
        baseline.resimulated = room.stats.resimulatedTicks;
        baseline.late = room.getClientStats()[0]?.lateInputs ?? 0;
        baseline.tooLate = room.getClientStats()[0]?.tooLate ?? 0;
      }
      if (measuring) {
        for (const player of players) player.sampleFrame(frameMs, history);
      }
    }
  }

  const subject = players[0]!;
  const link = links[0]!;
  const measuredSeconds = (totalMs - warmupMs) / 1000;
  const state = room.getState();

  return {
    label: config.label,
    config,
    correction: distribution(subject.correction),
    correctionsPerSecond: subject.correction.count / measuredSeconds,
    paddleLagUnits: distribution(subject.paddleLag),
    puckDisplayLagMs: distribution(subject.puckLagMs),
    puckErrorUnits: distribution(subject.puckError),
    puckErrorWhileOwned: distribution(subject.puckErrorOwned),
    puckErrorWhileNotOwned: distribution(subject.puckErrorNotOwned),
    puckJumpsPerSecond: subject.puckJumps.count / measuredSeconds,
    puckJumpUnits: distribution(subject.puckJumps),
    puckCorrectionsPerSecond: subject.predictor.getStats().puckCorrections / measuredSeconds,
    puckHandoffsPerSecond: subject.handoffs / measuredSeconds,
    puckOwnedRatio: subject.ownedRatio,
    deliveryToClientMs: distribution(link.stats.latencyToClient),
    deliveryToServerMs: distribution(link.stats.latencyToServer),
    bytesUpPerSecond: link.stats.bytesToServer / config.seconds,
    bytesDownPerSecond: link.stats.bytesToClient / config.seconds,
    starvedFrameRatio: subject.starvedRatio,
    retransmits: link.stats.retransmits,
    dropped: link.stats.dropped,
    goals: (state.score[0] ?? 0) + (state.score[1] ?? 0),
    rewindsPerSecond: (room.stats.rewinds - baseline.rewinds) / measuredSeconds,
    averageRewindTicks:
      room.stats.rewinds - baseline.rewinds === 0
        ? 0
        : (room.stats.resimulatedTicks - baseline.resimulated) /
          (room.stats.rewinds - baseline.rewinds),
    lateInputsPerSecond:
      ((room.getClientStats()[0]?.lateInputs ?? 0) - baseline.late) / measuredSeconds,
    tooLatePerSecond:
      ((room.getClientStats()[0]?.tooLate ?? 0) - baseline.tooLate) / measuredSeconds,
    leadTicks: distribution(subject.lead),
    starvedReportsPerSecond: subject.pacerStats.starvedReports / measuredSeconds,
    tickSkew: distribution(subject.tickSkew),
  };
}

/** Rink units expressed as a fraction of the rink's diagonal, for readable reporting. */
export const RINK_DIAGONAL = length(RINK_WIDTH, RINK_HEIGHT);
