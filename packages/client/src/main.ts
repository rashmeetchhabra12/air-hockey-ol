import {
  Predictor,
  PuckSmoother,
  resolvePuck,
  SnapshotBuffer,
  TickPacer,
  type PuckStrategy,
} from '@ah/netcode';
import {
  createBinaryCodec,
  jsonCodec,
  quantizeTarget,
  type NetworkConditions,
  type WireSnapshot,
} from '@ah/protocol';
import { FixedTimestepLoop } from '@ah/server/loop';
import { TICK_RATE } from '@ah/sim';

import { LobbyClient } from './lobby.js';
import { LocalMatch } from './local.js';
import { GameClient, type ConnectionState } from './net.js';
import { render, screenToRink, type DebugView, type View, type ViewState } from './render.js';

/**
 * Entry point.
 *
 * Opens straight into a match between two bots, hosted entirely in the page.
 * There is no lobby, no signup, and no waiting for a second human — a
 * multiplayer demo that needs two people to show anything shows nothing to the
 * person who arrives alone.
 *
 * All three modes render through one path, because in every one of them the
 * picture is assembled the same way: the local paddle from prediction, remote
 * entities from interpolation, and the puck from whichever strategy is chosen.
 */

const canvas = document.querySelector<HTMLCanvasElement>('#canvas')!;
const stage = document.querySelector<HTMLDivElement>('#stage')!;
const ctx = canvas.getContext('2d')!;

const el = {
  state: document.querySelector<HTMLElement>('#hud-state')!,
  rtt: document.querySelector<HTMLElement>('#hud-rtt')!,
  tick: document.querySelector<HTMLElement>('#hud-tick')!,
  unacked: document.querySelector<HTMLElement>('#hud-unacked')!,
  error: document.querySelector<HTMLElement>('#hud-error')!,
  puckErr: document.querySelector<HTMLElement>('#hud-puckerr')!,
  owner: document.querySelector<HTMLElement>('#hud-owner')!,
  corrections: document.querySelector<HTMLElement>('#hud-corrections')!,
  netcode: document.querySelector<HTMLInputElement>('#netcode')!,
  debug: document.querySelector<HTMLInputElement>('#debug')!,
  puck: document.querySelector<HTMLSelectElement>('#puck')!,
  mode: document.querySelector<HTMLSelectElement>('#mode')!,
  rttIn: document.querySelector<HTMLInputElement>('#rtt')!,
  jitterIn: document.querySelector<HTMLInputElement>('#jitter')!,
  lossIn: document.querySelector<HTMLInputElement>('#loss')!,
  rttOut: document.querySelector<HTMLElement>('#rtt-value')!,
  jitterOut: document.querySelector<HTMLElement>('#jitter-value')!,
  lossOut: document.querySelector<HTMLElement>('#loss-value')!,
  banner: document.querySelector<HTMLElement>('#banner')!,
  hint: document.querySelector<HTMLElement>('#hint')!,
  start: document.querySelector<HTMLElement>('#start')!,
  startNote: document.querySelector<HTMLElement>('#start-note')!,
  nameInput: document.querySelector<HTMLInputElement>('#name')!,
  playHuman: document.querySelector<HTMLButtonElement>('#play-human')!,
  playBot: document.querySelector<HTMLButtonElement>('#play-bot')!,
  watch: document.querySelector<HTMLButtonElement>('#watch')!,
  searching: document.querySelector<HTMLElement>('#searching')!,
  searchingText: document.querySelector<HTMLElement>('#searching-text')!,
  searchingCancel: document.querySelector<HTMLButtonElement>('#searching-cancel')!,
  hud: document.querySelector<HTMLElement>('#hud')!,
  netcodeText: document.querySelector<HTMLElement>('#netcode-text')!,
};

// ---------------------------------------------------------------------------
// Simulated network
// ---------------------------------------------------------------------------

const conditions: NetworkConditions = {
  rttMs: 0,
  jitterMs: 0,
  lossRate: 0,
  duplicateRate: 0,
};

