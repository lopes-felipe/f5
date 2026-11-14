import type { ChromeProcessSupervisor } from "./ChromeProcessSupervisor";
import type { ComputerConsentAuthority } from "./ComputerConsentAuthority";
import type { ComputerController } from "./ComputerController";
import type { ComputerHostChannel } from "./ComputerHostChannel";

export interface ComputerPauseDeps {
  readonly controller: Pick<ComputerController, "resumeTarget" | "requiresLocalResume">;
  readonly channel: Pick<ComputerHostChannel, "setThreadPaused" | "send"> & {
    readonly chrome: Pick<ComputerHostChannel["chrome"], "holderOf">;
  };
  readonly consent: Pick<ComputerConsentAuthority, "confirmResume">;
  readonly supervisor: Pick<ChromeProcessSupervisor, "resumed">;
}

/**
 * Trusted local Pause/Resume from the renderer. Resuming native or Chrome control needs the
 * native confirmation; both latches then change together, so a thread holding the Chrome
 * lease also leaves native recovery. Sends one `pauseChanged` of its own; pausing a thread
 * with an active native lease also reports that lease's pause, which the server applies
 * idempotently.
 */
export async function applyComputerPause(
  deps: ComputerPauseDeps,
  profileId: string,
  threadId: string,
  paused: boolean,
): Promise<void> {
  const { controller, channel, consent, supervisor } = deps;
  const target = controller.resumeTarget(profileId, threadId);
  const chromeHolder = channel.chrome.holderOf(profileId, threadId);
  if (!paused && (controller.requiresLocalResume(profileId, threadId) || chromeHolder)) {
    if (!(await consent.confirmResume(profileId, target.title, { recovery: target.recovery })))
      throw new Error("Computer control remains paused.");
    if (
      controller.resumeTarget(profileId, threadId).authorization !== target.authorization ||
      channel.chrome.holderOf(profileId, threadId) !== chromeHolder
    )
      throw new Error("The computer session changed while Resume was being confirmed.");
  }
  channel.setThreadPaused(profileId, threadId, paused);
  if (!paused) supervisor.resumed(profileId, threadId);
  channel.send(profileId, { type: "pauseChanged", threadId, paused });
}
