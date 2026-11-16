import React, { type ReactNode } from "react";

import { copyErrorReport, errorMessage } from "../../lib/errorReport";
import { Button } from "./button";

export interface SurfaceErrorFallbackProps {
  readonly error: unknown;
  readonly reset: () => void;
}

interface SurfaceErrorBoundaryProps {
  /** Names the surface in logs and copied error reports. */
  readonly name: string;
  /** A change to any key clears the error and renders the children again. */
  readonly resetKeys?: ReadonlyArray<unknown>;
  /** Static content, or a render function receiving the error and a reset callback. */
  readonly fallback?: ReactNode | ((props: SurfaceErrorFallbackProps) => ReactNode);
  readonly children?: ReactNode;
}

interface SurfaceErrorBoundaryState {
  readonly error: unknown;
  readonly hasError: boolean;
  readonly resetKeys: ReadonlyArray<unknown>;
}

const sameKeys = (left: ReadonlyArray<unknown>, right: ReadonlyArray<unknown>) =>
  left.length === right.length && left.every((value, index) => Object.is(value, right[index]));

/**
 * Contains a render failure to one surface (a panel tab, a code block, a
 * timeline row) so the rest of the app stays usable.
 */
export class SurfaceErrorBoundary extends React.Component<
  SurfaceErrorBoundaryProps,
  SurfaceErrorBoundaryState
> {
  constructor(props: SurfaceErrorBoundaryProps) {
    super(props);
    this.state = { error: null, hasError: false, resetKeys: props.resetKeys ?? [] };
  }

  static getDerivedStateFromError(error: unknown): Partial<SurfaceErrorBoundaryState> {
    return { error, hasError: true };
  }

  static getDerivedStateFromProps(
    props: SurfaceErrorBoundaryProps,
    state: SurfaceErrorBoundaryState,
  ): Partial<SurfaceErrorBoundaryState> | null {
    const resetKeys = props.resetKeys ?? [];
    if (sameKeys(resetKeys, state.resetKeys)) return null;
    return { error: null, hasError: false, resetKeys };
  }

  override componentDidCatch(error: unknown): void {
    console.error(`[SurfaceErrorBoundary:${this.props.name}]`, error);
  }

  private readonly reset = () => {
    this.setState({ error: null, hasError: false });
  };

  override render() {
    if (!this.state.hasError) return this.props.children;
    const { fallback, name } = this.props;
    if (typeof fallback === "function")
      return fallback({ error: this.state.error, reset: this.reset });
    if (fallback !== undefined) return fallback;
    return <SurfaceErrorFallback name={name} error={this.state.error} reset={this.reset} />;
  }
}

/** Compact in-place fallback with retry and a copyable report. */
export function SurfaceErrorFallback(props: {
  readonly name: string;
  readonly error: unknown;
  readonly reset: () => void;
  readonly title?: string;
  readonly actions?: ReactNode;
}) {
  return (
    <div
      role="alert"
      data-slot="surface-error"
      data-surface={props.name}
      className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 p-6 text-center"
    >
      <div className="max-w-md space-y-1">
        <p className="text-sm font-medium text-foreground">
          {props.title ?? "This view could not be displayed."}
        </p>
        <p className="text-xs break-words text-muted-foreground">{errorMessage(props.error)}</p>
      </div>
      <div className="flex flex-wrap justify-center gap-2">
        <Button size="xs" onClick={props.reset}>
          Try again
        </Button>
        <Button
          size="xs"
          variant="outline"
          onClick={() => copyErrorReport(props.error, `Surface: ${props.name}`)}
        >
          Copy error report
        </Button>
        {props.actions}
      </div>
    </div>
  );
}
