import { useRef, useState } from "react";
import {
  collapseExpandedComposerCursor,
  detectComposerTrigger,
  type ComposerTrigger,
} from "~/composer-logic";
import type { ComposerImageAttachment } from "~/composerDraftStore";
import type { ComposerPromptEditorHandle } from "~/components/ComposerPromptEditor";
import type { ComposerCommandItem } from "../ComposerCommandMenu";

/** Transient editor state; remains mounted when navigating between thread drafts. */
export function useComposerState(prompt: string) {
  const [isDragOverComposer, setIsDragOverComposer] = useState(false);
  const [isComposerFooterCompact, setIsComposerFooterCompact] = useState(false);
  const [isModelPickerOpen, setIsModelPickerOpen] = useState(false);
  const [composerCursor, setComposerCursor] = useState(() =>
    collapseExpandedComposerCursor(prompt, prompt.length),
  );
  const [composerTrigger, setComposerTrigger] = useState<ComposerTrigger | null>(() =>
    detectComposerTrigger(prompt, prompt.length),
  );
  const composerEditorRef = useRef<ComposerPromptEditorHandle>(null);
  const composerFileMentionInserterRef = useRef<(relativePath: string) => boolean>(() => false);
  const composerFormRef = useRef<HTMLFormElement>(null);
  const composerImagesRef = useRef<ComposerImageAttachment[]>([]);
  const composerSelectLockRef = useRef(false);
  const composerMenuOpenRef = useRef(false);
  const composerMenuItemsRef = useRef<ComposerCommandItem[]>([]);
  const activeComposerMenuItemRef = useRef<ComposerCommandItem | null>(null);
  const dragDepthRef = useRef(0);
  return {
    isDragOverComposer,
    setIsDragOverComposer,
    isComposerFooterCompact,
    setIsComposerFooterCompact,
    isModelPickerOpen,
    setIsModelPickerOpen,
    composerCursor,
    setComposerCursor,
    composerTrigger,
    setComposerTrigger,
    composerEditorRef,
    composerFileMentionInserterRef,
    composerFormRef,
    composerImagesRef,
    composerSelectLockRef,
    composerMenuOpenRef,
    composerMenuItemsRef,
    activeComposerMenuItemRef,
    dragDepthRef,
  };
}
