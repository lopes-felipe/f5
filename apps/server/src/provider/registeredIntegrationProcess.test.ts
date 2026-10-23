import { describe, expect, it } from "vitest";
import type { ChromeProcessRegistration } from "@t3tools/contracts";
import { spawnRegisteredProcess } from "./registeredIntegrationProcess";

const identity = {
  profileId: "p",
  backendIncarnation: "i",
  threadId: "t",
  sessionGeneration: "g",
  integration: "claude-chrome" as const,
};
const collect = (stream: NodeJS.ReadableStream) =>
  new Promise<string>((resolve) => {
    let out = "";
    stream.on("data", (chunk: Buffer) => (out += chunk.toString()));
    stream.on("end", () => resolve(out));
  });
const exit = (child: ReturnType<typeof spawnRegisteredProcess>) =>
  new Promise<void>((resolve) => child.once("exit", () => resolve()));

// Process groups and group signals are POSIX only; integrations run on macOS.
describe.skipIf(process.platform === "win32")("registered integration process", () => {
  it("leads its own group and exchanges no stdio before main accepts it", async () => {
    let accept!: () => void;
    const registrations: ChromeProcessRegistration[] = [];
    const exited: string[] = [];
    const child = spawnRegisteredProcess({
      command: "/bin/cat",
      args: [],
      env: {},
      identity,
      register: (registration) => {
        registrations.push(registration);
        return new Promise((resolve) => (accept = resolve));
      },
      exited: (token) => exited.push(token),
    });
    const done = exit(child);
    const output = collect(child.stdout);
    child.stdin.write("early\n");
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(registrations).toHaveLength(1);
    expect(registrations[0]).toMatchObject({ ...identity, launchToken: child.launchToken });
    expect(registrations[0]!.pgid).toBe(registrations[0]!.pid);
    accept();
    await child.registered;
    child.stdin.end("late\n");
    expect(await output).toBe("early\nlate\n");
    await done;
    expect(exited).toEqual([child.launchToken]);
  });

  it("kills the group and ends stdout when registration is refused", async () => {
    const child = spawnRegisteredProcess({
      command: "/bin/cat",
      args: [],
      env: {},
      identity,
      register: async () => {
        throw new Error("refused");
      },
    });
    const done = exit(child);
    const output = collect(child.stdout);
    child.stdin.write("never\n");
    await expect(child.registered).rejects.toThrow("refused");
    expect(await output).toBe("");
    await done;
    expect(child.signalCode).toBe("SIGKILL");
  });

  it("reports a group kill as killed and survives writes after it", async () => {
    const child = spawnRegisteredProcess({
      command: "/bin/cat",
      args: [],
      env: {},
      identity,
      register: async () => {},
    });
    const done = exit(child);
    await child.registered;
    expect(child.killed).toBe(false);
    expect(child.kill("SIGKILL")).toBe(true);
    // `process.kill(-pgid)` doesn't set ChildProcess.killed; the wrapper does.
    expect(child.killed).toBe(true);
    // Writes racing the exit hit a closed pipe (EPIPE) and must not escape as errors.
    for (let index = 0; index < 64; index += 1) child.stdin.write("x".repeat(64 * 1024));
    await done;
    for (let index = 0; index < 8; index += 1) child.stdin.write("after exit\n");
    await new Promise((resolve) => setTimeout(resolve, 50));
  });
});
