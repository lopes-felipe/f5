import { useEffect, useId, useRef, useState } from "react";
import type { KeyboardEvent, PointerEvent } from "react";

import {
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
  "relative touch-none outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-popover";

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
  const [hsv, setHsv] = useState<ThemePickerHsv>({ h: 0, s: 0, v: 0 });
  const hsvRef = useRef(hsv);

  useEffect(() => setDraft(value), [value]);

  const applyColor = (next: string) => {
    setDraft(next);
    setError(null);
    onChange(next);
  };

  const commit = () => {
    try {
      applyColor(parseSafeThemeColor(draft));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  const pick = (update: (current: ThemePickerHsv) => ThemePickerHsv) => {
    const next = update(hsvRef.current);
    hsvRef.current = next;
    setHsv(next);
    applyColor(pickerHsvToThemeColor(next, value));
  };

  return (
    <div className="space-y-1.5">
      <label htmlFor={inputId} className="block text-xs font-medium text-foreground">
        {label}
      </label>
      <span className="flex items-center gap-2">
        <Popover
          onOpenChange={(open) => {
            if (!open) return;
            const current = themeColorToPickerHsv(value);
            if (!current) return;
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
  readonly onChange: (update: (current: ThemePickerHsv) => ThemePickerHsv) => void;
}) {
  const pureHue = `hsl(${hsv.h} 100% 50%)`;

  const saturationValueDrag = pointerDragHandlers((x, y) =>
    onChange((current) => ({ ...current, s: x, v: 1 - y })),
  );
  const hueDrag = pointerDragHandlers((x) => onChange((current) => ({ ...current, h: x * 360 })));

  const onSaturationValueKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const step = event.shiftKey ? 0.1 : 0.01;
    const delta = ARROW_DELTAS[event.key];
    if (!delta) return;
    event.preventDefault();
    onChange((current) => ({
      ...current,
      s: clampUnit(current.s + delta[0] * step),
      v: clampUnit(current.v + delta[1] * step),
    }));
  };

  const onHueKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const step = event.shiftKey ? 10 : 1;
    const delta = ARROW_DELTAS[event.key];
    if (!delta) return;
    event.preventDefault();
    const direction = delta[0] !== 0 ? delta[0] : delta[1];
    onChange((current) => ({
      ...current,
      h: Math.min(360, Math.max(0, current.h + direction * step)),
    }));
  };

  return (
    <div className="space-y-3">
      <div
        role="slider"
        tabIndex={0}
        aria-label={`${label} saturation and brightness`}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(hsv.s * 100)}
        aria-valuetext={`Saturation ${Math.round(hsv.s * 100)}%, brightness ${Math.round(hsv.v * 100)}%`}
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
        aria-valuenow={Math.round(hsv.h)}
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

const ARROW_DELTAS: Readonly<Record<string, readonly [number, number]>> = {
  ArrowLeft: [-1, 0],
  ArrowRight: [1, 0],
  ArrowUp: [0, 1],
  ArrowDown: [0, -1],
};

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
      event.currentTarget.setPointerCapture(event.pointerId);
      event.currentTarget.focus();
      report(event);
    },
    onPointerMove: (event: PointerEvent<HTMLElement>) => {
      if (event.currentTarget.hasPointerCapture(event.pointerId)) report(event);
    },
  };
}
