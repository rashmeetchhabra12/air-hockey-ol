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
 * Geometric on purpose: circles, lines, and glow. Minimal shapes read as a
 * deliberate aesthetic, where attempted-realistic art rendered with programmer
 * skill reads as unfinished. It also costs nothing to produce and stays legible
 * at phone size.
 *
 * Draws from an explicit view model rather than from a snapshot, because in the
 * predicted path the things on screen come from three different places at once:
 * the local paddle from the prediction, remote entities from interpolation, and
 * the score from the newest snapshot. Handing the renderer a finished picture
 * keeps that assembly in one place where it can be reasoned about.
 */

const COLORS = {
  page: '#070a0f',
  surface: '#0d141d',
  surfaceEdge: '#1c2836',
  line: '#1a2634',
  slot: ['#22d3ee', '#f472b6'],
  puck: '#f1f5f9',
  goal: '#64748b',
  post: '#94a3b8',
  ghost: '#facc15',
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
  /** Authoritative paddle positions from the newest snapshot. */
  ghostPaddles: Point[];
  /** Authoritative puck position from the newest snapshot. */
  ghostPuck: Point;
  /** 0..1, decaying. Flashes when reconciliation moves the local paddle. */
  correctionFlash: number;
}

export interface ViewState {
  /** Seconds remaining before play begins, or 0. Shown large at centre ice. */
  countdown?: number;
  /** 0..1, decaying. Pulses the rink edge in the scorer's colour after a goal. */
  goalFlash?: { intensity: number; slot: number };
  paddles: Point[];
  puck: Point;
  score: readonly number[];
  /** Local slot, so the player's own paddle can be emphasised. */
  slot: number | null;
  status: string | null;
  debug: DebugView | null;
}