function syncConditions(): void {
  conditions.rttMs = Number(el.rttIn.value);
  conditions.jitterMs = Number(el.jitterIn.value);
  conditions.lossRate = Number(el.lossIn.value) / 100;

  el.rttOut.textContent = `${conditions.rttMs} ms`;
  el.jitterOut.textContent = `${conditions.jitterMs} ms`;
  el.lossOut.textContent = `${Number(el.lossIn.value)}%`;
}

for (const input of [el.rttIn, el.jitterIn, el.lossIn]) {
  input.addEventListener('input', syncConditions);
}

// ---------------------------------------------------------------------------
// Modes
// ---------------------------------------------------------------------------

/**
 * Everything the render loop needs, whichever mode is active.
 *
 * Local and online matches differ only in where the authoritative room lives —
 * in this page, or across a socket — so they present the same surface and the
 * rest of the file never branches on which is running.
 */
interface ActiveMatch {
  tick(nowMs: number): void;
  slot(): number | null;
  predictor(): Predictor | null;
  buffer(): SnapshotBuffer | null;
  rttMs(): number;
  /** Display names by slot, empty where nobody is seated. */
  roster(): string[];
  status(): string | null;
  setTarget(x: number, y: number): void;
  dispose(): void;
}

const useJsonCodec = new URLSearchParams(location.search).get('codec') === 'json';

let netcodeEnabled = true;
let showDebug = false;
/**
 * Default puck strategy.
 *
 * B, not C, and measured rather than assumed. At the latency the demo opens on
 * — the slider starts at zero — B's p99 puck error is 56 units against C's 251,
 * because C only holds authority around a seventh of the time there and spends
 * the rest interpolating, inheriting A's tail. C earns its place at high
 * latency, where it is far smoother; it is not the right thing to show first.
 */
let puckStrategy: PuckStrategy = 'predict';
const puckSmoother = new PuckSmoother();

function createLocal(mode: 'spectate' | 'bot'): ActiveMatch {
  const match = new LocalMatch({ mode, conditions: () => conditions });

  return {
    tick: (now) => match.tick(now),
    slot: () => match.viewSlot,
    predictor: () => match.view().predictor,
    buffer: () => match.view().buffer,
    rttMs: () => match.rttMs,
    roster: () => (mode === 'bot' ? [playerName, 'Bot'] : ['Bot A', 'Bot B']),
    status: () => (match.ready ? null : 'starting...'),
    setTarget: (x, y) => match.setHumanTarget(x, y),
    dispose: () => match.dispose(),
  };
}

/**
 * Where to look for the game server when nothing says otherwise.
 *
 * In production the page is served by the same Worker that hosts the room, so
 * the socket goes back to wherever the page came from — no build-time
 * configuration, and nothing to keep in sync when the deployment moves. During
 * local development the client is on Vite's port and the worker on wrangler's,
 * so it falls back to the local worker.
 */
function defaultServerUrl(): string {
  const local = location.hostname === 'localhost' || location.hostname === '127.0.0.1';
  if (local) return 'ws://127.0.0.1:8787';
  return `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}`;
}

/**
 * Where the authoritative server lives, most specific first: an explicit
 * `?server=` override, then the value baked in at build time, then the page's
 * own origin.
 */
function serverBase(): string {
  const params = new URLSearchParams(location.search);
  return params.get('server') ?? import.meta.env['VITE_SERVER_URL'] ?? defaultServerUrl();
}

