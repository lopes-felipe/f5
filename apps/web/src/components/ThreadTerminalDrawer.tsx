import { terminalClipboardAction, terminalRightClickPastes } from "../terminalClipboard";
import { useProfileState } from "../profileState";
import { FitAddon } from "@xterm/addon-fit";
import {
  ChevronDownIcon,
  Plus,
  SquareSplitHorizontal,
  TerminalSquare,
  Trash2,
  XIcon,
} from "lucide-react";
import { type ThreadId } from "@t3tools/contracts";
import { Terminal, type ITheme } from "@xterm/xterm";
import {
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { ScrollArea } from "~/components/ui/scroll-area";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { cn } from "~/lib/utils";
import { type TerminalContextSelection } from "~/lib/terminalContext";
import { openInPreferredEditor } from "../editorPreferences";
import { useFileNavigation } from "../fileNavigationContext";
import {
  extractWrappedTerminalLinks,
  isTerminalLinkActivation,
  resolvePathLinkTarget,
} from "../terminal-links";
import {
  isTerminalClearShortcut,
  terminalDeleteShortcutData,
  terminalNavigationShortcutData,
} from "../keybindings";
import {
  DEFAULT_THREAD_TERMINAL_HEIGHT,
  DEFAULT_THREAD_TERMINAL_ID,
  MAX_TERMINALS_PER_GROUP,
  type ThreadTerminalGroup,
} from "../types";
import { readNativeApi } from "~/nativeApi";
import { useCopyToClipboard } from "~/hooks/useCopyToClipboard";
import { useAppearanceSettings } from "~/hooks/useAppearanceSettings";
import { DEFAULT_MONO_FONT_STACK, fontFamilyStack } from "~/appearanceSettings";

const MIN_DRAWER_HEIGHT = 180;
const MAX_DRAWER_HEIGHT_RATIO = 0.75;
const MULTI_CLICK_SELECTION_ACTION_DELAY_MS = 260;

export const TERMINAL_SELECTION_CONTEXT_MENU_ITEMS = [
  { id: "copy", label: "Copy" },
  { id: "copy-and-add-to-chat", label: "Copy and add to chat" },
  { id: "add-to-chat", label: "Add to chat" },
] as const;

export function resolveTerminalSelectionContextMenuAction(actionId: string | null): {
  readonly copy: boolean;
  readonly addToChat: boolean;
} | null {
  switch (actionId) {
    case "copy":
      return { copy: true, addToChat: false };
    case "copy-and-add-to-chat":
      return { copy: true, addToChat: true };
    case "add-to-chat":
      return { copy: false, addToChat: true };
    default:
      return null;
  }
}

function maxDrawerHeight(): number {
  if (typeof window === "undefined") return DEFAULT_THREAD_TERMINAL_HEIGHT;
  return Math.max(MIN_DRAWER_HEIGHT, Math.floor(window.innerHeight * MAX_DRAWER_HEIGHT_RATIO));
}

function clampDrawerHeight(height: number): number {
  const safeHeight = Number.isFinite(height) ? height : DEFAULT_THREAD_TERMINAL_HEIGHT;
  const maxHeight = maxDrawerHeight();
  return Math.min(Math.max(Math.round(safeHeight), MIN_DRAWER_HEIGHT), maxHeight);
}

function writeSystemMessage(terminal: Terminal, message: string): void {
  terminal.write(`\r\n[terminal] ${message}\r\n`);
}

function terminalThemeFromApp(): ITheme {
  const isDark = document.documentElement.classList.contains("dark");
  const bodyStyles = getComputedStyle(document.body);
  const background =
    bodyStyles.backgroundColor || (isDark ? "rgb(14, 18, 24)" : "rgb(255, 255, 255)");
  const foreground = bodyStyles.color || (isDark ? "rgb(237, 241, 247)" : "rgb(28, 33, 41)");

  if (isDark) {
    return {
      background,
      foreground,
      cursor: "rgb(180, 203, 255)",
      selectionBackground: "rgba(180, 203, 255, 0.25)",
      scrollbarSliderBackground: "rgba(255, 255, 255, 0.1)",
      scrollbarSliderHoverBackground: "rgba(255, 255, 255, 0.18)",
      scrollbarSliderActiveBackground: "rgba(255, 255, 255, 0.22)",
      black: "rgb(24, 30, 38)",
      red: "rgb(255, 122, 142)",
      green: "rgb(134, 231, 149)",
      yellow: "rgb(244, 205, 114)",
      blue: "rgb(137, 190, 255)",
      magenta: "rgb(208, 176, 255)",
      cyan: "rgb(124, 232, 237)",
      white: "rgb(210, 218, 230)",
      brightBlack: "rgb(110, 120, 136)",
      brightRed: "rgb(255, 168, 180)",
      brightGreen: "rgb(176, 245, 186)",
      brightYellow: "rgb(255, 224, 149)",
      brightBlue: "rgb(174, 210, 255)",
      brightMagenta: "rgb(229, 203, 255)",
      brightCyan: "rgb(167, 244, 247)",
      brightWhite: "rgb(244, 247, 252)",
    };
  }

  return {
    background,
    foreground,
    cursor: "rgb(38, 56, 78)",
    selectionBackground: "rgba(37, 63, 99, 0.2)",
    scrollbarSliderBackground: "rgba(0, 0, 0, 0.15)",
    scrollbarSliderHoverBackground: "rgba(0, 0, 0, 0.25)",
    scrollbarSliderActiveBackground: "rgba(0, 0, 0, 0.3)",
    black: "rgb(44, 53, 66)",
    red: "rgb(191, 70, 87)",
    green: "rgb(60, 126, 86)",
    yellow: "rgb(146, 112, 35)",
    blue: "rgb(72, 102, 163)",
    magenta: "rgb(132, 86, 149)",
    cyan: "rgb(53, 127, 141)",
    white: "rgb(210, 215, 223)",
    brightBlack: "rgb(112, 123, 140)",
    brightRed: "rgb(212, 95, 112)",
    brightGreen: "rgb(85, 148, 111)",
    brightYellow: "rgb(173, 133, 45)",
    brightBlue: "rgb(91, 124, 194)",
    brightMagenta: "rgb(153, 107, 172)",
    brightCyan: "rgb(70, 149, 164)",
    brightWhite: "rgb(236, 240, 246)",
  };
}

function getTerminalSelectionRect(mountElement: HTMLElement): DOMRect | null {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0 || selection.isCollapsed) {
    return null;
  }

  const range = selection.getRangeAt(0);
  const commonAncestor = range.commonAncestorContainer;
  const selectionRoot =
    commonAncestor instanceof Element ? commonAncestor : commonAncestor.parentElement;
  if (!(selectionRoot instanceof Element) || !mountElement.contains(selectionRoot)) {
    return null;
  }

  const rects = Array.from(range.getClientRects()).filter(
    (rect) => rect.width > 0 || rect.height > 0,
  );
  if (rects.length > 0) {
    return rects[rects.length - 1] ?? null;
  }

  const boundingRect = range.getBoundingClientRect();
  return boundingRect.width > 0 || boundingRect.height > 0 ? boundingRect : null;
}

