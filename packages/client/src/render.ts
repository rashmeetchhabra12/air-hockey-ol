import {
  GOAL_Y_MAX,
  GOAL_Y_MIN,
  PADDLE_RADIUS,
  POST_RADIUS,
  PUCK_RADIUS,
  RINK_HEIGHT,
  RINK_WIDTH,
} from '@ah/sim';

/**
 * Canvas renderer.
 *
 * Drawn to look like an actual air hockey table: a pale playing surface inside
 * a dark cabinet, red and blue markings, glossy strikers with contact shadows.
 * The earlier neon-on-black treatment read as a debug view, which is the wrong
 * first impression for something people are meant to play.
 *
 * Everything comes from an explicit view model rather than a snapshot, because
 * in the predicted path the things on screen originate in three different
 * places: the local paddle from prediction, remote entities from interpolation,
 * and the score from the newest snapshot. Assembling the picture in one place
 * keeps that reasoning together.
 */

const COLORS = {
  cabinet: '#12161c',
  cabinetEdge: '#2b333d',
  cabinetHighlight: '#3d4753',

  surfaceTop: '#f2f7fb',
  surfaceBottom: '#dbe6ef',

  markingRed: '#d4304a',
  markingBlue: '#2f6fd0',
  markingSoft: '#b9c9d8',

  goalMouth: '#161c24',

  slot: ['#1f7ae0', '#e0392f'],
  slotDark: ['#1558a8', '#a8231c'],

  puck: '#1b2027',
  puckEdge: '#0d1116',

  ghost: '#f0a500',
} as const;

export interface View {
  scale: number;
  offsetX: number;
  offsetY: number;
}

export interface Point {
  x: number;
  y: number;
}

export interface DebugView {
  ghostPaddles: Point[];
  ghostPuck: Point;
  /** 0..1, decaying. Flashes when reconciliation moves the local paddle. */
  correctionFlash: number;
}

export interface ViewState {
  /** Display names by slot. Empty entries are simply not drawn. */
  names?: readonly string[];
  /** Seconds remaining before play begins or resumes, or 0. */
  countdown?: number;
  /** Slot that has won, or -1 while the match is live. */
  winner?: number;
  /** 0..1, decaying. Pulses the table edge in the scorer's colour. */
  goalFlash?: { intensity: number; slot: number };
  paddles: Point[];
  puck: Point;
  score: readonly number[];
  /** Local slot, so the player's own striker can be marked. */
  slot: number | null;
  status: string | null;
  debug: DebugView | null;
}

/** Fit the table into the canvas, preserving aspect ratio and leaving a margin. */
export function computeView(canvasWidth: number, canvasHeight: number): View {
  const margin = 34;
  const scale = Math.min(
    (canvasWidth - margin * 2) / RINK_WIDTH,
    (canvasHeight - margin * 2) / RINK_HEIGHT,
  );
  return {
    scale,
    offsetX: (canvasWidth - RINK_WIDTH * scale) / 2,
    offsetY: (canvasHeight - RINK_HEIGHT * scale) / 2,
  };
}

/** Map a screen point (canvas pixels) into rink units. */
export function screenToRink(view: View, sx: number, sy: number): Point {
  return {
    x: (sx - view.offsetX) / view.scale,
    y: (sy - view.offsetY) / view.scale,
  };
}

function px(view: View, x: number): number {
  return view.offsetX + x * view.scale;
}

function py(view: View, y: number): number {
  return view.offsetY + y * view.scale;
}

function circlePath(
  ctx: CanvasRenderingContext2D,
  view: View,
  x: number,
  y: number,
  r: number,
): void {
  ctx.beginPath();
  ctx.arc(px(view, x), py(view, y), r * view.scale, 0, Math.PI * 2);
}

function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/** The cabinet: a dark frame with a lit top edge, giving the table depth. */
function drawCabinet(ctx: CanvasRenderingContext2D, view: View): void {
  const lip = 22 * view.scale;
  const x = view.offsetX - lip;
  const y = view.offsetY - lip;
  const w = RINK_WIDTH * view.scale + lip * 2;
  const h = RINK_HEIGHT * view.scale + lip * 2;

  ctx.save();
  ctx.shadowColor = 'rgba(0, 0, 0, 0.55)';
  ctx.shadowBlur = 40 * view.scale;
  ctx.shadowOffsetY = 12 * view.scale;

  const frame = ctx.createLinearGradient(0, y, 0, y + h);
  frame.addColorStop(0, COLORS.cabinetHighlight);
  frame.addColorStop(0.06, COLORS.cabinetEdge);
  frame.addColorStop(1, COLORS.cabinet);
  ctx.fillStyle = frame;
  roundRect(ctx, x, y, w, h, 26 * view.scale);
  ctx.fill();
  ctx.restore();
}

