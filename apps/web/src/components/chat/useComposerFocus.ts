import { useCallback, type RefObject } from "react";

// Keep long-lived callbacks outside ChatView's render scope.
export function useComposerFocus(editorRef: RefObject<{ focusAtEnd(): void } | null>) {
  const focusComposer = useCallback(() => editorRef.current?.focusAtEnd(), [editorRef]);
  const scheduleComposerFocus = useCallback(() => {
    window.requestAnimationFrame(focusComposer);
  }, [focusComposer]);
  return { focusComposer, scheduleComposerFocus };
}
