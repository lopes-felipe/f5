import { useEffect, useId, useRef, useState } from "react";
import type { KeyboardEvent, PointerEvent } from "react";

import {
  DEFAULT_PICKER_HSV,
  parseSafeThemeColor,
  pickerHsvToThemeColor,
  themeColorToPickerHsv,
  type ThemePickerHsv,
} from "../../themePalette";
import { Input } from "../ui/input";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";

const HUE_GRADIENT =
  "linear-gradient(to right, #f00 0%, #ff0 17%, #0f0 33%, #0ff 50%, #00f 67%, #f0f 83%, #f00 100%)";
const THUMB_CLASS_NAME =
  "pointer-events-none absolute size-3.5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white shadow-sm ring-1 ring-black/25";
const AREA_FOCUS_CLASS_NAME =
  "relative touch-none select-none outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-popover";

const SATURATION_VALUE_STEP = 0.01;
const SATURATION_VALUE_LARGE_STEP = 0.1;
const HUE_STEP = 1;
const HUE_LARGE_STEP = 10;

type HsvUpdate = (current: ThemePickerHsv) => ThemePickerHsv;

export function ThemeColorPicker({
  label,
  value,
  onChange,
}: {
  readonly label: string;
  readonly value: string;
  readonly onChange: (value: string) => void;
}) {
  const inputId = useId();
  const [draft, setDraft] = useState(value);
  const [error, setError] = useState<string | null>(null);
  // Kept while the popover is open so hue survives grey, black and white picks. The ref
  // lets rapid pointer and key events build on each other before React re-renders.
  const [hsv, setHsv] = useState<ThemePickerHsv>(DEFAULT_PICKER_HSV);
  const hsvRef = useRef(hsv);
  // Picks update the local swatch and thumbs immediately, but reach `onChange` at most once
  // per animation frame, because each change re-resolves the whole draft theme.
  const pendingRef = useRef<string | null>(null);
  const frameRef = useRef<number | null>(null);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  const cancelPending = () => {
    if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
    frameRef.current = null;
    pendingRef.current = null;
  };

  const flushPending = () => {
    const pending = pendingRef.current;
    cancelPending();
    if (pending !== null) onChangeRef.current(pending);
  };

  useEffect(() => {
    // A pick still waiting for its frame is newer than `value`.
    if (pendingRef.current === null) setDraft(value);
  }, [value]);

  useEffect(() => flushPending, []);

  const commit = () => {
    cancelPending();
    try {
      const next = parseSafeThemeColor(draft);
      setDraft(next);
      setError(null);
      onChange(next);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  const pick = (update: HsvUpdate) => {
    const next = update(hsvRef.current);
    hsvRef.current = next;
    setHsv(next);
    const color = pickerHsvToThemeColor(next, value);
    setDraft(color);
    setError(null);
    pendingRef.current = color;
    frameRef.current ??= requestAnimationFrame(flushPending);
  };

  return (
    <div className="space-y-1.5">
      <label htmlFor={inputId} className="block text-xs font-medium text-foreground">
        {label}
      </label>
      <span className="flex items-center gap-2">
        <Popover
          onOpenChange={(open) => {
            if (!open) {
              flushPending();
              return;
            }
            const current = themeColorToPickerHsv(value) ?? DEFAULT_PICKER_HSV;
            hsvRef.current = current;
            setHsv(current);
          }}
        >
          <PopoverTrigger
            aria-label={`Pick ${label} color`}
            title={`Pick ${label} color`}
            className="size-7 shrink-0 cursor-pointer rounded-md border border-border outline-none transition-shadow hover:ring-2 hover:ring-ring/24 focus-visible:ring-2 focus-visible:ring-ring"
            style={{ backgroundColor: error ? "transparent" : draft }}
          />
          <PopoverPopup align="start" className="w-60">
            <ThemeColorSpectrum label={label} hsv={hsv} color={draft} onChange={pick} />
          </PopoverPopup>
        </Popover>
        <Input
          id={inputId}
          nativeInput
          value={draft}
          aria-invalid={error ? true : undefined}
          onChange={(event) => {
            cancelPending();
            setDraft(event.target.value);
            setError(null);
          }}
          onBlur={commit}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              event.currentTarget.blur();
            }
          }}
        />
      </span>
      {error ? <span className="block text-xs text-destructive-foreground">{error}</span> : null}
    </div>
  );
}