function drawSurface(ctx: CanvasRenderingContext2D, view: View): void {
  const x = view.offsetX;
  const y = view.offsetY;
  const w = RINK_WIDTH * view.scale;
  const h = RINK_HEIGHT * view.scale;

  const surface = ctx.createLinearGradient(0, y, 0, y + h);
  surface.addColorStop(0, COLORS.surfaceTop);
  surface.addColorStop(1, COLORS.surfaceBottom);
  ctx.fillStyle = surface;
  ctx.fillRect(x, y, w, h);

  // A soft vignette, so the surface reads as lit from above rather than flat.
  const vignette = ctx.createRadialGradient(
    x + w / 2,
    y + h / 2,
    h * 0.25,
    x + w / 2,
    y + h / 2,
    h * 0.95,
  );
  vignette.addColorStop(0, 'rgba(0,0,0,0)');
  vignette.addColorStop(1, 'rgba(24, 44, 66, 0.16)');
  ctx.fillStyle = vignette;
  ctx.fillRect(x, y, w, h);
}

function drawMarkings(ctx: CanvasRenderingContext2D, view: View): void {
  const x = view.offsetX;
  const y = view.offsetY;
  const w = RINK_WIDTH * view.scale;
  const h = RINK_HEIGHT * view.scale;

  ctx.save();
  ctx.lineCap = 'round';

  ctx.strokeStyle = COLORS.markingRed;
  ctx.lineWidth = Math.max(1.5, 3 * view.scale);
  ctx.beginPath();
  ctx.moveTo(x + w / 2, y);
  ctx.lineTo(x + w / 2, y + h);
  ctx.stroke();

  circlePath(ctx, view, RINK_WIDTH / 2, RINK_HEIGHT / 2, 92);
  ctx.stroke();

  circlePath(ctx, view, RINK_WIDTH / 2, RINK_HEIGHT / 2, 10);
  ctx.fillStyle = COLORS.markingRed;
  ctx.fill();

  // Goal creases, as on a real table.
  ctx.strokeStyle = COLORS.markingBlue;
  ctx.lineWidth = Math.max(1.2, 2.4 * view.scale);
  ctx.beginPath();
  ctx.arc(px(view, 0), py(view, RINK_HEIGHT / 2), 132 * view.scale, -Math.PI / 2, Math.PI / 2);
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(
    px(view, RINK_WIDTH),
    py(view, RINK_HEIGHT / 2),
    132 * view.scale,
    Math.PI / 2,
    -Math.PI / 2,
  );
  ctx.stroke();

  // Face-off spots where each striker begins.
  ctx.fillStyle = COLORS.markingSoft;
  for (const fx of [RINK_WIDTH * 0.13, RINK_WIDTH * 0.87]) {
    circlePath(ctx, view, fx, RINK_HEIGHT / 2, 7);
    ctx.fill();
  }
  ctx.restore();
}

function drawGoals(ctx: CanvasRenderingContext2D, view: View): void {
  const mouthHeight = (GOAL_Y_MAX - GOAL_Y_MIN) * view.scale;
  const depth = 15 * view.scale;

  ctx.save();
  ctx.fillStyle = COLORS.goalMouth;
  ctx.fillRect(px(view, 0) - depth, py(view, GOAL_Y_MIN), depth, mouthHeight);
  ctx.fillRect(px(view, RINK_WIDTH), py(view, GOAL_Y_MIN), depth, mouthHeight);

  // Posts are solid bodies in the simulation, so a shot ringing off one should
  // clearly have hit something.
  ctx.fillStyle = COLORS.markingSoft;
  for (const gx of [0, RINK_WIDTH]) {
    for (const gy of [GOAL_Y_MIN, GOAL_Y_MAX]) {
      circlePath(ctx, view, gx, gy, POST_RADIUS);
      ctx.fill();
    }
  }
  ctx.restore();
}