/** Fit the rink into the canvas, preserving aspect ratio and leaving a margin. */
export function computeView(canvasWidth: number, canvasHeight: number): View {
  const margin = 24;
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

function circle(
  ctx: CanvasRenderingContext2D,
  view: View,
  x: number,
  y: number,
  radius: number,
): void {
  ctx.beginPath();
  ctx.arc(
    view.offsetX + x * view.scale,
    view.offsetY + y * view.scale,
    radius * view.scale,
    0,
    Math.PI * 2,
  );
}

function drawRink(ctx: CanvasRenderingContext2D, view: View): void {
  const x = view.offsetX;
  const y = view.offsetY;
  const w = RINK_WIDTH * view.scale;
  const h = RINK_HEIGHT * view.scale;

  ctx.fillStyle = COLORS.surface;
  ctx.fillRect(x, y, w, h);

  ctx.strokeStyle = COLORS.surfaceEdge;
  ctx.lineWidth = 2;
  ctx.strokeRect(x, y, w, h);

  ctx.strokeStyle = COLORS.line;
  ctx.lineWidth = 1.5;

  ctx.beginPath();
  ctx.moveTo(x + w / 2, y);
  ctx.lineTo(x + w / 2, y + h);
  ctx.stroke();

  circle(ctx, view, RINK_WIDTH / 2, RINK_HEIGHT / 2, 90);
  ctx.stroke();

  ctx.strokeStyle = COLORS.goal;
  ctx.lineWidth = 4;
  for (const gx of [0, RINK_WIDTH]) {
    ctx.beginPath();
    ctx.moveTo(x + gx * view.scale, y + GOAL_Y_MIN * view.scale);
    ctx.lineTo(x + gx * view.scale, y + GOAL_Y_MAX * view.scale);
    ctx.stroke();
  }

  // Posts, drawn because they are solid bodies in the simulation and a shot
  // that rings off one should look like it hit something real.
  ctx.fillStyle = COLORS.post;
  for (const gx of [0, RINK_WIDTH]) {
    for (const gy of [GOAL_Y_MIN, GOAL_Y_MAX]) {
      circle(ctx, view, gx, gy, POST_RADIUS);
      ctx.fill();
    }
  }
}

function drawPaddle(
  ctx: CanvasRenderingContext2D,
  view: View,
  p: Point,
  color: string,
  isSelf: boolean,
): void {
  ctx.save();
  ctx.shadowColor = color;
  ctx.shadowBlur = (isSelf ? 24 : 14) * view.scale;

  circle(ctx, view, p.x, p.y, PADDLE_RADIUS);
  ctx.fillStyle = color;
  ctx.globalAlpha = 0.18;
  ctx.fill();

  ctx.globalAlpha = 1;
  ctx.lineWidth = (isSelf ? 3.5 : 2.5) * view.scale;
  ctx.strokeStyle = color;
  ctx.stroke();
  ctx.restore();
}

function drawPuck(ctx: CanvasRenderingContext2D, view: View, p: Point): void {
  ctx.save();
  ctx.shadowColor = COLORS.puck;
  ctx.shadowBlur = 20 * view.scale;
  circle(ctx, view, p.x, p.y, PUCK_RADIUS);
  ctx.fillStyle = COLORS.puck;
  ctx.fill();
  ctx.restore();
}

/**
 * Authoritative positions, drawn as dashed outlines over the rendered scene.
 *
 * This is the single most useful debugging tool in the project. Without it,
 * "is reconciliation working?" is answered by squinting at motion. With it the
 * answer is visible: the ghost should sit almost exactly on the local paddle
 * when prediction is right, and visibly separate when it is not.
 */
function drawDebug(ctx: CanvasRenderingContext2D, view: View, debug: DebugView): void {
  ctx.save();
  ctx.setLineDash([6, 5]);
  ctx.lineWidth = 1.5;
  ctx.strokeStyle = COLORS.ghost;
  ctx.globalAlpha = 0.75;

  for (const ghost of debug.ghostPaddles) {
    circle(ctx, view, ghost.x, ghost.y, PADDLE_RADIUS);
    ctx.stroke();
  }

  circle(ctx, view, debug.ghostPuck.x, debug.ghostPuck.y, PUCK_RADIUS);
  ctx.stroke();
  ctx.restore();

  if (debug.correctionFlash > 0.01) {
    ctx.save();
    ctx.globalAlpha = debug.correctionFlash * 0.5;
    ctx.strokeStyle = COLORS.ghost;
    ctx.lineWidth = 3;
    ctx.setLineDash([]);
    ctx.strokeRect(
      view.offsetX,
      view.offsetY,
      RINK_WIDTH * view.scale,
      RINK_HEIGHT * view.scale,
    );
    ctx.restore();
  }
}

function drawScore(ctx: CanvasRenderingContext2D, view: View, score: readonly number[]): void {
  const cx = view.offsetX + (RINK_WIDTH / 2) * view.scale;
  const cy = view.offsetY + 62 * view.scale;
  const size = Math.max(26, 62 * view.scale);

  ctx.save();
  ctx.font = `600 ${size}px ui-monospace, "SF Mono", Menlo, monospace`;
  ctx.textBaseline = 'middle';

  ctx.textAlign = 'right';
  ctx.fillStyle = COLORS.slot[0];
  ctx.fillText(String(score[0] ?? 0), cx - size * 0.45, cy);

  ctx.textAlign = 'center';
  ctx.fillStyle = COLORS.line;
  ctx.fillText(':', cx, cy);

  ctx.textAlign = 'left';
  ctx.fillStyle = COLORS.slot[1];
  ctx.fillText(String(score[1] ?? 0), cx + size * 0.45, cy);
  ctx.restore();
}

/**
 * The face-off countdown.
 *
 * Drawn over a dimmed rink so it reads as an interruption rather than
 * decoration, and paired with a caption because a bare number is ambiguous
 * about whether it is counting toward something or away from it.
 */
function drawCountdown(ctx: CanvasRenderingContext2D, view: View, seconds: number): void {
  const cx = view.offsetX + (RINK_WIDTH / 2) * view.scale;
  const cy = view.offsetY + (RINK_HEIGHT / 2) * view.scale;

  ctx.save();
  ctx.fillStyle = 'rgba(7, 10, 15, 0.55)';
  ctx.fillRect(view.offsetX, view.offsetY, RINK_WIDTH * view.scale, RINK_HEIGHT * view.scale);

  const whole = Math.ceil(seconds);
  // Each digit swells as it appears and settles, so the count reads as motion
  // rather than three static frames.
  const progress = 1 - (whole - seconds);
  const scale = 1 + (1 - progress) * 0.25;

  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';

  ctx.shadowColor = COLORS.puck;
  ctx.shadowBlur = 24 * view.scale;
  ctx.fillStyle = COLORS.puck;
  ctx.font = `700 ${Math.max(44, 130 * view.scale * scale)}px ui-monospace, "SF Mono", Menlo, monospace`;
  ctx.globalAlpha = Math.min(1, 0.35 + progress);
  ctx.fillText(String(whole), cx, cy);

  ctx.shadowBlur = 0;
  ctx.globalAlpha = 0.75;
  ctx.fillStyle = COLORS.goal;
  ctx.font = `600 ${Math.max(11, 15 * view.scale)}px ui-sans-serif, system-ui, sans-serif`;
  ctx.fillText('GET READY', cx, cy + Math.max(42, 100 * view.scale));
  ctx.restore();
}

function drawStatus(ctx: CanvasRenderingContext2D, view: View, message: string): void {
  const cx = view.offsetX + (RINK_WIDTH / 2) * view.scale;
  const cy = view.offsetY + (RINK_HEIGHT / 2) * view.scale;
  ctx.save();
  ctx.font = `500 ${Math.max(14, 22 * view.scale)}px ui-sans-serif, system-ui, sans-serif`;
  ctx.fillStyle = COLORS.goal;
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

  ctx.fillStyle = COLORS.page;
  ctx.fillRect(0, 0, canvasWidth, canvasHeight);
  drawRink(ctx, view);

  if (scene?.goalFlash && scene.goalFlash.intensity > 0.01) {
    // A goal is the one moment the player must not miss, and the puck
    // teleporting back to centre is a poor way to announce it.
    ctx.save();
    ctx.globalAlpha = scene.goalFlash.intensity * 0.55;
    ctx.strokeStyle = COLORS.slot[scene.goalFlash.slot] ?? COLORS.puck;
    ctx.lineWidth = 6;
    ctx.strokeRect(
      view.offsetX,
      view.offsetY,
      RINK_WIDTH * view.scale,
      RINK_HEIGHT * view.scale,
    );
    ctx.restore();
  }

  if (!scene) {
    drawStatus(ctx, view, status ?? 'connecting...');
    return view;
  }

  for (let slot = 0; slot < scene.paddles.length; slot++) {
    drawPaddle(
      ctx,
      view,
      scene.paddles[slot]!,
      COLORS.slot[slot] ?? COLORS.goal,
      slot === scene.slot,
    );
  }

  drawPuck(ctx, view, scene.puck);
  if (scene.debug) drawDebug(ctx, view, scene.debug);
  drawScore(ctx, view, scene.score);
  if (scene.countdown && scene.countdown > 0) drawCountdown(ctx, view, scene.countdown);

  if (scene.status) drawStatus(ctx, view, scene.status);

  return view;
}