function ThemeColorSpectrum({
  label,
  hsv,
  color,
  onChange,
}: {
  readonly label: string;
  readonly hsv: ThemePickerHsv;
  readonly color: string;
  readonly onChange: (update: HsvUpdate) => void;
}) {
  const pureHue = `hsl(${hsv.h} 100% 50%)`;
  const saturation = Math.round(hsv.s * 100);
  const brightness = Math.round(hsv.v * 100);
  const hue = Math.round(hsv.h);

  const saturationValueDrag = pointerDragHandlers((x, y) =>
    onChange((current) => ({ ...current, s: x, v: 1 - y })),
  );
  const hueDrag = pointerDragHandlers((x) => onChange((current) => ({ ...current, h: x * 360 })));

  const onSaturationValueKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const update = saturationValueKeyUpdate(event.key, event.shiftKey);
    if (!update) return;
    event.preventDefault();
    onChange(update);
  };

  const onHueKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const update = hueKeyUpdate(event.key, event.shiftKey);
    if (!update) return;
    event.preventDefault();
    onChange(update);
  };

  return (
    <div className="space-y-3">
      <div
        role="slider"
        tabIndex={0}
        aria-label={`${label} saturation and brightness`}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={saturation}
        aria-valuetext={`Saturation ${saturation}%, brightness ${brightness}%`}
        className={`${AREA_FOCUS_CLASS_NAME} h-36 w-full cursor-crosshair rounded-md border border-border`}
        style={{
          backgroundColor: pureHue,
          backgroundImage:
            "linear-gradient(to top, #000, transparent), linear-gradient(to right, #fff, transparent)",
        }}
        onKeyDown={onSaturationValueKeyDown}
        {...saturationValueDrag}
      >
        <span
          className={THUMB_CLASS_NAME}
          style={{ left: `${hsv.s * 100}%`, top: `${(1 - hsv.v) * 100}%`, backgroundColor: color }}
        />
      </div>

      <div
        role="slider"
        tabIndex={0}
        aria-label={`${label} hue`}
        aria-valuemin={0}
        aria-valuemax={360}
        aria-valuenow={hue}
        aria-valuetext={`${hue} degrees`}
        className={`${AREA_FOCUS_CLASS_NAME} h-3 w-full cursor-pointer rounded-full`}
        style={{ backgroundImage: HUE_GRADIENT }}
        onKeyDown={onHueKeyDown}
        {...hueDrag}
      >
        <span
          className={THUMB_CLASS_NAME}
          style={{ left: `${(hsv.h / 360) * 100}%`, top: "50%", backgroundColor: pureHue }}
        />
      </div>

      <div className="flex items-center gap-2">
        <span
          className="size-6 shrink-0 rounded-md border border-border"
          style={{ backgroundColor: color }}
          aria-hidden="true"
        />
        <span className="truncate font-mono text-xs text-muted-foreground">{color}</span>
      </div>
    </div>
  );
}

/**
 * Keyboard steps for the two-dimensional area: arrows move saturation (left/right) and
 * brightness (up/down), PageUp/PageDown take large brightness steps, and Home/End jump to
 * the saturation limits.
 */
function saturationValueKeyUpdate(key: string, shiftKey: boolean): HsvUpdate | null {
  const step = shiftKey ? SATURATION_VALUE_LARGE_STEP : SATURATION_VALUE_STEP;
  switch (key) {
    case "ArrowLeft":
      return (current) => ({ ...current, s: clampUnit(current.s - step) });
    case "ArrowRight":
      return (current) => ({ ...current, s: clampUnit(current.s + step) });
    case "ArrowDown":
      return (current) => ({ ...current, v: clampUnit(current.v - step) });
    case "ArrowUp":
      return (current) => ({ ...current, v: clampUnit(current.v + step) });
    case "PageDown":
      return (current) => ({ ...current, v: clampUnit(current.v - SATURATION_VALUE_LARGE_STEP) });
    case "PageUp":
      return (current) => ({ ...current, v: clampUnit(current.v + SATURATION_VALUE_LARGE_STEP) });
    case "Home":
      return (current) => ({ ...current, s: 0 });
    case "End":
      return (current) => ({ ...current, s: 1 });
    default:
      return null;
  }
}

/** Keyboard steps for the hue bar. Arrows and PageUp/PageDown wrap around the color wheel. */
function hueKeyUpdate(key: string, shiftKey: boolean): HsvUpdate | null {
  const step = shiftKey ? HUE_LARGE_STEP : HUE_STEP;
  const rotate =
    (delta: number): HsvUpdate =>
    (current) => ({
      ...current,
      h: wrapHue(current.h + delta),
    });
  switch (key) {
    case "ArrowLeft":
    case "ArrowDown":
      return rotate(-step);
    case "ArrowRight":
    case "ArrowUp":
      return rotate(step);
    case "PageDown":
      return rotate(-HUE_LARGE_STEP);
    case "PageUp":
      return rotate(HUE_LARGE_STEP);
    case "Home":
      return (current) => ({ ...current, h: 0 });
    case "End":
      return (current) => ({ ...current, h: 360 });
    default:
      return null;
  }
}

function wrapHue(hue: number): number {
  return ((hue % 360) + 360) % 360;
}

function clampUnit(value: number): number {
  return Math.min(1, Math.max(0, value));
}

/** Reports pointer positions inside the element as 0-1 fractions while dragging. */
function pointerDragHandlers(onMove: (x: number, y: number) => void) {
  const report = (event: PointerEvent<HTMLElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return;
    onMove(
      clampUnit((event.clientX - rect.left) / rect.width),
      clampUnit((event.clientY - rect.top) / rect.height),
    );
  };

  return {
    onPointerDown: (event: PointerEvent<HTMLElement>) => {
      if (event.button !== 0) return;
      // Keeps a mouse drag from selecting text in the popover; focus is moved explicitly.
      event.preventDefault();
      event.currentTarget.setPointerCapture(event.pointerId);
      event.currentTarget.focus();
      report(event);
    },
    onPointerMove: (event: PointerEvent<HTMLElement>) => {
      if (event.currentTarget.hasPointerCapture(event.pointerId)) report(event);
    },
  };
}
