/**
 * Simulation for the steerable "Working" ribbon, an homage to the "Now
 * Loading" text of Castlevania: Symphony of the Night. The head (the last
 * glyph) is steered with inertia; every other glyph follows the path the head
 * laid down and turns to face along it. Units are px and seconds.
 */

export const RIBBON_PHYSICS = {
  accel: 1800,
  maxSpeed: 520,
  drag: 4,
  restitution: 0.6,
  edgeGap: 4,
  sampleSpacing: 2,
  trailSlack: 32,
  wobbleAmplitude: 1.5,
  wobbleHz: 0.5,
  wobblePhaseStep: 0.6,
} as const;

/** Fixed simulation step, so steering feels the same at any refresh rate. */
export const RIBBON_STEP = 1 / 60;
/** At most this much time is simulated per frame (after a stall or hidden tab). */
export const RIBBON_MAX_CATCHUP = 0.05;
/** Absorbs float drift so N frames of 1/N s always run the same tick count. */
const STEP_EPSILON = 1e-9;

export interface RibbonPoint {
  x: number;
  y: number;
}

export interface RibbonBounds {
  width: number;
  height: number;
}

export interface RibbonInput {
  x: -1 | 0 | 1;
  y: -1 | 0 | 1;
}

/** A glyph's centre and its rotation in radians. */
export interface RibbonGlyphPose {
  x: number;
  y: number;
  angle: number;
}

export interface RibbonState {
  /** The live endpoint; never stored in `samples`. */
  head: RibbonPoint;
  velocity: RibbonPoint;
  /** Committed path points, oldest to newest. */
  samples: RibbonPoint[];
  /** Arc length across `samples`. */
  samplesLength: number;
  /** Simulation time not yet consumed by a fixed step. */
  accumulator: number;
}

type SteerDirection = "left" | "right" | "up" | "down";

/** Physical key codes, so WASD keeps its shape on AZERTY and non-Latin layouts. */
export const RIBBON_STEER_CODES: Readonly<Record<string, SteerDirection>> = {
  ArrowLeft: "left",
  KeyA: "left",
  ArrowRight: "right",
  KeyD: "right",
  ArrowUp: "up",
  KeyW: "up",
  ArrowDown: "down",
  KeyS: "down",
};

export function isRibbonSteerCode(code: string): boolean {
  return Object.hasOwn(RIBBON_STEER_CODES, code);
}

/** Opposite directions cancel out. */
export function directionFromCodes(pressed: ReadonlySet<string>): RibbonInput {
  let left = false;
  let right = false;
  let up = false;
  let down = false;
  for (const code of pressed) {
    switch (isRibbonSteerCode(code) ? RIBBON_STEER_CODES[code] : undefined) {
      case "left":
        left = true;
        break;
      case "right":
        right = true;
        break;
      case "up":
        up = true;
        break;
      case "down":
        down = true;
        break;
    }
  }
  return {
    x: left === right ? 0 : right ? 1 : -1,
    y: up === down ? 0 : down ? 1 : -1,
  };
}

/** Keeps a glyph clear of the edges at any rotation. */
export function collisionMargin(
  maxGlyphWidth: number,
  maxGlyphHeight: number,
  edgeGap: number = RIBBON_PHYSICS.edgeGap,
): number {
  return edgeGap + Math.ceil(Math.hypot(maxGlyphWidth, maxGlyphHeight) / 2);
}

/** Room to move, and to lay the whole text out flat inside the margins. */
export function hasPlayableSpace(bounds: RibbonBounds, margin: number, textWidth = 0): boolean {
  return bounds.width >= 2 * margin + Math.max(1, textWidth) && bounds.height >= 2 * margin + 1;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), Math.max(min, max));
}

function distance(a: RibbonPoint, b: RibbonPoint): number {
  return Math.hypot(b.x - a.x, b.y - a.y);
}

function measureSamples(samples: ReadonlyArray<RibbonPoint>): number {
  let length = 0;
  for (let index = 1; index < samples.length; index += 1) {
    length += distance(samples[index - 1]!, samples[index]!);
  }
  return length;
}