function createOnline(room: string, name: string): ActiveMatch {
  const base = serverBase();
  const predictor = new Predictor(0);
  const buffer = new SnapshotBuffer();
  const pacer = new TickPacer();
  let target = { x: 0, y: 0 };
  let state: ConnectionState = 'connecting';
  let roster: string[] = [];

  const url =
    `${base}/ws?room=${encodeURIComponent(room)}&name=${encodeURIComponent(name)}` +
    (useJsonCodec ? '&codec=json' : '');

  const client = new GameClient({
    url,
    codec: useJsonCodec ? jsonCodec : createBinaryCodec(),
    conditions: () => conditions,
    onStateChange: (s) => {
      state = s;
    },
    onWelcome: (slot) => predictor.setSlot(slot),
    onRoster: (names) => {
      roster = names;
    },
    onSnapshot: (snapshot: WireSnapshot) => {
      buffer.push(snapshot, performance.now());
      if (!netcodeEnabled) return;
      predictor.reconcile(snapshot);
      const slot = client.slot;
      if (slot !== null) pacer.observe(snapshot.depth[slot] ?? 0);
    },
  });
  client.connect();

  const STATUS: Partial<Record<ConnectionState, string>> = {
    connecting: 'connecting to server...',
    full: 'this room is full',
    closed: 'disconnected — is the server running?',
  };

  return {
    tick: () => {
      if (!client.ready) return;
      const aim = quantizeTarget(target.x, target.y);
      const ticks = netcodeEnabled ? pacer.ticksThisFrame() : 1;
      for (let i = 0; i < ticks; i++) {
        const tick = predictor.getState().tick + 1;
        client.queueInput({ seq: tick, x: aim.x, y: aim.y });
        if (netcodeEnabled) predictor.predict({ seq: tick, targetX: aim.x, targetY: aim.y });
      }
    },
    slot: () => client.slot,
    predictor: () => predictor,
    buffer: () => buffer,
    rttMs: () => client.rttMs,
    roster: () => roster,
    status: () => (buffer.newest() ? null : (STATUS[state] ?? null)),
    setTarget: (x, y) => {
      target = { x, y };
    },
    dispose: () => client.disconnect(),
  };
}

const HINTS: Record<string, string> = {
  spectate: 'Two bots playing in your browser. Drag Latency up, then toggle Netcode off.',
  bot: 'Move your mouse or finger to control the cyan paddle.',
  online: 'Playing a human. Both of you see the same authoritative match.',
};

/**
 * Player name, remembered between visits.
 *
 * localStorage rather than anything server-side: there is no account to attach
 * it to, and a returning player should not have to type it again.
 */
const NAME_KEY = 'air-hockey:name';
let playerName = localStorage.getItem(NAME_KEY) ?? '';

let active: ActiveMatch = createLocal('spectate');
let lobby: LobbyClient | null = null;

function switchMode(mode: string, room?: string): void {
  active.dispose();
  puckSmoother.reset();
  active =
    mode === 'online'
      ? createOnline(room ?? 'default', playerName || 'Player')
      : createLocal(mode === 'bot' ? 'bot' : 'spectate');
  el.mode.value = mode;
  el.hint.textContent = HINTS[mode] ?? '';
}

/**
 * Look for a human opponent, and play the bot in the meantime.
 *
 * The wait is deliberately not presented as a wait. A blank "searching" screen
 * is the moment a visitor leaves, and there is already a capable opponent
 * running in the page — so a match starts at once and is swapped for a human
 * one as soon as matchmaking finds somebody.
 */
function findHumanOpponent(): void {
  switchMode('bot');
  el.mode.value = 'online';
  el.searching.classList.add('visible');
  el.searchingText.textContent = 'Looking for an opponent…';

  lobby?.cancel();
  const client = new LobbyClient({
    url: serverBase(),
    name: playerName || 'Player',
    onState: (state, detail) => {
      if (state === 'searching') {
        el.searchingText.textContent =
          client.ahead > 0 ? `Waiting — ${client.ahead} ahead of you` : 'Looking for an opponent…';
      } else if (state === 'error') {
        el.searchingText.textContent = detail ?? 'matchmaking unavailable';
        // Leave them in the bot match rather than dropping them out of a game
        // they are already playing.
        setTimeout(() => el.searching.classList.remove('visible'), 4000);
      }
    },
    onMatched: (room, opponent) => {
      el.searching.classList.remove('visible');
      el.banner.style.display = 'block';
      el.banner.textContent = `MATCHED WITH ${opponent.toUpperCase()}`;
      setTimeout(() => {
        if (netcodeEnabled) el.banner.style.display = 'none';
      }, 3000);
      switchMode('online', room);
    },
  });
  lobby = client;
  client.search();
}

function stopSearching(): void {
  lobby?.cancel();
  lobby = null;
  el.searching.classList.remove('visible');
}

el.searchingCancel.addEventListener('click', () => {
  stopSearching();
  el.mode.value = 'bot';
});

el.mode.addEventListener('change', () => {
  stopSearching();
  if (el.mode.value === 'online') findHumanOpponent();
  else switchMode(el.mode.value);
});

