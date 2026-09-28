import type { ThreadStatus } from "./threadStatus";

export function needsThreadAttention(status: ThreadStatus): boolean {
  return (
    status === "pending-approval" ||
    status === "awaiting-input" ||
    status === "plan-ready" ||
    status === "completed"
  );
}

/** The context is unlocked by a user gesture and is owned by the mounted controller. */
export function createNotificationSound() {
  let context: AudioContext | undefined;
  return {
    unlock() {
      if (typeof AudioContext === "undefined") return;
      context ??= new AudioContext();
      void context.resume().catch(() => {});
    },
    play() {
      if (!context || context.state !== "running") return;
      const start = context.currentTime;
      const gain = context.createGain();
      gain.connect(context.destination);
      gain.gain.setValueAtTime(0, start);
      gain.gain.linearRampToValueAtTime(0.08, start + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.001, start + 0.3);
      const tone = context.createOscillator();
      tone.frequency.setValueAtTime(660, start);
      tone.frequency.setValueAtTime(880, start + 0.12);
      tone.connect(gain);
      tone.start(start);
      tone.stop(start + 0.3);
      tone.onended = () => {
        tone.disconnect();
        gain.disconnect();
      };
    },
    dispose() {
      void context?.close().catch(() => {});
      context = undefined;
    },
  };
}

export function setThreadAttentionBadge(count: number) {
  if (window.desktopBridge?.setAttentionBadge) {
    void window.desktopBridge.setAttentionBadge(count).catch(() => {});
    return;
  }
  const badgeNavigator = navigator as Navigator & {
    setAppBadge?: (count: number) => Promise<void>;
    clearAppBadge?: () => Promise<void>;
  };
  const operation =
    count > 0 ? badgeNavigator.setAppBadge?.(count) : badgeNavigator.clearAppBadge?.();
  void operation?.catch(() => {});
  const title = document.title.replace(/^\(\d+\) /, "");
  document.title = count > 0 ? `(${count}) ${title}` : title;
}
