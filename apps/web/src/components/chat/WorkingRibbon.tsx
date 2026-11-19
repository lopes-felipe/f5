import {
  memo,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";

import { isKeyboardEventComposing } from "~/lib/keyboardComposition";
import { WORKING_RIBBON_SLOT } from "~/lib/workingRibbon";
import { COMPOSER_DOCK_HEIGHT_VAR } from "./composer/ComposerDock";
import {
  advanceRibbon,
  collisionMargin,
  createRibbonState,
  directionFromCodes,
  fitRibbonToBounds,
  hasPlayableSpace,
  isRibbonSteerCode,
  layoutRibbonGlyphs,
  RIBBON_PHYSICS,
  RIBBON_STEP,
  type RibbonBounds,
  type RibbonGlyphPose,
  type RibbonInput,
  type RibbonPoint,
  type RibbonState,
} from "./WorkingRibbon.logic";

export type WorkingRibbonReleaseReason = "escape" | "blur" | "no-space" | "invalid";

export interface WorkingRibbonProps {
  text: string;
  /** The Working status region; the animation never leaves this element. */
  boundsElement: HTMLElement | null;
  /** Client coordinates of the label's right edge, at its vertical centre. */
  origin: RibbonPoint;
  onRelease: (reason: WorkingRibbonReleaseReason) => void;
  /** The ribbon unmounted for an outside reason while it held focus. */
  onOrphanedFocus: () => void;
}

interface RibbonSimulation {
  state: RibbonState | null;
  bounds: RibbonBounds;
  margin: number;
  textWidth: number;
  maxTrailLength: number;
  advances: number[];
  widths: number[];
  heights: number[];
  poses: RibbonGlyphPose[];
  time: number;
}

const STILL: RibbonInput = { x: 0, y: 0 };

/**
 * The working label, picked up and steerable: an homage to the "Now Loading"
 * text of Castlevania: Symphony of the Night. Arrow keys or WASD steer the
 * last glyph; the rest follow its path. Glyph transforms are written straight
 * to the DOM each frame, so React only renders when the text changes.
 */
export const WorkingRibbon = memo(function WorkingRibbon(props: WorkingRibbonProps) {
  const { text } = props;
  const latestPropsRef = useRef(props);
  latestPropsRef.current = props;
  const statusId = useId();
  const hintId = useId();
  const stageRef = useRef<HTMLDivElement>(null);
  const glyphRefs = useRef<Array<HTMLSpanElement | null>>([]);
  const simulationRef = useRef<RibbonSimulation>({
    state: null,
    bounds: { width: 0, height: 0 },
    margin: 0,
    textWidth: 0,
    maxTrailLength: 0,
    advances: [],
    widths: [],
    heights: [],
    poses: [],
    time: 0,
  });
  const pressedRef = useRef(new Set<string>());
  const inputRef = useRef<RibbonInput>(STILL);
  const releasedRef = useRef(false);
  const updateBoundsRef = useRef<(() => boolean) | null>(null);
  const [measureVersion, setMeasureVersion] = useState(0);
  const glyphs = Array.from(text);

  const release = (reason: WorkingRibbonReleaseReason) => {
    if (releasedRef.current) return;
    releasedRef.current = true;
    pressedRef.current.clear();
    inputRef.current = STILL;
    latestPropsRef.current.onRelease(reason);
  };
  const releaseRef = useRef(release);
  releaseRef.current = release;

  const writeFrame = () => {
    const simulation = simulationRef.current;
    if (!simulation.state) return;
    layoutRibbonGlyphs(simulation.state, simulation.advances, simulation.time, simulation.poses);
    for (let index = 0; index < simulation.poses.length; index += 1) {
      const glyph = glyphRefs.current[index];
      const pose = simulation.poses[index];
      if (!glyph || !pose) continue;
      const left = pose.x - (simulation.widths[index] ?? 0) / 2;
      const top = pose.y - (simulation.heights[index] ?? 0) / 2;
      glyph.style.transform = `translate(${left}px, ${top}px) rotate(${pose.angle}rad)`;
    }
  };
  const writeFrameRef = useRef(writeFrame);
  writeFrameRef.current = writeFrame;

  // After the stage or the text changed size: keep every glyph inside the
  // stage, or drop the ribbon when the text no longer fits.
  const fitToStage = () => {
    const simulation = simulationRef.current;
    if (!simulation.state) return;
    if (!hasPlayableSpace(simulation.bounds, simulation.margin, simulation.textWidth)) {
      release("no-space");
      return;
    }
    fitRibbonToBounds(simulation.state, simulation.bounds, simulation.margin, simulation.textWidth);
    writeFrame();
  };
  const fitToStageRef = useRef(fitToStage);
  fitToStageRef.current = fitToStage;

  // Measure glyph boxes (offset sizes ignore transforms). Re-runs when the text
  // gains or loses glyphs, and when fonts or appearance settings change.
  useLayoutEffect(() => {
    const glyphCount = Array.from(text).length;
    glyphRefs.current.length = glyphCount;
    const simulation = simulationRef.current;
    const widths: number[] = [];
    const heights: number[] = [];
    for (let index = 0; index < glyphCount; index += 1) {
      const glyph = glyphRefs.current[index];
      const width = glyph?.offsetWidth ?? 0;
      const height = glyph?.offsetHeight ?? 0;
      if (!(width > 0) || !(height > 0) || !Number.isFinite(width) || !Number.isFinite(height)) {
        releaseRef.current("invalid");
        return;
      }
      widths.push(width);
      heights.push(height);
    }
    simulation.widths = widths;
    simulation.heights = heights;
    simulation.advances = widths;
    simulation.margin = collisionMargin(Math.max(0, ...widths), Math.max(0, ...heights), 1);
    simulation.textWidth = widths.reduce((total, width) => total + width, 0);
    simulation.maxTrailLength = simulation.textWidth + RIBBON_PHYSICS.trailSlack;
    updateBoundsRef.current?.();
    // Fits synchronously so glyphs added mid-flight never paint at the
    // stage's corner, and a longer label never trails out of the stage.
    fitToStageRef.current();
  }, [text, measureVersion]);

  useLayoutEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    // Per run, so a Strict Mode replay cannot revive the first run's callbacks.
    let disposed = false;
    const simulation = simulationRef.current;
    const pressed = pressedRef.current;
    if (
      typeof ResizeObserver === "undefined" ||
      typeof window.requestAnimationFrame !== "function"
    ) {
      releaseRef.current("invalid");
      return;
    }
    if (releasedRef.current) return;

    const boundsElement = latestPropsRef.current.boundsElement;
    const parent = stage.offsetParent;
    if (!boundsElement || !(parent instanceof HTMLElement)) {
      releaseRef.current("invalid");
      return;
    }
    // The parent's box and the dock height change only on resizes and dock style writes, so
    // they are cached from observers. Each frame reads one rect: the Working row moves as
    // the timeline streams, which no ResizeObserver reports.
    const dockHost = parent.closest<HTMLElement>("[data-composer-dock-host]") ?? parent;
    const readDockHeight = () =>
      Math.max(
        0,
        Number.parseFloat(getComputedStyle(parent).getPropertyValue(COMPOSER_DOCK_HEIGHT_VAR)) || 0,
      );
    let dockHeight = readDockHeight();
    let parentRect = parent.getBoundingClientRect();
    const refreshCachedGeometry = () => {
      dockHeight = readDockHeight();
      parentRect = parent.getBoundingClientRect();
    };
    const stageStyle = { left: "", top: "", width: "", height: "" };
    const setStageStyle = (key: keyof typeof stageStyle, value: string) => {
      if (stageStyle[key] === value) return;
      stageStyle[key] = value;
      stage.style[key] = value;
    };
    const updateBounds = () => {
      if (!boundsElement.isConnected) {
        releaseRef.current("no-space");
        return false;
      }
      const region = boundsElement.getBoundingClientRect();
      const left = Math.max(region.left, parentRect.left);
      const top = Math.max(region.top, parentRect.top);
      const width = Math.max(0, Math.min(region.right, parentRect.right) - left);
      const height = Math.max(0, Math.min(region.bottom, parentRect.bottom - dockHeight) - top);
      setStageStyle(
        "left",
        String(left - parentRect.left - parent.clientLeft + parent.scrollLeft) + "px",
      );
      setStageStyle(
        "top",
        String(top - parentRect.top - parent.clientTop + parent.scrollTop) + "px",
      );
      setStageStyle("width", String(width) + "px");
      setStageStyle("height", String(height) + "px");
      const resized = simulation.bounds.width !== width || simulation.bounds.height !== height;
      simulation.bounds = { width, height };
      if (resized) fitToStageRef.current();
      return !releasedRef.current;
    };
    updateBoundsRef.current = updateBounds;
    if (!updateBounds()) return;
    const rect = stage.getBoundingClientRect();
    if (!hasPlayableSpace(simulation.bounds, simulation.margin, simulation.textWidth)) {
      releaseRef.current("no-space");
      return;
    }
    const { origin } = latestPropsRef.current;
    simulation.state = createRibbonState(
      { x: origin.x - rect.left, y: origin.y - rect.top },
      simulation.textWidth,
      simulation.bounds,
      simulation.margin,
    );
    simulation.time = 0;
    writeFrameRef.current();
    stage.focus({ preventScroll: true });

    const refreshBounds = () => {
      if (disposed) return;
      refreshCachedGeometry();
      updateBounds();
    };
    const resizeObserver = new ResizeObserver(refreshBounds);
    resizeObserver.observe(boundsElement);
    resizeObserver.observe(parent);
    // ComposerDock publishes its height as an inline custom property on the dock host.
    const dockObserver = new MutationObserver(refreshBounds);
    dockObserver.observe(dockHost, { attributes: true, attributeFilter: ["style"] });
    window.addEventListener("resize", refreshBounds);

    const remeasure = () => {
      if (!disposed) setMeasureVersion((version) => version + 1);
    };
    // Appearance settings (font family, size) are written to the root's style.
    const appearanceObserver = new MutationObserver(remeasure);
    appearanceObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["style"],
    });
    const fonts = typeof document.fonts === "undefined" ? null : document.fonts;
    fonts?.addEventListener("loadingdone", remeasure);
    void fonts?.ready.then(remeasure, () => {});

    const onWindowBlur = () => releaseRef.current("blur");
    const onVisibilityChange = () => {
      if (document.hidden) releaseRef.current("blur");
    };
    window.addEventListener("blur", onWindowBlur);
    document.addEventListener("visibilitychange", onVisibilityChange);

    let lastFrameAt: number | null = null;
    let frame = window.requestAnimationFrame(function tick(now) {
      if (disposed) return;
      frame = window.requestAnimationFrame(tick);
      const elapsed = lastFrameAt === null ? 0 : (now - lastFrameAt) / 1000;
      lastFrameAt = now;
      if (!simulation.state || !updateBounds()) return;
      const ticks = advanceRibbon(
        simulation.state,
        inputRef.current,
        elapsed,
        simulation.bounds,
        simulation.margin,
        simulation.maxTrailLength,
      );
      simulation.time += ticks * RIBBON_STEP;
      writeFrameRef.current();
    });

    return () => {
      disposed = true;
      if (updateBoundsRef.current === updateBounds) updateBoundsRef.current = null;
      window.cancelAnimationFrame(frame);
      resizeObserver.disconnect();
      dockObserver.disconnect();
      window.removeEventListener("resize", refreshBounds);
      appearanceObserver.disconnect();
      fonts?.removeEventListener("loadingdone", remeasure);
      window.removeEventListener("blur", onWindowBlur);
      document.removeEventListener("visibilitychange", onVisibilityChange);
      pressed.clear();
      inputRef.current = STILL;
      if (!releasedRef.current && stage.contains(document.activeElement)) {
        latestPropsRef.current.onOrphanedFocus();
      }
    };
  }, []);

  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    // macOS drops keyups while Cmd is held, so a modifier forgets held keys.
    if (event.key === "Meta" || event.key === "Control" || event.key === "Alt") {
      pressedRef.current.clear();
      inputRef.current = STILL;
      return;
    }
    if (
      event.metaKey ||
      event.ctrlKey ||
      event.altKey ||
      event.defaultPrevented ||
      isKeyboardEventComposing(event.nativeEvent)
    ) {
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      release("escape");
      return;
    }
    if (!isRibbonSteerCode(event.code)) return;
    event.preventDefault();
    event.stopPropagation();
    if (event.repeat) return;
    pressedRef.current.add(event.code);
    inputRef.current = directionFromCodes(pressedRef.current);
  };

  const onKeyUp = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    pressedRef.current.delete(event.code);
    inputRef.current = directionFromCodes(pressedRef.current);
  };

  return (
    <div
      ref={stageRef}
      tabIndex={-1}
      role="application"
      aria-label="Steerable working indicator"
      aria-describedby={`${statusId} ${hintId}`}
      data-slot={WORKING_RIBBON_SLOT}
      className="pointer-events-none absolute z-10 overflow-hidden outline-none"
      onKeyDown={onKeyDown}
      onKeyUp={onKeyUp}
      onBlur={() => release("blur")}
    >
      <span id={statusId} className="sr-only">
        {text}
      </span>
      {glyphs.map((glyph, index) => (
        <span
          // Glyphs are positional: index keys keep transforms stable as the
          // timer's digits change.
          key={index}
          ref={(node) => {
            glyphRefs.current[index] = node;
          }}
          aria-hidden="true"
          data-ribbon-glyph=""
          className="absolute left-0 top-0 inline-block select-none whitespace-pre text-xs tabular-nums text-muted-foreground will-change-transform"
        >
          {glyph}
        </span>
      ))}
      <p id={hintId} className="sr-only">
        Arrow keys or WASD to steer · Esc to drop
      </p>
    </div>
  );
});