// ---------------------------------------------------------------------------
// Start screen
// ---------------------------------------------------------------------------

el.nameInput.value = playerName;

function commitName(): void {
  playerName = el.nameInput.value.trim().slice(0, 16) || 'Player';
  localStorage.setItem(NAME_KEY, playerName);
  el.nameInput.value = playerName;
}

function begin(mode: 'spectate' | 'bot' | 'human'): void {
  commitName();
  el.start.classList.add('hidden');
  if (mode === 'human') findHumanOpponent();
  else switchMode(mode);
}

el.playHuman.addEventListener('click', () => begin('human'));
el.playBot.addEventListener('click', () => begin('bot'));
el.watch.addEventListener('click', () => begin('spectate'));
el.nameInput.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') begin('human');
});

el.netcode.addEventListener('change', () => {
  netcodeEnabled = el.netcode.checked;
  el.netcodeText.textContent = netcodeEnabled ? 'ON' : 'OFF';
  el.banner.style.display = netcodeEnabled ? 'none' : 'block';
  el.banner.textContent = netcodeEnabled ? '' : 'NETCODE OFF — RAW SERVER STATE';

  // The prediction went stale while it was switched off; adopt truth rather
  // than replaying inputs the server consumed long ago.
  const newest = active.buffer()?.newest();
  if (netcodeEnabled && newest) active.predictor()?.resync(newest);
});

el.debug.addEventListener('change', () => {
  showDebug = el.debug.checked;
  // The telemetry is the second of the two layers: unreadable to most visitors,
  // and the first thing an engineer wants. It appears only when asked for.
  el.hud.classList.toggle('visible', showDebug);
});

el.puck.addEventListener('change', () => {
  puckStrategy = el.puck.value as PuckStrategy;
  // The player asked for the change, so show it immediately rather than
  // blending it as if it were an authority handoff.
  puckSmoother.reset();
});

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------

let view: View = { scale: 1, offsetX: 0, offsetY: 0 };

function handlePointer(event: PointerEvent): void {
  const rect = canvas.getBoundingClientRect();
  const point = screenToRink(
    view,
    (event.clientX - rect.left) * (canvas.width / rect.width),
    (event.clientY - rect.top) * (canvas.height / rect.height),
  );
  active.setTarget(point.x, point.y);

  // Touching the rink while spectating is a clear signal the visitor wants to
  // play, so hand them a paddle rather than making them find a dropdown.
  if (event.pointerType === 'touch' && el.mode.value === 'spectate') {
    el.mode.value = 'bot';
    switchMode('bot');
  }
}

// Pointer events cover mouse, pen, and touch through one path, which is what
// makes this playable on a phone with no separate control scheme.
stage.addEventListener('pointermove', handlePointer);
stage.addEventListener('pointerdown', handlePointer);

// ---------------------------------------------------------------------------
// Loops
// ---------------------------------------------------------------------------

const clientLoop = new FixedTimestepLoop({
  tickRate: TICK_RATE,
  timerMs: 8,
  maxCatchupTicks: 5,
  now: () => performance.now(),
  onTick: () => active.tick(performance.now()),
});
clientLoop.start();

function resize(): void {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const rect = stage.getBoundingClientRect();
  canvas.width = Math.max(1, Math.round(rect.width * dpr));
  canvas.height = Math.max(1, Math.round(rect.height * dpr));
}

window.addEventListener('resize', resize);

let correctionFlash = 0;
let lastCorrectionCount = 0;
let goalFlash = 0;
let goalFlashSlot = 0;
let lastScoreTotal = 0;

/**
 * Assemble the scene.
 *
 * The picture is stitched from three sources on purpose: the local paddle from
 * prediction (the present), remote entities from interpolation (the recent
 * past), and the puck from whichever strategy is chosen. Each entity is drawn
 * from whichever source can be *correct* about it.
 */