export function resolveTerminalSelectionActionPosition(options: {
  bounds: { left: number; top: number; width: number; height: number };
  selectionRect: { right: number; bottom: number } | null;
  pointer: { x: number; y: number } | null;
  viewport?: { width: number; height: number } | null;
}): { x: number; y: number } {
  const { bounds, selectionRect, pointer, viewport } = options;
  const viewportWidth =
    viewport?.width ??
    (typeof window === "undefined" ? bounds.left + bounds.width + 8 : window.innerWidth);
  const viewportHeight =
    viewport?.height ??
    (typeof window === "undefined" ? bounds.top + bounds.height + 8 : window.innerHeight);
  const drawerLeft = Math.round(bounds.left);
  const drawerTop = Math.round(bounds.top);
  const drawerRight = Math.round(bounds.left + bounds.width);
  const drawerBottom = Math.round(bounds.top + bounds.height);
  const preferredX =
    selectionRect !== null
      ? Math.round(selectionRect.right)
      : pointer === null
        ? Math.round(bounds.left + bounds.width - 140)
        : Math.max(drawerLeft, Math.min(Math.round(pointer.x), drawerRight));
  const preferredY =
    selectionRect !== null
      ? Math.round(selectionRect.bottom + 4)
      : pointer === null
        ? Math.round(bounds.top + 12)
        : Math.max(drawerTop, Math.min(Math.round(pointer.y), drawerBottom));
  return {
    x: Math.max(8, Math.min(preferredX, Math.max(viewportWidth - 8, 8))),
    y: Math.max(8, Math.min(preferredY, Math.max(viewportHeight - 8, 8))),
  };
}

/** Roving focus in the terminal tab strip: wraps at both ends; null for other keys. */
export function terminalTabIndexForKey(key: string, index: number, count: number): number | null {
  if (count <= 0) return null;
  switch (key) {
    case "ArrowRight":
      return (index + 1) % count;
    case "ArrowLeft":
      return (index - 1 + count) % count;
    case "Home":
      return 0;
    case "End":
      return count - 1;
    default:
      return null;
  }
}

export function terminalSelectionActionDelayForClickCount(clickCount: number): number {
  return clickCount >= 2 ? MULTI_CLICK_SELECTION_ACTION_DELAY_MS : 0;
}

export function shouldHandleTerminalSelectionMouseUp(
  selectionGestureActive: boolean,
  button: number,
): boolean {
  return selectionGestureActive && button === 0;
}

export function applyTerminalFontAppearance(
  terminal: Pick<Terminal, "options">,
  fitAddon: Pick<FitAddon, "fit">,
  appearance: { readonly fontFamily: string; readonly fontSize: number },
): void {
  terminal.options.fontFamily = appearance.fontFamily;
  terminal.options.fontSize = appearance.fontSize;
  fitAddon.fit();
}

interface TerminalViewportProps {
  threadId: ThreadId;
  terminalId: string;
  terminalLabel: string;
  cwd: string;
  runtimeEnv?: Record<string, string>;
  onSessionExited: () => void;
  onAddTerminalContext: (selection: TerminalContextSelection) => void;
  focusRequestId: number;
  autoFocus: boolean;
  resizeEpoch: number;
  drawerHeight: number;
  resolvedTheme: "light" | "dark";
  themePaletteRevision: string;
  monoFontFamily: string;
  terminalFontSize: number;
}