/** A striker: coloured disc, gloss highlight, and a contact shadow. */
function drawPaddle(
  ctx: CanvasRenderingContext2D,
  view: View,
  p: Point,
  slot: number,
  isSelf: boolean,
): void {
  const base = COLORS.slot[slot] ?? COLORS.slot[0]!;
  const dark = COLORS.slotDark[slot] ?? COLORS.slotDark[0]!;
  const cx = px(view, p.x);
  const cy = py(view, p.y);
  const r = PADDLE_RADIUS * view.scale;

  ctx.save();

  ctx.fillStyle = 'rgba(20, 40, 60, 0.22)';
  ctx.beginPath();
  ctx.ellipse(cx, cy + r * 0.2, r * 1.02, r * 0.92, 0, 0, Math.PI * 2);
  ctx.fill();

  const body = ctx.createRadialGradient(cx - r * 0.3, cy - r * 0.4, r * 0.15, cx, cy, r);
  body.addColorStop(0, base);
  body.addColorStop(1, dark);
  ctx.fillStyle = body;
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.fill();

  // Recessed grip, as a real striker has.
  ctx.fillStyle = 'rgba(255,255,255,0.16)';
  ctx.beginPath();
  ctx.arc(cx, cy, r * 0.52, 0, Math.PI * 2);
  ctx.fill();

  ctx.fillStyle = 'rgba(255,255,255,0.4)';
  ctx.beginPath();
  ctx.ellipse(cx - r * 0.25, cy - r * 0.42, r * 0.36, r * 0.2, -0.5, 0, Math.PI * 2);
  ctx.fill();

  // The player's own striker gets a ring, so which one is theirs is never
  // ambiguous — particularly on a phone, where there is no cursor to follow.
  if (isSelf) {
    ctx.strokeStyle = 'rgba(255,255,255,0.85)';
    ctx.lineWidth = Math.max(1.5, 2.5 * view.scale);
    ctx.beginPath();
    ctx.arc(cx, cy, r + 4 * view.scale, 0, Math.PI * 2);
    ctx.stroke();
  }
  ctx.restore();
}