function buildScene(nowMs: number, deltaMs: number): ViewState | null {
  const predictor = active.predictor();
  const buffer = active.buffer();
  if (!predictor || !buffer) return null;

  const newest = buffer.newest();
  if (!newest) return null;

  const slot = active.slot();

  const debug: DebugView | null = showDebug
    ? {
        ghostPaddles: newest.pads.map((p) => ({ x: p[0], y: p[1] })),
        ghostPuck: { x: newest.puck[0], y: newest.puck[1] },
        correctionFlash,
      }
    : null;

  // Taken from the newest snapshot rather than the prediction: the countdown is
  // a statement about the match, and the authoritative one is the only version
  // every player agrees on.
  const countdown = newest.frz > 0 ? newest.frz / TICK_RATE : 0;

  if (!netcodeEnabled || slot === null) {
    // The P1 path: whatever the server last said, drawn directly.
    return {
      paddles: newest.pads.map((p) => ({ x: p[0], y: p[1] })),
      puck: { x: newest.puck[0], y: newest.puck[1] },
      score: newest.score,
      slot,
      status: null,
      debug,
      countdown,
      names: active.roster(),
    };
  }

  const interpolated = buffer.sample(nowMs);
  if (!interpolated) return null;

  const paddles = interpolated.paddles.map((p) => ({ ...p }));
  paddles[slot] = predictor.getRenderedSelf();

  const resolved = resolvePuck(puckStrategy, predictor, interpolated, slot);
  const puck = puckSmoother.apply(resolved, deltaMs);

  return {
    paddles,
    puck,
    score: interpolated.score,
    slot,
    status: null,
    debug,
    countdown,
    names: active.roster(),
    ...(goalFlash > 0.01 ? { goalFlash: { intensity: goalFlash, slot: goalFlashSlot } } : {}),
  };
}

let lastFrame = performance.now();

function frame(): void {
  const now = performance.now();
  const deltaMs = Math.min(100, now - lastFrame);
  lastFrame = now;

  const predictor = active.predictor();
  predictor?.decayCorrection(deltaMs);

  const stats = predictor?.getStats();
  if (stats && stats.corrections > lastCorrectionCount) {
    lastCorrectionCount = stats.corrections;
    correctionFlash = 1;
  }
  correctionFlash = Math.max(0, correctionFlash - deltaMs / 260);
  goalFlash = Math.max(0, goalFlash - deltaMs / 900);

  const score = active.buffer()?.newest()?.score;
  if (score) {
    const total = (score[0] ?? 0) + (score[1] ?? 0);
    if (total > lastScoreTotal) {
      goalFlashSlot = (score[0] ?? 0) > (score[1] ?? 0) ? 0 : 1;
      goalFlash = 1;
    }
    lastScoreTotal = total;
  }

  const scene = buildScene(now, deltaMs);
  view = render(ctx, canvas.width, canvas.height, scene, active.status());

  // Skip the readouts entirely while the panel is hidden: it is a dozen DOM
  // writes per frame that nobody can see.
  if (!showDebug) {
    requestAnimationFrame(frame);
    return;
  }

  const newest = active.buffer()?.newest();
  el.state.textContent = el.mode.value;
  el.rtt.textContent = `${active.rttMs().toFixed(0)} ms`;
  el.tick.textContent = newest ? String(newest.tick) : '-';
  el.unacked.textContent = String(stats?.unackedInputs ?? 0);
  el.error.textContent = `${(stats?.lastErrorUnits ?? 0).toFixed(2)}u`;
  el.corrections.textContent = String(stats?.corrections ?? 0);
  el.puckErr.textContent =
    puckStrategy === 'interpolate' ? 'n/a' : `${(stats?.lastPuckErrorUnits ?? 0).toFixed(1)}u`;

  const owner = predictor?.getState().puckOwner ?? -1;
  el.owner.textContent = owner < 0 ? 'contested' : owner === active.slot() ? 'you' : 'opponent';

  requestAnimationFrame(frame);
}

syncConditions();
resize();
// `?mode=` skips the start screen, for a link meant to land somewhere specific.
const requested = new URLSearchParams(location.search).get('mode');
if (requested === 'bot' || requested === 'spectate') {
  el.start.classList.add('hidden');
  switchMode(requested);
} else if (requested === 'online') {
  el.start.classList.add('hidden');
  commitName();
  findHumanOpponent();
} else {
  el.hint.textContent = HINTS['spectate']!;
}

requestAnimationFrame(frame);
