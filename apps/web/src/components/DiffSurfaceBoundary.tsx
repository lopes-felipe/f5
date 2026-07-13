import { lazy, Suspense, type ReactNode } from "react";

const LazyDiffWorkerPoolProvider = lazy(() =>
  import("./DiffWorkerPoolProvider").then((module) => ({
    default: module.DiffWorkerPoolProvider,
  })),
);

/** Loads the diff worker implementation only while a diff-capable surface is mounted. */
export function DiffSurfaceBoundary(props: {
  readonly children?: ReactNode;
  readonly fallback?: ReactNode;
}) {
  return (
    <Suspense fallback={props.fallback ?? null}>
      <LazyDiffWorkerPoolProvider>{props.children}</LazyDiffWorkerPoolProvider>
    </Suspense>
  );
}
