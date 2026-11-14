import { describe, expect, it, vi } from "vitest";
import { applyComputerPause, type ComputerPauseDeps } from "./computerPause";

type Holder = {
  profileId: string;
  threadId: string;
  sessionGeneration: string;
  provider: "claude";
};

function setup(
  options: {
    nativeHeld?: boolean;
    chromeHeld?: boolean;
    confirm?: boolean;
    recovery?: boolean;
  } = {},
) {
  const { nativeHeld = true, chromeHeld = true, confirm = true, recovery = true } = options;
  let chrome: Holder | null = chromeHeld
    ? { profileId: "profile", threadId: "thread", sessionGeneration: "s", provider: "claude" }
    : null;
  let authorization: object = {};
  const controller = {
    resumeTarget: vi.fn(() => ({
      title: "Draw",
      authorization,
      pauseCause: undefined,
      recovery,
    })),
    requiresLocalResume: vi.fn(() => nativeHeld),
  };
  const channel = {
    chrome: {
      holderOf: vi.fn((profileId: string, threadId: string) =>
        chrome?.profileId === profileId && chrome.threadId === threadId ? chrome : undefined,
      ),
    },
    setThreadPaused: vi.fn((_profileId: string, _threadId: string, _paused: boolean) => !!chrome),
    send: vi.fn(),
  };
  const consent = { confirmResume: vi.fn(async () => confirm) };
  const supervisor = { resumed: vi.fn() };
  const deps = { controller, channel, consent, supervisor } as unknown as ComputerPauseDeps;
  return {
    deps,
    controller,
    channel,
    consent,
    supervisor,
    replaceChrome: (next: Holder | null) => {
      chrome = next;
    },
    replaceAuthorization: () => {
      authorization = {};
    },
  };
}

describe("applyComputerPause", () => {
  it("resumes native recovery and the Chrome lease together after confirmation", async () => {
    const h = setup();
    await applyComputerPause(h.deps, "profile", "thread", false);
    expect(h.consent.confirmResume).toHaveBeenCalledWith("profile", "Draw", { recovery: true });
    expect(h.channel.setThreadPaused).toHaveBeenCalledExactlyOnceWith("profile", "thread", false);
    expect(h.supervisor.resumed).toHaveBeenCalledWith("profile", "thread");
    expect(h.channel.send).toHaveBeenCalledExactlyOnceWith("profile", {
      type: "pauseChanged",
      threadId: "thread",
      paused: false,
    });
  });

  it("propagates a native refusal without reporting a resume", async () => {
    const h = setup();
    h.channel.setThreadPaused.mockImplementationOnce(() => {
      throw new Error("monitor-unhealthy");
    });
    await expect(applyComputerPause(h.deps, "profile", "thread", false)).rejects.toThrow(
      "monitor-unhealthy",
    );
    expect(h.supervisor.resumed).not.toHaveBeenCalled();
    expect(h.channel.send).not.toHaveBeenCalled();
  });

  it("changes nothing when the confirmation is cancelled", async () => {
    const h = setup({ confirm: false });
    await expect(applyComputerPause(h.deps, "profile", "thread", false)).rejects.toThrow(
      "Computer control remains paused.",
    );
    expect(h.channel.setThreadPaused).not.toHaveBeenCalled();
    expect(h.channel.send).not.toHaveBeenCalled();
  });

  it("changes nothing when the session changed during the confirmation", async () => {
    const h = setup();
    h.consent.confirmResume.mockImplementationOnce(async () => {
      h.replaceChrome(null);
      return true;
    });
    await expect(applyComputerPause(h.deps, "profile", "thread", false)).rejects.toThrow(
      "The computer session changed while Resume was being confirmed.",
    );
    const native = setup({ chromeHeld: false });
    native.consent.confirmResume.mockImplementationOnce(async () => {
      native.replaceAuthorization();
      return true;
    });
    await expect(applyComputerPause(native.deps, "profile", "thread", false)).rejects.toThrow(
      "The computer session changed while Resume was being confirmed.",
    );
    expect(h.channel.setThreadPaused).not.toHaveBeenCalled();
    expect(native.channel.setThreadPaused).not.toHaveBeenCalled();
  });

  it("confirms native-only and Chrome-only resumes and changes both latches", async () => {
    for (const held of [
      { nativeHeld: true, chromeHeld: false },
      { nativeHeld: false, chromeHeld: true },
    ]) {
      const h = setup({ ...held, recovery: false });
      await applyComputerPause(h.deps, "profile", "thread", false);
      expect(h.consent.confirmResume).toHaveBeenCalledOnce();
      expect(h.channel.setThreadPaused).toHaveBeenCalledExactlyOnceWith("profile", "thread", false);
    }
  });

  it("pauses without a confirmation and resumes an unheld thread without one", async () => {
    const h = setup();
    await applyComputerPause(h.deps, "profile", "thread", true);
    expect(h.consent.confirmResume).not.toHaveBeenCalled();
    expect(h.channel.setThreadPaused).toHaveBeenCalledExactlyOnceWith("profile", "thread", true);
    expect(h.supervisor.resumed).not.toHaveBeenCalled();
    const idle = setup({ nativeHeld: false, chromeHeld: false });
    await applyComputerPause(idle.deps, "profile", "thread", false);
    expect(idle.consent.confirmResume).not.toHaveBeenCalled();
    expect(idle.channel.setThreadPaused).toHaveBeenCalledWith("profile", "thread", false);
  });
});