function TerminalViewport({
  threadId,
  terminalId,
  terminalLabel,
  cwd,
  runtimeEnv,
  onSessionExited,
  onAddTerminalContext,
  focusRequestId,
  autoFocus,
  resizeEpoch,
  drawerHeight,
  resolvedTheme,
  themePaletteRevision,
  monoFontFamily,
  terminalFontSize,
}: TerminalViewportProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const onSessionExitedRef = useRef(onSessionExited);
  const onAddTerminalContextRef = useRef(onAddTerminalContext);
  const terminalLabelRef = useRef(terminalLabel);
  const handleFileNavigation = useFileNavigation();
  const handleFileNavigationRef = useRef(handleFileNavigation);
  const hasHandledExitRef = useRef(false);
  const selectionPointerRef = useRef<{ x: number; y: number } | null>(null);
  const selectionGestureActiveRef = useRef(false);
  const selectionActionRequestIdRef = useRef(0);
  const selectionActionOpenRef = useRef(false);
  const selectionActionTimerRef = useRef<number | null>(null);
  const terminalFontFamily = fontFamilyStack(monoFontFamily, DEFAULT_MONO_FONT_STACK);
  const terminalFontAppearanceRef = useRef({
    fontFamily: terminalFontFamily,
    fontSize: terminalFontSize,
  });
  terminalFontAppearanceRef.current = {
    fontFamily: terminalFontFamily,
    fontSize: terminalFontSize,
  };
  const { copyToClipboard } = useCopyToClipboard({
    onError: (error) => {
      const activeTerminal = terminalRef.current;
      if (activeTerminal) {
        writeSystemMessage(activeTerminal, error.message);
      }
    },
  });

  useEffect(() => {
    onSessionExitedRef.current = onSessionExited;
  }, [onSessionExited]);

  useEffect(() => {
    onAddTerminalContextRef.current = onAddTerminalContext;
  }, [onAddTerminalContext]);

  useEffect(() => {
    terminalLabelRef.current = terminalLabel;
  }, [terminalLabel]);

  useEffect(() => {
    handleFileNavigationRef.current = handleFileNavigation;
  }, [handleFileNavigation]);

  useEffect(() => {
    const mount = containerRef.current;
    if (!mount) return;

    let disposed = false;

    const fitAddon = new FitAddon();
    const initialFontAppearance = terminalFontAppearanceRef.current;
    const terminal = new Terminal({
      cursorBlink: true,
      lineHeight: 1.2,
      fontSize: initialFontAppearance.fontSize,
      scrollback: 5_000,
      fontFamily: initialFontAppearance.fontFamily,
      theme: terminalThemeFromApp(),
    });
    terminal.loadAddon(fitAddon);
    terminal.open(mount);
    fitAddon.fit();

    terminalRef.current = terminal;
    fitAddonRef.current = fitAddon;

    const api = readNativeApi();
    if (!api) return;

    const clearSelectionAction = () => {
      selectionActionRequestIdRef.current += 1;
      if (selectionActionTimerRef.current !== null) {
        window.clearTimeout(selectionActionTimerRef.current);
        selectionActionTimerRef.current = null;
      }
    };

    const readSelectionAction = (): {
      position: { x: number; y: number };
      selection: TerminalContextSelection;
    } | null => {
      const activeTerminal = terminalRef.current;
      const mountElement = containerRef.current;
      if (!activeTerminal || !mountElement || !activeTerminal.hasSelection()) {
        return null;
      }
      const selectionText = activeTerminal.getSelection();
      const selectionPosition = activeTerminal.getSelectionPosition();
      const normalizedText = selectionText.replace(/\r\n/g, "\n").replace(/^\n+|\n+$/g, "");
      if (!selectionPosition || normalizedText.length === 0) {
        return null;
      }
      const lineStart = selectionPosition.start.y + 1;
      const lineCount = normalizedText.split("\n").length;
      const lineEnd = Math.max(lineStart, lineStart + lineCount - 1);
      const bounds = mountElement.getBoundingClientRect();
      const selectionRect = getTerminalSelectionRect(mountElement);
      const position = resolveTerminalSelectionActionPosition({
        bounds,
        selectionRect:
          selectionRect === null
            ? null
            : { right: selectionRect.right, bottom: selectionRect.bottom },
        pointer: selectionPointerRef.current,
      });
      return {
        position,
        selection: {
          terminalId,
          terminalLabel: terminalLabelRef.current,
          lineStart,
          lineEnd,
          text: normalizedText,
        },
      };
    };

    const showSelectionAction = async () => {
      if (selectionActionOpenRef.current) {
        return;
      }
      const nextAction = readSelectionAction();
      if (!nextAction) {
        clearSelectionAction();
        return;
      }
      const requestId = ++selectionActionRequestIdRef.current;
      selectionActionOpenRef.current = true;
      try {
        const clicked = await api.contextMenu.show(
          [...TERMINAL_SELECTION_CONTEXT_MENU_ITEMS],
          nextAction.position,
        );
        const action = resolveTerminalSelectionContextMenuAction(clicked);
        if (requestId !== selectionActionRequestIdRef.current || action === null) {
          return;
        }
        if (action.copy) {
          copyToClipboard(nextAction.selection.text, undefined);
        }
        if (action.addToChat) {
          onAddTerminalContextRef.current(nextAction.selection);
        }
        terminalRef.current?.clearSelection();
        terminalRef.current?.focus();
      } finally {
        selectionActionOpenRef.current = false;
      }
    };

    const sendTerminalInput = async (data: string, fallbackError: string) => {
      const activeTerminal = terminalRef.current;
      if (!activeTerminal) return;
      try {
        await api.terminal.write({ threadId, terminalId, data });
      } catch (error) {
        writeSystemMessage(activeTerminal, error instanceof Error ? error.message : fallbackError);
      }
    };

    const pasteClipboard = async (source: "clipboard" | "selection" = "clipboard") => {
      try {
        const text = window.desktopBridge?.readClipboardText
          ? await window.desktopBridge.readClipboardText(source)
          : source === "clipboard"
            ? await navigator.clipboard.readText()
            : "";
        if (!disposed && terminalRef.current === terminal) terminal.paste(text);
      } catch (error) {
        if (!disposed)
          writeSystemMessage(
            terminal,
            error instanceof Error ? error.message : "Unable to read clipboard",
          );
      }
    };
    terminal.attachCustomKeyEventHandler((event) => {
      const clipboardAction = terminalClipboardAction(
        event,
        terminal.hasSelection(),
        navigator.platform,
      );
      if (clipboardAction) {
        event.preventDefault();
        event.stopPropagation();
        if (clipboardAction === "copy") {
          copyToClipboard(terminal.getSelection(), undefined);
          terminal.clearSelection();
        } else void pasteClipboard();
        return false;
      }
      const navigationData = terminalNavigationShortcutData(event);
      if (navigationData !== null) {
        event.preventDefault();
        event.stopPropagation();
        void sendTerminalInput(navigationData, "Failed to move cursor");
        return false;
      }

      const deleteData = terminalDeleteShortcutData(event);
      if (deleteData !== null) {
        event.preventDefault();
        event.stopPropagation();
        void sendTerminalInput(deleteData, "Failed to delete terminal input");
        return false;
      }

      if (!isTerminalClearShortcut(event)) return true;
      event.preventDefault();
      event.stopPropagation();
      void sendTerminalInput("\u000c", "Failed to clear terminal");
      return false;
    });

    const terminalLinksDisposable = terminal.registerLinkProvider({
      provideLinks: (bufferLineNumber, callback) => {
        const activeTerminal = terminalRef.current;
        if (!activeTerminal) {
          callback(undefined);
          return;
        }

        // xterm uses 1-based line numbers for provideLinks; buffer.getLine is
        // 0-based. Wrapped-line helpers consume 0-based rows throughout.
        const zeroBasedLine = bufferLineNumber - 1;
        const matches = extractWrappedTerminalLinks(
          activeTerminal.buffer.active,
          zeroBasedLine,
          activeTerminal.cols,
        );
        if (matches.length === 0) {
          callback(undefined);
          return;
        }

        callback(
          matches.map((match) => ({
            text: match.text,
            range: {
              // Convert 0-based (row, col) to xterm's 1-based coords. The
              // helper returns `endX` as exclusive, matching xterm's
              // inclusive end-in-1-based convention (end_exclusive_0 === end_inclusive_1).
              start: { x: match.physical.startX + 1, y: match.physical.startY + 1 },
              end: { x: match.physical.endX, y: match.physical.endY + 1 },
            },
            activate: (event: MouseEvent) => {
              if (!isTerminalLinkActivation(event)) return;

              const latestTerminal = terminalRef.current;
              if (!latestTerminal) return;

              if (match.kind === "url") {
                void api.shell.openExternal(match.text).catch((error) => {
                  writeSystemMessage(
                    latestTerminal,
                    error instanceof Error ? error.message : "Unable to open link",
                  );
                });
                return;
              }

              const target = resolvePathLinkTarget(match.text, cwd);
              if (handleFileNavigationRef.current(target)) {
                return;
              }
              void openInPreferredEditor(api, target).catch((error) => {
                writeSystemMessage(
                  latestTerminal,
                  error instanceof Error ? error.message : "Unable to open path",
                );
              });
            },
          })),
        );
      },
    });

    const inputDisposable = terminal.onData((data) => {
      void api.terminal
        .write({ threadId, terminalId, data })
        .catch((err) =>
          writeSystemMessage(
            terminal,
            err instanceof Error ? err.message : "Terminal write failed",
          ),
        );
    });

    const selectionDisposable = terminal.onSelectionChange(() => {
      if (terminalRef.current?.hasSelection()) {
        return;
      }
      clearSelectionAction();
    });

    const handleMouseUp = (event: MouseEvent) => {
      const shouldHandle = shouldHandleTerminalSelectionMouseUp(
        selectionGestureActiveRef.current,
        event.button,
      );
      selectionGestureActiveRef.current = false;
      if (!shouldHandle) {
        return;
      }
      selectionPointerRef.current = { x: event.clientX, y: event.clientY };
      const delay = terminalSelectionActionDelayForClickCount(event.detail);
      selectionActionTimerRef.current = window.setTimeout(() => {
        selectionActionTimerRef.current = null;
        window.requestAnimationFrame(() => {
          void showSelectionAction();
        });
      }, delay);
    };
    const handlePointerDown = (event: PointerEvent) => {
      if (
        event.button === 1 &&
        /linux/i.test(navigator.platform) &&
        window.desktopBridge?.readClipboardText
      ) {
        event.preventDefault();
        void pasteClipboard("selection");
      }
      clearSelectionAction();
      selectionGestureActiveRef.current = event.button === 0;
    };
    const handleContextMenu = (event: MouseEvent) => {
      event.preventDefault();
      if (terminal.hasSelection()) void showSelectionAction();
      else if (terminalRightClickPastes(navigator.platform)) void pasteClipboard();
    };
    mount.addEventListener("contextmenu", handleContextMenu);
    window.addEventListener("mouseup", handleMouseUp);
    mount.addEventListener("pointerdown", handlePointerDown);

    const openTerminal = async () => {
      try {
        const activeTerminal = terminalRef.current;
        const activeFitAddon = fitAddonRef.current;
        if (!activeTerminal || !activeFitAddon) return;
        activeFitAddon.fit();
        const snapshot = await api.terminal.open({
          threadId,
          terminalId,
          cwd,
          cols: activeTerminal.cols,
          rows: activeTerminal.rows,
          ...(runtimeEnv ? { env: runtimeEnv } : {}),
        });
        if (disposed) return;
        activeTerminal.write("\u001bc");
        if (snapshot.history.length > 0) {
          activeTerminal.write(snapshot.history);
        }
        if (autoFocus) {
          window.requestAnimationFrame(() => {
            activeTerminal.focus();
          });
        }
      } catch (err) {
        if (disposed) return;
        writeSystemMessage(
          terminal,
          err instanceof Error ? err.message : "Failed to open terminal",
        );
      }
    };

    const unsubscribe = api?.terminal.onEvent((event) => {
      if (event.threadId !== threadId || event.terminalId !== terminalId) return;
      const activeTerminal = terminalRef.current;
      if (!activeTerminal) return;

      if (event.type === "output") {
        activeTerminal.write(event.data);
        clearSelectionAction();
        return;
      }

      if (event.type === "started" || event.type === "restarted") {
        hasHandledExitRef.current = false;
        clearSelectionAction();
        activeTerminal.write("\u001bc");
        if (event.snapshot.history.length > 0) {
          activeTerminal.write(event.snapshot.history);
        }
        return;
      }

      if (event.type === "cleared") {
        clearSelectionAction();
        activeTerminal.clear();
        activeTerminal.write("\u001bc");
        return;
      }

      if (event.type === "error") {
        writeSystemMessage(activeTerminal, event.message);
        return;
      }

      if (event.type === "exited") {
        const details = [
          typeof event.exitCode === "number" ? `code ${event.exitCode}` : null,
          typeof event.exitSignal === "number" ? `signal ${event.exitSignal}` : null,
        ]
          .filter((value): value is string => value !== null)
          .join(", ");
        writeSystemMessage(
          activeTerminal,
          details.length > 0 ? `Process exited (${details})` : "Process exited",
        );
        if (hasHandledExitRef.current) {
          return;
        }
        hasHandledExitRef.current = true;
        window.setTimeout(() => {
          if (!hasHandledExitRef.current) {
            return;
          }
          onSessionExitedRef.current();
        }, 0);
      }
    });

    const fitTimer = window.setTimeout(() => {
      const activeTerminal = terminalRef.current;
      const activeFitAddon = fitAddonRef.current;
      if (!activeTerminal || !activeFitAddon) return;
      const wasAtBottom =
        activeTerminal.buffer.active.viewportY >= activeTerminal.buffer.active.baseY;
      activeFitAddon.fit();
      if (wasAtBottom) {
        activeTerminal.scrollToBottom();
      }
      void api.terminal
        .resize({
          threadId,
          terminalId,
          cols: activeTerminal.cols,
          rows: activeTerminal.rows,
        })
        .catch(() => undefined);
    }, 30);
    void openTerminal();

    return () => {
      disposed = true;
      window.clearTimeout(fitTimer);
      unsubscribe();
      inputDisposable.dispose();
      selectionDisposable.dispose();
      terminalLinksDisposable.dispose();
      if (selectionActionTimerRef.current !== null) {
        window.clearTimeout(selectionActionTimerRef.current);
      }
      window.removeEventListener("mouseup", handleMouseUp);
      mount.removeEventListener("pointerdown", handlePointerDown);
      mount.removeEventListener("contextmenu", handleContextMenu);
      terminalRef.current = null;
      fitAddonRef.current = null;
      terminal.dispose();
    };
    // autoFocus is intentionally omitted;
    // it is only read at mount time and must not trigger terminal teardown/recreation.
  }, [cwd, runtimeEnv, terminalId, threadId]);

  useEffect(() => {
    const terminal = terminalRef.current;
    if (!terminal) return;
    terminal.options.theme = terminalThemeFromApp();
    terminal.refresh(0, terminal.rows - 1);
  }, [resolvedTheme, themePaletteRevision]);

  useEffect(() => {
    const api = readNativeApi();
    const terminal = terminalRef.current;
    const fitAddon = fitAddonRef.current;
    if (!api || !terminal || !fitAddon) return;

    const wasAtBottom = terminal.buffer.active.viewportY >= terminal.buffer.active.baseY;
    const frame = window.requestAnimationFrame(() => {
      applyTerminalFontAppearance(terminal, fitAddon, {
        fontFamily: terminalFontFamily,
        fontSize: terminalFontSize,
      });
      if (wasAtBottom) terminal.scrollToBottom();
      void api.terminal
        .resize({
          threadId,
          terminalId,
          cols: terminal.cols,
          rows: terminal.rows,
        })
        .catch(() => undefined);
    });
    return () => window.cancelAnimationFrame(frame);
  }, [terminalFontFamily, terminalFontSize, terminalId, threadId]);

  useEffect(() => {
    if (!autoFocus) return;
    const terminal = terminalRef.current;
    if (!terminal) return;
    const frame = window.requestAnimationFrame(() => {
      terminal.focus();
    });
    return () => {
      window.cancelAnimationFrame(frame);
    };
  }, [autoFocus, focusRequestId]);

  useEffect(() => {
    const api = readNativeApi();
    const terminal = terminalRef.current;
    const fitAddon = fitAddonRef.current;
    if (!api || !terminal || !fitAddon) return;
    const wasAtBottom = terminal.buffer.active.viewportY >= terminal.buffer.active.baseY;
    const frame = window.requestAnimationFrame(() => {
      fitAddon.fit();
      if (wasAtBottom) {
        terminal.scrollToBottom();
      }
      void api.terminal
        .resize({
          threadId,
          terminalId,
          cols: terminal.cols,
          rows: terminal.rows,
        })
        .catch(() => undefined);
    });
    return () => {
      window.cancelAnimationFrame(frame);
    };
  }, [drawerHeight, resizeEpoch, terminalId, threadId]);
  return <div ref={containerRef} className="relative h-full w-full overflow-hidden rounded" />;
}