/** Lays the text out flat, ending at `origin` (shifted inward to fit). */
export function createRibbonState(
  origin: RibbonPoint,
  textWidth: number,
  bounds: RibbonBounds,
  margin: number,
): RibbonState {
  const width = Math.max(0, textWidth);
  const head = {
    x: clamp(Math.max(origin.x, margin + width), margin, bounds.width - margin),
    y: clamp(origin.y, margin, bounds.height - margin),
  };
  const segments = Math.max(1, Math.ceil(width / RIBBON_PHYSICS.sampleSpacing));
  const samples: RibbonPoint[] = [];
  for (let index = 0; index <= segments; index += 1) {
    samples.push({ x: head.x - width + (width * index) / segments, y: head.y });
  }
  return {
    head,
    velocity: { x: 0, y: 0 },
    samples,
    samplesLength: width,
    accumulator: 0,
  };
}

/** Runs whole fixed steps for `elapsed` seconds; returns how many ran. */
export function advanceRibbon(
  state: RibbonState,
  input: RibbonInput,
  elapsed: number,
  bounds: RibbonBounds,
  margin: number,
  maxTrailLength: number,
): number {
  const safeElapsed = Number.isFinite(elapsed) && elapsed > 0 ? elapsed : 0;
  state.accumulator += Math.min(safeElapsed, RIBBON_MAX_CATCHUP);
  let ticks = 0;
  while (state.accumulator >= RIBBON_STEP - STEP_EPSILON) {
    stepRibbon(state, input, RIBBON_STEP, bounds, margin, maxTrailLength);
    state.accumulator = Math.max(0, state.accumulator - RIBBON_STEP);
    ticks += 1;
  }
  return ticks;
}

function bounceAxis(
  position: number,
  velocity: number,
  min: number,
  max: number,
): { position: number; velocity: number } {
  const upper = Math.max(min, max);
  if (position < min) {
    return { position: min, velocity: velocity < 0 ? -velocity * RIBBON_PHYSICS.restitution : 0 };
  }
  if (position > upper) {
    return {
      position: upper,
      velocity: velocity > 0 ? -velocity * RIBBON_PHYSICS.restitution : 0,
    };
  }
  return { position, velocity };
}

/** One fixed step: steer, integrate, bounce, then record and trim the path. */
export function stepRibbon(
  state: RibbonState,
  input: RibbonInput,
  dt: number,
  bounds: RibbonBounds,
  margin: number,
  maxTrailLength: number,
): void {
  const { accel, maxSpeed, drag, sampleSpacing } = RIBBON_PHYSICS;
  const velocity = state.velocity;
  const inputLength = Math.hypot(input.x, input.y);
  const damping = Math.exp(-drag * dt);
  if (input.x !== 0) velocity.x += (accel * dt * input.x) / inputLength;
  else velocity.x *= damping;
  if (input.y !== 0) velocity.y += (accel * dt * input.y) / inputLength;
  else velocity.y *= damping;

  const speed = Math.hypot(velocity.x, velocity.y);
  if (speed > maxSpeed) {
    velocity.x *= maxSpeed / speed;
    velocity.y *= maxSpeed / speed;
  }

  const head = state.head;
  const x = bounceAxis(head.x + velocity.x * dt, velocity.x, margin, bounds.width - margin);
  const y = bounceAxis(head.y + velocity.y * dt, velocity.y, margin, bounds.height - margin);
  head.x = x.position;
  velocity.x = x.velocity;
  head.y = y.position;
  velocity.y = y.velocity;

  const samples = state.samples;
  const newest = samples[samples.length - 1];
  if (!newest) {
    samples.push({ x: head.x, y: head.y });
    return;
  }
  let last: RibbonPoint = newest;
  let gap = distance(last, head);
  while (gap >= sampleSpacing) {
    const next: RibbonPoint = {
      x: last.x + ((head.x - last.x) / gap) * sampleSpacing,
      y: last.y + ((head.y - last.y) / gap) * sampleSpacing,
    };
    samples.push(next);
    state.samplesLength += sampleSpacing;
    last = next;
    gap = distance(last, head);
  }

  let liveLength = state.samplesLength + gap;
  while (samples.length > 2) {
    const firstSegment = distance(samples[0]!, samples[1]!);
    if (liveLength - firstSegment < maxTrailLength) break;
    samples.shift();
    state.samplesLength -= firstSegment;
    liveLength -= firstSegment;
  }
}

