export interface KeyboardCompositionState {
  readonly isComposing: boolean;
  readonly keyCode: number;
}

export function isKeyboardEventComposing(
  event: KeyboardCompositionState,
  compositionFallback = false,
): boolean {
  return compositionFallback || event.isComposing || event.keyCode === 229;
}