interface ThreadTerminalDrawerProps {
  threadId: ThreadId;
  cwd: string;
  runtimeEnv?: Record<string, string>;
  height: number;
  terminalIds: string[];
  activeTerminalId: string;
  terminalGroups: ThreadTerminalGroup[];
  activeTerminalGroupId: string;
  focusRequestId: number;
  onSplitTerminal: () => void;
  onNewTerminal: () => void;
  splitShortcutLabel?: string | undefined;
  newShortcutLabel?: string | undefined;
  closeShortcutLabel?: string | undefined;
  onActiveTerminalChange: (terminalId: string) => void;
  onCloseTerminal: (terminalId: string) => void;
  onHeightChange: (height: number) => void;
  onAddTerminalContext: (selection: TerminalContextSelection) => void;
  /** Hides the drawer without closing its terminals. */
  onHideTerminal?: (() => void) | undefined;
  hideShortcutLabel?: string | undefined;
  resolvedTheme: "light" | "dark";
  themePaletteRevision: string;
}

interface TerminalActionButtonProps {
  label: string;
  disabled?: boolean | undefined;
  onClick: () => void;
  children: ReactNode;
}

function TerminalActionButton({
  label,
  disabled = false,
  onClick,
  children,
}: TerminalActionButtonProps) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            type="button"
            size="icon-sm"
            variant="ghost"
            aria-label={label}
            aria-disabled={disabled || undefined}
            className={cn(
              "text-muted-foreground hover:text-foreground",
              disabled && "cursor-not-allowed opacity-50 hover:bg-transparent",
            )}
            onClick={disabled ? undefined : onClick}
          />
        }
      >
        {children}
      </TooltipTrigger>
      <TooltipPopup side="bottom">{label}</TooltipPopup>
    </Tooltip>
  );
}

