export function previewLocationPromptOptions(
  origin: string,
  signal: AbortSignal,
): Electron.MessageBoxOptions {
  const displayOrigin = origin.length > 300 ? origin.slice(0, 300) + "…" : origin;
  return {
    type: "question",
    message: displayOrigin + " wants to know your location",
    buttons: ["Allow", "Block"],
    defaultId: 1,
    cancelId: 1,
    noLink: true,
    signal,
  };
}