/**
 * Pulls the head and its path inside resized bounds, after the stage or the
 * text changed size. Glyphs only stay inside while the path is at least as
 * long as the text (beyond it they extrapolate), so a path that clamping
 * collapsed, or that a longer label outgrew, is laid out flat again. Callers
 * check `hasPlayableSpace` with the text width first, so the flat path fits.
 */
export function fitRibbonToBounds(
  state: RibbonState,
  bounds: RibbonBounds,
  margin: number,
  textWidth: number,
): void {
  const clampPoint = (point: RibbonPoint) => {
    point.x = clamp(point.x, margin, bounds.width - margin);
    point.y = clamp(point.y, margin, bounds.height - margin);
  };
  clampPoint(state.head);
  for (const sample of state.samples) clampPoint(sample);
  state.samplesLength = measureSamples(state.samples);
  const last = state.samples[state.samples.length - 1];
  const liveLength = state.samplesLength + (last ? distance(last, state.head) : 0);
  if (liveLength >= textWidth) return;
  const flat = createRibbonState(state.head, textWidth, bounds, margin);
  state.head = flat.head;
  state.samples = flat.samples;
  state.samplesLength = flat.samplesLength;
}

/**
 * Places each glyph's centre along the path behind the head and turns it to
 * the path's direction there. The last glyph sits closest to the head. Writes
 * into `out`, which is resized to the glyph count and otherwise reused.
 */
export function layoutRibbonGlyphs(
  state: RibbonState,
  advances: ReadonlyArray<number>,
  timeSeconds: number,
  out: RibbonGlyphPose[],
): void {
  const { wobbleAmplitude, wobbleHz, wobblePhaseStep } = RIBBON_PHYSICS;
  const count = advances.length;
  if (out.length > count) out.length = count;
  while (out.length < count) out.push({ x: 0, y: 0, angle: 0 });

  const { head, samples } = state;
  // Walk from the head toward the oldest sample, one segment at a time.
  let cursor = samples.length - 1;
  let walkX = head.x;
  let walkY = head.y;
  let walked = 0;
  let hasSegment = false;
  let newerX = head.x;
  let newerY = head.y;
  let olderX = head.x;
  let olderY = head.y;
  let segmentLength = 0;
  let segmentStart = 0;
  let behind = 0;
  const time = Number.isFinite(timeSeconds) ? timeSeconds : 0;

  for (let index = count - 1; index >= 0; index -= 1) {
    const advance = Number.isFinite(advances[index]) ? advances[index]! : 0;
    const target = behind + advance / 2;
    behind += advance;

    while ((!hasSegment || target > segmentStart + segmentLength) && cursor >= 0) {
      const older = samples[cursor]!;
      cursor -= 1;
      const length = Math.hypot(walkX - older.x, walkY - older.y);
      if (length > 0) {
        newerX = walkX;
        newerY = walkY;
        olderX = older.x;
        olderY = older.y;
        segmentLength = length;
        segmentStart = walked;
        hasSegment = true;
      }
      walked += length;
      walkX = older.x;
      walkY = older.y;
    }

    const pose = out[index]!;
    if (hasSegment) {
      // Past the oldest sample this extrapolates along the oldest segment.
      const fraction = (target - segmentStart) / segmentLength;
      pose.x = newerX + (olderX - newerX) * fraction;
      pose.y = newerY + (olderY - newerY) * fraction;
      pose.angle = Math.atan2(newerY - olderY, newerX - olderX);
    } else {
      pose.x = head.x - target;
      pose.y = head.y;
      pose.angle = 0;
    }

    const wobble =
      wobbleAmplitude * Math.sin(2 * Math.PI * wobbleHz * time + index * wobblePhaseStep);
    pose.x += -Math.sin(pose.angle) * wobble;
    pose.y += Math.cos(pose.angle) * wobble;
  }
}
