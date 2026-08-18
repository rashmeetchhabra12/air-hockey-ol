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
 * ## Orientation
 *
 * The table is drawn **vertically**, with the player's own goal at the bottom —
 * the view you have standing at a real table, and the only orientation that
 * fills a phone screen held normally.
 *
 * The simulation stays landscape and knows nothing about this. Orientation is a
 * property of the camera, not of the world, so it is a canvas transform applied
 * once before drawing: every draw call below is written in plain rink
 * coordinates. Rotating the simulation instead would have meant swapping the
 * axes in physics, authority, the bot, the wire format and every test, all to
 * change where the goals appear on a screen the server does not have.
 *
 * ## Assembly
 *
 * Everything comes from an explicit view model rather than a snapshot, because
 * in the predicted path the things on screen originate in different places: the
 * local paddle from prediction, remote entities from interpolation or from
 * prediction depending on the puck, and the score from the newest snapshot.
 * Assembling the picture in one place keeps that reasoning together.
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
  /** Device-space top-left of the drawn table. */
  offsetX: number;
  offsetY: number;
  /** Table drawn on its end, goals at top and bottom. */
  portrait: boolean;
  /** Rotate a further half turn, so slot 1 also defends the bottom goal. */
  flip: boolean;
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

/** Margin around the table, in device pixels. */
const MARGIN = 26;

/**
 * Fit the table into the canvas.
 *
 * @param flip draw the half-turn view, for the player defending the far goal.
 */
export function computeView(canvasWidth: number, canvasHeight: number, flip = false): View {
  // Always on its end. A vertical table is what the game physically looks like,
  // it is the only shape that fills a phone screen, and keeping it fixed means
  // the controls do not change meaning between one device and the next.
  const portrait = true;
  const contentW = portrait ? RINK_HEIGHT : RINK_WIDTH;
  const contentH = portrait ? RINK_WIDTH : RINK_HEIGHT;

  const scale = Math.min(
    (canvasWidth - MARGIN * 2) / contentW,
    (canvasHeight - MARGIN * 2) / contentH,
  );

  return {
    scale,
    offsetX: (canvasWidth - contentW * scale) / 2,
    offsetY: (canvasHeight - contentH * scale) / 2,
    portrait,
    flip,
  };
}

/** The drawn table's device-space rectangle. */
function contentRect(view: View): { x: number; y: number; w: number; h: number } {
  return {
    x: view.offsetX,
    y: view.offsetY,
    w: (view.portrait ? RINK_HEIGHT : RINK_WIDTH) * view.scale,
    h: (view.portrait ? RINK_WIDTH : RINK_HEIGHT) * view.scale,
  };
}

/**
 * Switch the context into rink coordinates.
 *
 * Everything drawn after this is in rink units with the chosen orientation
 * already applied. Callers must have saved the context first.
 */
function applyRinkTransform(ctx: CanvasRenderingContext2D, view: View): void {
  const r = contentRect(view);

  if (!view.portrait) {
    ctx.translate(r.x, r.y);
  } else if (!view.flip) {
    // Quarter turn anticlockwise: rink +x runs up the screen, so slot 0's goal
    // (at x = 0) lands at the bottom.
    ctx.translate(r.x, r.y + r.h);
    ctx.rotate(-Math.PI / 2);
  } else {
    // The other quarter turn, putting slot 1's goal at the bottom instead.
    ctx.translate(r.x + r.w, r.y);
    ctx.rotate(Math.PI / 2);
  }

  ctx.scale(view.scale, view.scale);
}

/** Map a screen point (canvas pixels) into rink units — the inverse transform. */
export function screenToRink(view: View, sx: number, sy: number): Point {
  const r = contentRect(view);

  if (!view.portrait) {
    return { x: (sx - r.x) / view.scale, y: (sy - r.y) / view.scale };
  }
  if (!view.flip) {
    return { x: (r.y + r.h - sy) / view.scale, y: (sx - r.x) / view.scale };
  }
  return { x: (sy - r.y) / view.scale, y: (r.x + r.w - sx) / view.scale };
}