function drawPuck(ctx: CanvasRenderingContext2D, view: View, p: Point): void {
  const cx = px(view, p.x);
  const cy = py(view, p.y);
  const r = PUCK_RADIUS * view.scale;

  ctx.save();
  ctx.fillStyle = 'rgba(20, 40, 60, 0.3)';
  ctx.beginPath();
  ctx.ellipse(cx, cy + r * 0.3, r * 1.05, r * 0.9, 0, 0, Math.PI * 2);
  ctx.fill();

  const body = ctx.createRadialGradient(cx - r * 0.35, cy - r * 0.45, r * 0.1, cx, cy, r);
  body.addColorStop(0, '#39414c');
  body.addColorStop(1, COLORS.puck);
  ctx.fillStyle = body;
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.fill();

  ctx.strokeStyle = COLORS.puckEdge;
  ctx.lineWidth = Math.max(1, 1.6 * view.scale);
  ctx.stroke();

  ctx.fillStyle = 'rgba(255,255,255,0.28)';
  ctx.beginPath();
  ctx.ellipse(cx - r * 0.28, cy - r * 0.4, r * 0.34, r * 0.18, -0.5, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

/**
 * Authoritative positions as dashed outlines.
 *
 * The most useful debugging tool in the project: with it, "is reconciliation
 * working" is answered by looking rather than by squinting at motion.
 */
function drawDebug(ctx: CanvasRenderingContext2D, view: View, debug: DebugView): void {
  ctx.save();
  ctx.setLineDash([6, 5]);
  ctx.lineWidth = 1.5;
  ctx.strokeStyle = COLORS.ghost;
  ctx.globalAlpha = 0.9;

  for (const ghost of debug.ghostPaddles) {
    circlePath(ctx, view, ghost.x, ghost.y, PADDLE_RADIUS);
    ctx.stroke();
  }
  circlePath(ctx, view, debug.ghostPuck.x, debug.ghostPuck.y, PUCK_RADIUS);
  ctx.stroke();
  ctx.restore();

  if (debug.correctionFlash > 0.01) {
    ctx.save();
    ctx.globalAlpha = debug.correctionFlash * 0.5;
    ctx.strokeStyle = COLORS.ghost;
    ctx.lineWidth = 3;
    ctx.strokeRect(view.offsetX, view.offsetY, RINK_WIDTH * view.scale, RINK_HEIGHT * view.scale);
    ctx.restore();
  }
}

function dim(ctx: CanvasRenderingContext2D, view: View, alpha: number): void {
  ctx.fillStyle = `rgba(8, 12, 18, ${alpha})`;
  ctx.fillRect(view.offsetX, view.offsetY, RINK_WIDTH * view.scale, RINK_HEIGHT * view.scale);
}

function drawCountdown(ctx: CanvasRenderingContext2D, view: View, seconds: number): void {
  const cx = px(view, RINK_WIDTH / 2);
  const cy = py(view, RINK_HEIGHT / 2);

  ctx.save();
  dim(ctx, view, 0.45);

  const whole = Math.ceil(seconds);
  // Each digit swells as it appears, so the count reads as motion rather than
  // three static frames.
  const progress = 1 - (whole - seconds);
  const scale = 1 + (1 - progress) * 0.22;

  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = '#ffffff';
  ctx.font = `700 ${Math.max(46, 132 * view.scale * scale)}px ui-sans-serif, system-ui, sans-serif`;
  ctx.globalAlpha = Math.min(1, 0.4 + progress);
  ctx.fillText(String(whole), cx, cy);

  ctx.globalAlpha = 0.8;
  ctx.font = `600 ${Math.max(11, 15 * view.scale)}px ui-sans-serif, system-ui, sans-serif`;
  ctx.fillText('GET READY', cx, cy + Math.max(46, 104 * view.scale));
  ctx.restore();
}

function drawWinner(
  ctx: CanvasRenderingContext2D,
  view: View,
  winner: number,
  names: readonly string[],
  score: readonly number[],
  seconds: number,
): void {
  const cx = px(view, RINK_WIDTH / 2);
  const cy = py(view, RINK_HEIGHT / 2);

  ctx.save();
  dim(ctx, view, 0.72);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';

  ctx.fillStyle = COLORS.slot[winner] ?? '#ffffff';
  ctx.font = `700 ${Math.max(28, 58 * view.scale)}px ui-sans-serif, system-ui, sans-serif`;
  const who = names[winner] || (winner === 0 ? 'Blue' : 'Red');
  ctx.fillText(`${who} wins`, cx, cy - 34 * view.scale);

  ctx.fillStyle = '#ffffff';
  ctx.font = `600 ${Math.max(22, 44 * view.scale)}px ui-monospace, "SF Mono", Menlo, monospace`;
  ctx.fillText(`${score[0] ?? 0} — ${score[1] ?? 0}`, cx, cy + 26 * view.scale);

  if (seconds > 0) {
    ctx.globalAlpha = 0.65;
    ctx.fillStyle = '#c8d4e2';
    ctx.font = `500 ${Math.max(11, 15 * view.scale)}px ui-sans-serif, system-ui, sans-serif`;
    ctx.fillText(`New match in ${Math.ceil(seconds)}…`, cx, cy + 78 * view.scale);
  }
  ctx.restore();
}

function drawStatus(ctx: CanvasRenderingContext2D, view: View, message: string): void {
  const cx = px(view, RINK_WIDTH / 2);
  const cy = py(view, RINK_HEIGHT / 2);
  ctx.save();
  dim(ctx, view, 0.4);
  ctx.font = `500 ${Math.max(14, 21 * view.scale)}px ui-sans-serif, system-ui, sans-serif`;
  ctx.fillStyle = '#dbe6f2';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(message, cx, cy);
  ctx.restore();
}

export function render(
  ctx: CanvasRenderingContext2D,
  canvasWidth: number,
  canvasHeight: number,
  scene: ViewState | null,
  status: string | null,
): View {
  const view = computeView(canvasWidth, canvasHeight);

  ctx.clearRect(0, 0, canvasWidth, canvasHeight);
  drawCabinet(ctx, view);
  drawSurface(ctx, view);
  drawMarkings(ctx, view);
  drawGoals(ctx, view);

  if (scene?.goalFlash && scene.goalFlash.intensity > 0.01) {
    ctx.save();
    ctx.globalAlpha = scene.goalFlash.intensity * 0.6;
    ctx.strokeStyle = COLORS.slot[scene.goalFlash.slot] ?? '#ffffff';
    ctx.lineWidth = 7 * view.scale;
    ctx.strokeRect(view.offsetX, view.offsetY, RINK_WIDTH * view.scale, RINK_HEIGHT * view.scale);
    ctx.restore();
  }

  if (!scene) {
    drawStatus(ctx, view, status ?? 'connecting…');
    return view;
  }

  for (let slot = 0; slot < scene.paddles.length; slot++) {
    drawPaddle(ctx, view, scene.paddles[slot]!, slot, slot === scene.slot);
  }

  drawPuck(ctx, view, scene.puck);
  if (scene.debug) drawDebug(ctx, view, scene.debug);

  if (scene.winner !== undefined && scene.winner >= 0) {
    drawWinner(ctx, view, scene.winner, scene.names ?? [], scene.score, scene.countdown ?? 0);
  } else if (scene.countdown && scene.countdown > 0) {
    drawCountdown(ctx, view, scene.countdown);
  }

  if (scene.status) drawStatus(ctx, view, scene.status);
  return view;
}