function TerminalDrawerActions(props: {
  splitLabel: string;
  splitDisabled: boolean;
  onSplit: () => void;
  newLabel: string;
  onNew: () => void;
  closeLabel: string;
  onClose: () => void;
  hideLabel: string;
  onHide: (() => void) | undefined;
}) {
  return (
    <>
      <TerminalActionButton
        label={props.splitLabel}
        disabled={props.splitDisabled}
        onClick={props.onSplit}
      >
        <SquareSplitHorizontal className="size-4" />
      </TerminalActionButton>
      <TerminalActionButton label={props.newLabel} onClick={props.onNew}>
        <Plus className="size-4" />
      </TerminalActionButton>
      <TerminalActionButton label={props.closeLabel} onClick={props.onClose}>
        <Trash2 className="size-4" />
      </TerminalActionButton>
      {props.onHide ? (
        <TerminalActionButton label={props.hideLabel} onClick={props.onHide}>
          <ChevronDownIcon className="size-4" />
        </TerminalActionButton>
      ) : null}
    </>
  );
}

export default function ThreadTerminalDrawer({
  threadId,
  cwd,
  runtimeEnv,
  height,
  terminalIds,
  activeTerminalId,
  terminalGroups,
  activeTerminalGroupId,
  focusRequestId,
  onSplitTerminal,
  onNewTerminal,
  splitShortcutLabel,
  newShortcutLabel,
  closeShortcutLabel,
  onActiveTerminalChange,
  onCloseTerminal,
  onHeightChange,
  onAddTerminalContext,
  onHideTerminal,
  hideShortcutLabel,
  resolvedTheme,
  themePaletteRevision,
}: ThreadTerminalDrawerProps) {
  const profileName = useProfileState((state) => state.active?.name);
  const appearance = useAppearanceSettings();
  const [drawerHeight, setDrawerHeight] = useState(() => clampDrawerHeight(height));
  const [resizeEpoch, setResizeEpoch] = useState(0);
  const drawerHeightRef = useRef(drawerHeight);
  const lastSyncedHeightRef = useRef(clampDrawerHeight(height));
  const onHeightChangeRef = useRef(onHeightChange);
  const resizeStateRef = useRef<{
    pointerId: number;
    startY: number;
    startHeight: number;
  } | null>(null);
  const didResizeDuringDragRef = useRef(false);

  const normalizedTerminalIds = useMemo(() => {
    const cleaned = [...new Set(terminalIds.map((id) => id.trim()).filter((id) => id.length > 0))];
    return cleaned.length > 0 ? cleaned : [DEFAULT_THREAD_TERMINAL_ID];
  }, [terminalIds]);

  const resolvedActiveTerminalId = normalizedTerminalIds.includes(activeTerminalId)
    ? activeTerminalId
    : (normalizedTerminalIds[0] ?? DEFAULT_THREAD_TERMINAL_ID);

  const resolvedTerminalGroups = useMemo(() => {
    const validTerminalIdSet = new Set(normalizedTerminalIds);
    const assignedTerminalIds = new Set<string>();
    const usedGroupIds = new Set<string>();
    const nextGroups: ThreadTerminalGroup[] = [];

    const assignUniqueGroupId = (groupId: string): string => {
      if (!usedGroupIds.has(groupId)) {
        usedGroupIds.add(groupId);
        return groupId;
      }
      let suffix = 2;
      while (usedGroupIds.has(`${groupId}-${suffix}`)) {
        suffix += 1;
      }
      const uniqueGroupId = `${groupId}-${suffix}`;
      usedGroupIds.add(uniqueGroupId);
      return uniqueGroupId;
    };

    for (const terminalGroup of terminalGroups) {
      const nextTerminalIds = [
        ...new Set(terminalGroup.terminalIds.map((id) => id.trim()).filter((id) => id.length > 0)),
      ].filter((terminalId) => {
        if (!validTerminalIdSet.has(terminalId)) return false;
        if (assignedTerminalIds.has(terminalId)) return false;
        return true;
      });
      if (nextTerminalIds.length === 0) continue;

      for (const terminalId of nextTerminalIds) {
        assignedTerminalIds.add(terminalId);
      }

      const baseGroupId =
        terminalGroup.id.trim().length > 0
          ? terminalGroup.id.trim()
          : `group-${nextTerminalIds[0] ?? DEFAULT_THREAD_TERMINAL_ID}`;
      nextGroups.push({
        id: assignUniqueGroupId(baseGroupId),
        terminalIds: nextTerminalIds,
      });
    }

    for (const terminalId of normalizedTerminalIds) {
      if (assignedTerminalIds.has(terminalId)) continue;
      nextGroups.push({
        id: assignUniqueGroupId(`group-${terminalId}`),
        terminalIds: [terminalId],
      });
    }

    if (nextGroups.length > 0) {
      return nextGroups;
    }

    return [
      {
        id: `group-${resolvedActiveTerminalId}`,
        terminalIds: [resolvedActiveTerminalId],
      },
    ];
  }, [normalizedTerminalIds, resolvedActiveTerminalId, terminalGroups]);

  const resolvedActiveGroupIndex = useMemo(() => {
    const indexById = resolvedTerminalGroups.findIndex(
      (terminalGroup) => terminalGroup.id === activeTerminalGroupId,
    );
    if (indexById >= 0) return indexById;
    const indexByTerminal = resolvedTerminalGroups.findIndex((terminalGroup) =>
      terminalGroup.terminalIds.includes(resolvedActiveTerminalId),
    );
    return indexByTerminal >= 0 ? indexByTerminal : 0;
  }, [activeTerminalGroupId, resolvedActiveTerminalId, resolvedTerminalGroups]);

  const visibleTerminalIds = resolvedTerminalGroups[resolvedActiveGroupIndex]?.terminalIds ?? [
    resolvedActiveTerminalId,
  ];
  const hasTerminalTabs = normalizedTerminalIds.length > 1;
  const terminalTabIdPrefix = useId();
  const terminalTabId = (terminalId: string) => `${terminalTabIdPrefix}-tab-${terminalId}`;
  const terminalPanelId = `${terminalTabIdPrefix}-panel`;
  // Tabs pattern with manual activation: arrows, Home and End move focus;
  // Enter or Space (the button's click) activates, which focuses the
  // terminal. Delete closes the focused tab, standing in for its close
  // button, which is pointer-only.
  const onTerminalTabKeyDown = (
    event: ReactKeyboardEvent<HTMLButtonElement>,
    terminalId: string,
  ) => {
    const orderedIds = resolvedTerminalGroups.flatMap((group) => group.terminalIds);
    const index = orderedIds.indexOf(terminalId);
    if (index < 0) return;
    if (event.key === "Delete") {
      event.preventDefault();
      onCloseTerminal(terminalId);
      return;
    }
    const nextIndex = terminalTabIndexForKey(event.key, index, orderedIds.length);
    if (nextIndex === null) return;
    event.preventDefault();
    const nextId = orderedIds[nextIndex];
    if (nextId) document.getElementById(terminalTabId(nextId))?.focus();
  };
  const isSplitView = visibleTerminalIds.length > 1;
  const hasReachedSplitLimit = visibleTerminalIds.length >= MAX_TERMINALS_PER_GROUP;
  const terminalLabelById = useMemo(
    () =>
      new Map(
        normalizedTerminalIds.map((terminalId, index) => [terminalId, `Terminal ${index + 1}`]),
      ),
    [normalizedTerminalIds],
  );
  const splitTerminalActionLabel = hasReachedSplitLimit
    ? `Split Terminal (max ${MAX_TERMINALS_PER_GROUP} per group)`
    : splitShortcutLabel
      ? `Split Terminal (${splitShortcutLabel})`
      : "Split Terminal";
  const newTerminalActionLabel = newShortcutLabel
    ? `New Terminal (${newShortcutLabel})`
    : "New Terminal";
  const closeTerminalActionLabel = closeShortcutLabel
    ? `Close Terminal (${closeShortcutLabel})`
    : "Close Terminal";
  const hideTerminalActionLabel = hideShortcutLabel
    ? `Hide terminal (${hideShortcutLabel})`
    : "Hide terminal";
  const onSplitTerminalAction = useCallback(() => {
    if (hasReachedSplitLimit) return;
    onSplitTerminal();
  }, [hasReachedSplitLimit, onSplitTerminal]);
  const onNewTerminalAction = useCallback(() => {
    onNewTerminal();
  }, [onNewTerminal]);

  useEffect(() => {
    onHeightChangeRef.current = onHeightChange;
  }, [onHeightChange]);

  useEffect(() => {
    drawerHeightRef.current = drawerHeight;
  }, [drawerHeight]);

  const syncHeight = useCallback((nextHeight: number) => {
    const clampedHeight = clampDrawerHeight(nextHeight);
    if (lastSyncedHeightRef.current === clampedHeight) return;
    lastSyncedHeightRef.current = clampedHeight;
    onHeightChangeRef.current(clampedHeight);
  }, []);

  useEffect(() => {
    const clampedHeight = clampDrawerHeight(height);
    setDrawerHeight(clampedHeight);
    drawerHeightRef.current = clampedHeight;
    lastSyncedHeightRef.current = clampedHeight;
  }, [height, threadId]);

  const handleResizePointerDown = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    didResizeDuringDragRef.current = false;
    resizeStateRef.current = {
      pointerId: event.pointerId,
      startY: event.clientY,
      startHeight: drawerHeightRef.current,
    };
  }, []);

  const handleResizePointerMove = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const resizeState = resizeStateRef.current;
    if (!resizeState || resizeState.pointerId !== event.pointerId) return;
    event.preventDefault();
    const clampedHeight = clampDrawerHeight(
      resizeState.startHeight + (resizeState.startY - event.clientY),
    );
    if (clampedHeight === drawerHeightRef.current) {
      return;
    }
    didResizeDuringDragRef.current = true;
    drawerHeightRef.current = clampedHeight;
    setDrawerHeight(clampedHeight);
  }, []);

  const handleResizePointerEnd = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      const resizeState = resizeStateRef.current;
      if (!resizeState || resizeState.pointerId !== event.pointerId) return;
      resizeStateRef.current = null;
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
      if (!didResizeDuringDragRef.current) {
        return;
      }
      syncHeight(drawerHeightRef.current);
      setResizeEpoch((value) => value + 1);
    },
    [syncHeight],
  );

  useEffect(() => {
    const onWindowResize = () => {
      const clampedHeight = clampDrawerHeight(drawerHeightRef.current);
      const changed = clampedHeight !== drawerHeightRef.current;
      if (changed) {
        setDrawerHeight(clampedHeight);
        drawerHeightRef.current = clampedHeight;
      }
      if (!resizeStateRef.current) {
        syncHeight(clampedHeight);
      }
      setResizeEpoch((value) => value + 1);
    };
    window.addEventListener("resize", onWindowResize);
    return () => {
      window.removeEventListener("resize", onWindowResize);
    };
  }, [syncHeight]);

  useEffect(() => {
    return () => {
      syncHeight(drawerHeightRef.current);
    };
  }, [syncHeight]);

  return (
    <aside
      aria-label={profileName ? `Terminal - ${profileName}` : "Terminal"}
      className="thread-terminal-drawer relative flex min-w-0 shrink-0 flex-col overflow-hidden border-t border-border bg-background"
      style={{ height: `${drawerHeight}px` }}
    >
      {/* 6px hit area, 1px visual line on hover/drag. */}
      <div
        aria-hidden="true"
        className="group/resize absolute inset-x-0 top-0 z-20 h-1.5 cursor-row-resize"
        onPointerDown={handleResizePointerDown}
        onPointerMove={handleResizePointerMove}
        onPointerUp={handleResizePointerEnd}
        onPointerCancel={handleResizePointerEnd}
      >
        <div className="pointer-events-none absolute inset-x-0 top-0 h-px transition-colors duration-(--duration-fast) group-hover/resize:bg-ring group-active/resize:bg-ring" />
      </div>

      {hasTerminalTabs ? (
        <div className="flex h-8 shrink-0 items-center gap-1 border-b border-border ps-1.5 pe-0.5">
          {profileName ? (
            <Badge variant="outline" size="sm" className="shrink-0">
              {profileName}
            </Badge>
          ) : null}
          <ScrollArea scrollFade className="min-w-0 flex-1 rounded-none">
            <div
              role="tablist"
              aria-label="Terminals"
              className="flex h-8 w-max items-center gap-1"
            >
              {resolvedTerminalGroups.map((terminalGroup) => (
                <div
                  key={terminalGroup.id}
                  role="presentation"
                  className={cn(
                    "flex items-center gap-0.5",
                    terminalGroup.terminalIds.length > 1 &&
                      "rounded-md p-0.5 ring-1 ring-border ring-inset",
                  )}
                >
                  {terminalGroup.terminalIds.map((terminalId) => {
                    const isActive = terminalId === resolvedActiveTerminalId;
                    const label = terminalLabelById.get(terminalId) ?? "Terminal";
                    const closeTerminalLabel = `Close ${label}${
                      isActive && closeShortcutLabel ? ` (${closeShortcutLabel})` : ""
                    }`;
                    return (
                      <div
                        key={terminalId}
                        role="presentation"
                        className={cn(
                          "group/tab flex h-6 shrink-0 items-center gap-0.5 rounded-md ps-2 pe-0.5 text-ui",
                          isActive
                            ? "bg-accent text-foreground"
                            : "text-muted-foreground hover:bg-accent/60 hover:text-foreground",
                        )}
                      >
                        <button
                          type="button"
                          role="tab"
                          id={terminalTabId(terminalId)}
                          aria-selected={isActive}
                          aria-controls={terminalPanelId}
                          tabIndex={isActive ? 0 : -1}
                          className="flex min-w-0 items-center gap-1.5 rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
                          onClick={() => onActiveTerminalChange(terminalId)}
                          onKeyDown={(event) => onTerminalTabKeyDown(event, terminalId)}
                        >
                          <TerminalSquare aria-hidden="true" className="size-3.5 shrink-0" />
                          <span className="truncate">{label}</span>
                        </button>
                        <Tooltip>
                          <TooltipTrigger
                            render={
                              <button
                                type="button"
                                aria-label={closeTerminalLabel}
                                // Out of the tab order: Delete on the tab, the
                                // Close action and the close shortcut cover it.
                                tabIndex={-1}
                                className={cn(
                                  "inline-flex size-5 items-center justify-center rounded-sm text-muted-foreground opacity-0 outline-none hover:bg-background/70 hover:text-foreground focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-ring group-hover/tab:opacity-100 pointer-coarse:opacity-100",
                                  isActive && "opacity-100",
                                )}
                                onClick={() => onCloseTerminal(terminalId)}
                              />
                            }
                          >
                            <XIcon className="size-3.5" />
                          </TooltipTrigger>
                          <TooltipPopup side="bottom">{closeTerminalLabel}</TooltipPopup>
                        </Tooltip>
                      </div>
                    );
                  })}
                </div>
              ))}
            </div>
          </ScrollArea>
          <div className="flex shrink-0 items-center">
            <TerminalDrawerActions
              splitLabel={splitTerminalActionLabel}
              splitDisabled={hasReachedSplitLimit}
              onSplit={onSplitTerminalAction}
              newLabel={newTerminalActionLabel}
              onNew={onNewTerminalAction}
              closeLabel={closeTerminalActionLabel}
              onClose={() => onCloseTerminal(resolvedActiveTerminalId)}
              hideLabel={hideTerminalActionLabel}
              onHide={onHideTerminal}
            />
          </div>
        </div>
      ) : (
        // One terminal: the same strip without tabs, so the profile badge and
        // actions never sit on top of the terminal's first lines.
        <div className="flex h-8 shrink-0 items-center gap-1 border-b border-border ps-1.5 pe-0.5">
          {profileName ? (
            <Badge variant="outline" size="sm" className="shrink-0">
              {profileName}
            </Badge>
          ) : null}
          <span className="flex min-w-0 flex-1 items-center gap-1.5 px-1 text-ui text-muted-foreground">
            <TerminalSquare aria-hidden="true" className="size-3.5 shrink-0" />
            <span className="truncate">
              {terminalLabelById.get(resolvedActiveTerminalId) ?? "Terminal"}
            </span>
          </span>
          <div className="flex shrink-0 items-center">
            <TerminalDrawerActions
              splitLabel={splitTerminalActionLabel}
              splitDisabled={hasReachedSplitLimit}
              onSplit={onSplitTerminalAction}
              newLabel={newTerminalActionLabel}
              onNew={onNewTerminalAction}
              closeLabel={closeTerminalActionLabel}
              onClose={() => onCloseTerminal(resolvedActiveTerminalId)}
              hideLabel={hideTerminalActionLabel}
              onHide={onHideTerminal}
            />
          </div>
        </div>
      )}

      <div
        className="min-h-0 w-full flex-1"
        {...(hasTerminalTabs
          ? {
              id: terminalPanelId,
              role: "tabpanel",
              "aria-labelledby": terminalTabId(resolvedActiveTerminalId),
            }
          : {})}
      >
        <div className="flex h-full min-h-0">
          <div className="min-w-0 flex-1">
            {isSplitView ? (
              <div
                className="grid h-full w-full min-w-0 gap-0 overflow-hidden"
                style={{
                  gridTemplateColumns: `repeat(${visibleTerminalIds.length}, minmax(0, 1fr))`,
                }}
              >
                {visibleTerminalIds.map((terminalId) => (
                  <div
                    key={terminalId}
                    className={`min-h-0 min-w-0 border-l first:border-l-0 ${
                      terminalId === resolvedActiveTerminalId ? "border-border" : "border-border/70"
                    }`}
                    onMouseDown={() => {
                      if (terminalId !== resolvedActiveTerminalId) {
                        onActiveTerminalChange(terminalId);
                      }
                    }}
                  >
                    <div className="h-full p-1">
                      <TerminalViewport
                        threadId={threadId}
                        terminalId={terminalId}
                        terminalLabel={terminalLabelById.get(terminalId) ?? "Terminal"}
                        cwd={cwd}
                        {...(runtimeEnv ? { runtimeEnv } : {})}
                        onSessionExited={() => onCloseTerminal(terminalId)}
                        onAddTerminalContext={onAddTerminalContext}
                        focusRequestId={focusRequestId}
                        autoFocus={terminalId === resolvedActiveTerminalId}
                        resizeEpoch={resizeEpoch}
                        drawerHeight={drawerHeight}
                        resolvedTheme={resolvedTheme}
                        themePaletteRevision={themePaletteRevision}
                        monoFontFamily={appearance.monoFontFamily}
                        terminalFontSize={appearance.terminalFontSize}
                      />
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="h-full p-1">
                <TerminalViewport
                  key={resolvedActiveTerminalId}
                  threadId={threadId}
                  terminalId={resolvedActiveTerminalId}
                  terminalLabel={terminalLabelById.get(resolvedActiveTerminalId) ?? "Terminal"}
                  cwd={cwd}
                  {...(runtimeEnv ? { runtimeEnv } : {})}
                  onSessionExited={() => onCloseTerminal(resolvedActiveTerminalId)}
                  onAddTerminalContext={onAddTerminalContext}
                  focusRequestId={focusRequestId}
                  autoFocus
                  resizeEpoch={resizeEpoch}
                  drawerHeight={drawerHeight}
                  resolvedTheme={resolvedTheme}
                  themePaletteRevision={themePaletteRevision}
                  monoFontFamily={appearance.monoFontFamily}
                  terminalFontSize={appearance.terminalFontSize}
                />
              </div>
            )}
          </div>
        </div>
      </div>
    </aside>
  );
}