/** A stroke width in rink units that is never thinner than `px` on screen. */
function stroke(view: View, units: number, px = 1.2): number {
  return Math.max(units, px / view.scale);
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

/**
 * The cabinet: a dark frame with a lit top edge, giving the table depth.
 *
 * Drawn in device space rather than rink space. It is axis-aligned on screen in
 * either orientation, and keeping it out of the rotation means its drop shadow
 * still falls downward rather than sideways.
 */
function drawCabinet(ctx: CanvasRenderingContext2D, view: View): void {
  const r = contentRect(view);
  const lip = 20 * view.scale;

  ctx.save();
  ctx.shadowColor = 'rgba(0, 0, 0, 0.55)';
  ctx.shadowBlur = 40 * view.scale;
  ctx.shadowOffsetY = 12 * view.scale;

  const frame = ctx.createLinearGradient(0, r.y - lip, 0, r.y + r.h + lip);
  frame.addColorStop(0, COLORS.cabinetHighlight);
  frame.addColorStop(0.05, COLORS.cabinetEdge);
  frame.addColorStop(1, COLORS.cabinet);
  ctx.fillStyle = frame;
  roundRect(ctx, r.x - lip, r.y - lip, r.w + lip * 2, r.h + lip * 2, 26 * view.scale);
  ctx.fill();
  ctx.restore();
}

/** Everything painted on the playing surface, drawn in rink units. */
function drawTable(ctx: CanvasRenderingContext2D, view: View): void {
  const surface = ctx.createLinearGradient(0, 0, RINK_WIDTH, RINK_HEIGHT);
  surface.addColorStop(0, COLORS.surfaceTop);
  surface.addColorStop(1, COLORS.surfaceBottom);
  ctx.fillStyle = surface;
  ctx.fillRect(0, 0, RINK_WIDTH, RINK_HEIGHT);

  // A soft vignette, so the surface reads as lit from above rather than flat.
  const vignette = ctx.createRadialGradient(
    RINK_WIDTH / 2,
    RINK_HEIGHT / 2,
    RINK_HEIGHT * 0.25,
    RINK_WIDTH / 2,
    RINK_HEIGHT / 2,
    RINK_WIDTH * 0.6,
  );
  vignette.addColorStop(0, 'rgba(0,0,0,0)');
  vignette.addColorStop(1, 'rgba(24, 44, 66, 0.18)');
  ctx.fillStyle = vignette;
  ctx.fillRect(0, 0, RINK_WIDTH, RINK_HEIGHT);

  ctx.lineCap = 'round';

  // Centre line and circle.
  ctx.strokeStyle = COLORS.markingRed;
  ctx.lineWidth = stroke(view, 3, 1.5);
  ctx.beginPath();
  ctx.moveTo(RINK_WIDTH / 2, 0);
  ctx.lineTo(RINK_WIDTH / 2, RINK_HEIGHT);
  ctx.stroke();

  ctx.beginPath();
  ctx.arc(RINK_WIDTH / 2, RINK_HEIGHT / 2, 92, 0, Math.PI * 2);
  ctx.stroke();

  ctx.beginPath();
  ctx.arc(RINK_WIDTH / 2, RINK_HEIGHT / 2, 10, 0, Math.PI * 2);
  ctx.fillStyle = COLORS.markingRed;
  ctx.fill();

  // Goal creases, as on a real table.
  ctx.strokeStyle = COLORS.markingBlue;
  ctx.lineWidth = stroke(view, 2.4, 1.2);
  ctx.beginPath();
  ctx.arc(0, RINK_HEIGHT / 2, 132, -Math.PI / 2, Math.PI / 2);
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(RINK_WIDTH, RINK_HEIGHT / 2, 132, Math.PI / 2, -Math.PI / 2);
  ctx.stroke();

  // Face-off spots where each striker begins.
  ctx.fillStyle = COLORS.markingSoft;
  for (const fx of [RINK_WIDTH * 0.13, RINK_WIDTH * 0.87]) {
    ctx.beginPath();
    ctx.arc(fx, RINK_HEIGHT / 2, 7, 0, Math.PI * 2);
    ctx.fill();
  }

  // Goal mouths, recessed into the end walls.
  const depth = 15;
  ctx.fillStyle = COLORS.goalMouth;
  ctx.fillRect(-depth, GOAL_Y_MIN, depth, GOAL_Y_MAX - GOAL_Y_MIN);
  ctx.fillRect(RINK_WIDTH, GOAL_Y_MIN, depth, GOAL_Y_MAX - GOAL_Y_MIN);

  // Posts are solid bodies in the simulation, so a shot ringing off one should
  // clearly have hit something.
  ctx.fillStyle = COLORS.markingSoft;
  for (const gx of [0, RINK_WIDTH]) {
    for (const gy of [GOAL_Y_MIN, GOAL_Y_MAX]) {
      ctx.beginPath();
      ctx.arc(gx, gy, POST_RADIUS, 0, Math.PI * 2);
      ctx.fill();
    }
  }
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
  const r = PADDLE_RADIUS;

  ctx.save();

  ctx.fillStyle = 'rgba(20, 40, 60, 0.22)';
  ctx.beginPath();
  ctx.ellipse(p.x, p.y + r * 0.2, r * 1.02, r * 0.92, 0, 0, Math.PI * 2);
  ctx.fill();

  const body = ctx.createRadialGradient(p.x - r * 0.3, p.y - r * 0.4, r * 0.15, p.x, p.y, r);
  body.addColorStop(0, base);
  body.addColorStop(1, dark);
  ctx.fillStyle = body;
  ctx.beginPath();
  ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
  ctx.fill();

  // Recessed grip, as a real striker has.
  ctx.fillStyle = 'rgba(255,255,255,0.16)';
  ctx.beginPath();
  ctx.arc(p.x, p.y, r * 0.52, 0, Math.PI * 2);
  ctx.fill();

  ctx.fillStyle = 'rgba(255,255,255,0.4)';
  ctx.beginPath();
  ctx.ellipse(p.x - r * 0.25, p.y - r * 0.42, r * 0.36, r * 0.2, -0.5, 0, Math.PI * 2);
  ctx.fill();

  // The player's own striker gets a ring, so which one is theirs is never
  // ambiguous — particularly on a phone, where there is no cursor to follow.
  if (isSelf) {
    ctx.strokeStyle = 'rgba(255,255,255,0.85)';
    ctx.lineWidth = stroke(view, 2.5, 1.5);
    ctx.beginPath();
    ctx.arc(p.x, p.y, r + 4, 0, Math.PI * 2);
    ctx.stroke();
  }
  ctx.restore();
}

function drawPuck(ctx: CanvasRenderingContext2D, view: View, p: Point): void {
  const r = PUCK_RADIUS;

  ctx.save();
  ctx.fillStyle = 'rgba(20, 40, 60, 0.3)';
  ctx.beginPath();
  ctx.ellipse(p.x, p.y + r * 0.3, r * 1.05, r * 0.9, 0, 0, Math.PI * 2);
  ctx.fill();

  const body = ctx.createRadialGradient(p.x - r * 0.35, p.y - r * 0.45, r * 0.1, p.x, p.y, r);
  body.addColorStop(0, '#39414c');
  body.addColorStop(1, COLORS.puck);
  ctx.fillStyle = body;
  ctx.beginPath();
  ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
  ctx.fill();

  ctx.strokeStyle = COLORS.puckEdge;
  ctx.lineWidth = stroke(view, 1.6, 1);
  ctx.stroke();

  ctx.fillStyle = 'rgba(255,255,255,0.28)';
  ctx.beginPath();
  ctx.ellipse(p.x - r * 0.28, p.y - r * 0.4, r * 0.34, r * 0.18, -0.5, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

/**
 * Authoritative positions as dashed outlines.
 *
 * The most useful debugging tool in the project: with it, "is reconciliation
 * working" is answered by looking rather than by squinting at motion.
 */
function drawGhosts(ctx: CanvasRenderingContext2D, view: View, debug: DebugView): void {
  ctx.save();
  ctx.setLineDash([6 / view.scale, 5 / view.scale]);
  ctx.lineWidth = stroke(view, 1.5, 1.5);
  ctx.strokeStyle = COLORS.ghost;
  ctx.globalAlpha = 0.9;

  for (const ghost of debug.ghostPaddles) {
    ctx.beginPath();
    ctx.arc(ghost.x, ghost.y, PADDLE_RADIUS, 0, Math.PI * 2);
    ctx.stroke();
  }
  ctx.beginPath();
  ctx.arc(debug.ghostPuck.x, debug.ghostPuck.y, PUCK_RADIUS, 0, Math.PI * 2);
  ctx.stroke();
  ctx.restore();
}

/** An outline around the table, in device space. */
function outline(
  ctx: CanvasRenderingContext2D,
  view: View,
  color: string,
  alpha: number,
  widthPx: number,
): void {
  const r = contentRect(view);
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.strokeStyle = color;
  ctx.lineWidth = widthPx;
  ctx.strokeRect(r.x, r.y, r.w, r.h);
  ctx.restore();
}

function dim(ctx: CanvasRenderingContext2D, view: View, alpha: number): void {
  const r = contentRect(view);
  ctx.fillStyle = `rgba(8, 12, 18, ${alpha})`;
  ctx.fillRect(r.x, r.y, r.w, r.h);
}

/**
 * Overlays are drawn in device space, never inside the rink transform: text
 * rotated with the table would be unreadable.
 */
function drawCountdown(ctx: CanvasRenderingContext2D, view: View, seconds: number): void {
  const r = contentRect(view);
  const cx = r.x + r.w / 2;
  const cy = r.y + r.h / 2;
  const unit = Math.min(r.w, r.h);

  ctx.save();
  dim(ctx, view, 0.45);

  const whole = Math.ceil(seconds);
  // Each digit swells as it appears, so the count reads as motion rather than
  // three static frames.
  const progress = 1 - (whole - seconds);
  const grow = 1 + (1 - progress) * 0.22;

  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = '#ffffff';
  ctx.font = `700 ${Math.max(44, unit * 0.28 * grow)}px ui-sans-serif, system-ui, sans-serif`;
  ctx.globalAlpha = Math.min(1, 0.4 + progress);
  ctx.fillText(String(whole), cx, cy);

  ctx.globalAlpha = 0.8;
  ctx.font = `600 ${Math.max(11, unit * 0.032)}px ui-sans-serif, system-ui, sans-serif`;
  ctx.fillText('GET READY', cx, cy + Math.max(44, unit * 0.22));
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
  const r = contentRect(view);
  const cx = r.x + r.w / 2;
  const cy = r.y + r.h / 2;
  const unit = Math.min(r.w, r.h);

  ctx.save();
  dim(ctx, view, 0.72);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';

  ctx.fillStyle = COLORS.slot[winner] ?? '#ffffff';
  ctx.font = `700 ${Math.max(26, unit * 0.1)}px ui-sans-serif, system-ui, sans-serif`;
  const who = names[winner] || (winner === 0 ? 'Blue' : 'Red');
  ctx.fillText(`${who} wins`, cx, cy - unit * 0.07);

  ctx.fillStyle = '#ffffff';
  ctx.font = `600 ${Math.max(22, unit * 0.08)}px ui-monospace, "SF Mono", Menlo, monospace`;
  ctx.fillText(`${score[0] ?? 0} — ${score[1] ?? 0}`, cx, cy + unit * 0.05);

  if (seconds > 0) {
    ctx.globalAlpha = 0.65;
    ctx.fillStyle = '#c8d4e2';
    ctx.font = `500 ${Math.max(11, unit * 0.03)}px ui-sans-serif, system-ui, sans-serif`;
    ctx.fillText(`New match in ${Math.ceil(seconds)}…`, cx, cy + unit * 0.15);
  }
  ctx.restore();
}

function drawStatus(ctx: CanvasRenderingContext2D, view: View, message: string): void {
  const r = contentRect(view);
  const unit = Math.min(r.w, r.h);
  ctx.save();
  dim(ctx, view, 0.4);
  ctx.font = `500 ${Math.max(14, unit * 0.04)}px ui-sans-serif, system-ui, sans-serif`;
  ctx.fillStyle = '#dbe6f2';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(message, r.x + r.w / 2, r.y + r.h / 2);
  ctx.restore();
}

export function render(
  ctx: CanvasRenderingContext2D,
  canvasWidth: number,
  canvasHeight: number,
  scene: ViewState | null,
  status: string | null,
  flip = false,
): View {
  const view = computeView(canvasWidth, canvasHeight, flip);

  ctx.clearRect(0, 0, canvasWidth, canvasHeight);
  drawCabinet(ctx, view);

  // One transform for the whole world; everything inside is in rink units.
  ctx.save();
  applyRinkTransform(ctx, view);

  drawTable(ctx, view);

  if (scene) {
    for (let slot = 0; slot < scene.paddles.length; slot++) {
      drawPaddle(ctx, view, scene.paddles[slot]!, slot, slot === scene.slot);
    }
    drawPuck(ctx, view, scene.puck);
    if (scene.debug) drawGhosts(ctx, view, scene.debug);
  }

  ctx.restore();

  if (scene?.goalFlash && scene.goalFlash.intensity > 0.01) {
    const color = COLORS.slot[scene.goalFlash.slot] ?? '#ffffff';
    outline(ctx, view, color, scene.goalFlash.intensity * 0.6, 7 * view.scale);
  }

  if (!scene) {
    drawStatus(ctx, view, status ?? 'connecting…');
    return view;
  }

  if (scene.debug && scene.debug.correctionFlash > 0.01) {
    outline(ctx, view, COLORS.ghost, scene.debug.correctionFlash * 0.5, 3);
  }

  if (scene.winner !== undefined && scene.winner >= 0) {
    drawWinner(ctx, view, scene.winner, scene.names ?? [], scene.score, scene.countdown ?? 0);
  } else if (scene.countdown && scene.countdown > 0) {
    drawCountdown(ctx, view, scene.countdown);
  }

  if (scene.status) drawStatus(ctx, view, scene.status);
  return view;
}
