type Diagnostics = typeof import("./clientDiagnostics");

/** Reporting is optional; loading it must not delay stream subscriptions. */
export function startDeferredClientDiagnostics(
  deps: Parameters<Diagnostics["startClientDiagnostics"]>[0],
  load: () => Promise<Pick<Diagnostics, "startClientDiagnostics">> = () =>
    import("./clientDiagnostics"),
) {
  let disposed = false;
  let reporter: ReturnType<Diagnostics["startClientDiagnostics"]> | undefined;
  void load()
    .then((module) => {
      if (!disposed) reporter = module.startClientDiagnostics(deps);
    })
    .catch((error) => console.warn("Client diagnostics could not start", error));
  return {
    dispose() {
      if (disposed) return;
      disposed = true;
      reporter?.dispose();
    },
  };
}
