import { randomUUID, createHash } from "node:crypto";
import { copyFile, chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  ORCHESTRATION_WS_METHODS,
  WS_METHODS,
  ProfileRecord,
  TurnSubmissionResult,
} from "@t3tools/contracts";
import { Schema } from "effect";
import { profileStateDir } from "@t3tools/shared/profilePaths";
import { createRehearsalFixture } from "../src/computer/rehearsalFixture.ts";
import { PROFILE_INSPECTION_POLL_LIMIT } from "@t3tools/shared/computerRehearsalProfiles";
import { RehearsalExternalClient } from "../src/computer/rehearsalExternalClient.ts";
import {
  suspendedProbe,
  codexAuthenticationReady,
} from "../../../scripts/computer-certification/preflight.ts";
import {
  profileIsolationChecks,
  profileInspectionDiagnosticChecks,
} from "../../../scripts/computer-certification/profileIsolationEvidence.ts";
import {
  profileProviderProgress,
  profileOwnerLeaseReady,
} from "../src/computer/rehearsalProfileIsolation.ts";

const fingerprint = async (path) =>
  createHash("sha256")
    .update(await readFile(path))
    .digest("hex");

/** Runs only inside the unsigned Electron rehearsal. All control is from real
 * provider turns; external clients use the ordinary authenticated queue API.
 * The wrapper supplies observation, never results, grants or lease messages. */
export async function runProfileIsolation(o) {
  const {
    application,
    page,
    fixture,
    root,
    state,
    home,
    sourceHome,
    threadId,
    appId,
    modelSelection,
    installRenderer,
    rpc,
    waitFor,
    delay,
    stage,
    instructions,
    ownFixture,
    ownClient,
    helper,
    fixtureBinDirectory,
  } = o;
  const interactionMode = o.inspectionDiagnostic ? "plan" : "default";
  stage("profile-isolation-prerequisites");
  const sourceHash = await fingerprint(join(sourceHome, "auth.json"));
  const primaryHash = await fingerprint(join(home, "auth.json"));
  const other = await rpc(WS_METHODS.profilesCreate, { name: "Computer isolation test" });
  if (!Schema.is(ProfileRecord)(other) || other.isDefault || other.status !== "ready")
    throw new Error("Isolation profile prerequisite incomplete.");
  const secondaryState = profileStateDir(state, other);
  const secondaryHome = join(secondaryState, "provider-homes", "codex");
  await mkdir(secondaryHome, { recursive: true, mode: 0o700 });
  await copyFile(join(home, "auth.json"), join(secondaryHome, "auth.json"));
  await chmod(join(secondaryHome, "auth.json"), 0o600);
  await copyFile(join(home, "config.toml"), join(secondaryHome, "config.toml"));
  const settings = JSON.parse(await readFile(join(state, "settings.json"), "utf8"));
  settings.providerInstances.codex.config.homePath = secondaryHome;
  await writeFile(join(secondaryState, "settings.json"), JSON.stringify(settings), { mode: 0o600 });
  const secondaryHash = await fingerprint(join(secondaryHome, "auth.json"));
  if (
    !(await codexAuthenticationReady({
      home: secondaryHome,
      binary: settings.providerInstances.codex.config.binaryPath,
    }))
  )
    throw new Error("Isolation account prerequisite incomplete.");
  const ids = [threadId, randomUUID()];
  const apps = [
    appId,
    process.platform === "win32"
      ? join(root, "isolation-fixture", "ComputerControlFixture.exe").toLowerCase()
      : `org.example.computer-isolation.${randomUUID()}`,
  ];
  const titles = [`PRIVATE_ISOLATION_A_${randomUUID()}`, `PRIVATE_ISOLATION_B_${randomUUID()}`];
  const primaryId = await page.evaluate(() => window.desktopBridge.getProfileId());
  await application.evaluate(
    (_electron, identities) => globalThis.__computerRehearsalIsolation.configure(identities),
    [
      { profileId: primaryId, threadId: ids[0], appId: apps[0], privateTitle: titles[0] },
      { profileId: other.id, threadId: ids[1], appId: apps[1], privateTitle: titles[1] },
    ],
  );
  await page.evaluate((id) => window.desktopBridge.switchProfile(id), other.id);
  let secondaryPage;
  await waitFor(async () => {
    for (const candidate of application.windows()) {
      if (candidate === page || candidate.isClosed()) continue;
      const id = await candidate
        .evaluate(() => window.desktopBridge?.getProfileId())
        .catch(() => undefined);
      if (id === other.id) {
        secondaryPage = candidate;
        return true;
      }
    }
    return false;
  }, 60000);
  await secondaryPage
    .getByRole("button", { name: "Add your first project", exact: true })
    .waitFor({ timeout: 60000 });
  await installRenderer(secondaryPage, [apps[1]], ids[1]);
  const pages = [page, secondaryPage];
  o.registerPause(() =>
    Promise.allSettled(
      pages.map((p, i) =>
        p.evaluate((id) => window.desktopBridge.computerAutomation.setPaused(id, true), ids[i]),
      ),
    ),
  );
  const secondaryWorkspace = join(root, "isolation-workspace");
  await mkdir(secondaryWorkspace);
  const secondaryRpc = (method, body = {}) =>
    secondaryPage.evaluate(([m, b]) => window.__computerRehearsal.rpc(m, b), [method, body]);
  const dispatch = (call, command) =>
    call(ORCHESTRATION_WS_METHODS.dispatchCommand, {
      command: { commandId: randomUUID(), createdAt: new Date().toISOString(), ...command },
    });
  const secondaryProject = randomUUID();
  await dispatch(secondaryRpc, {
    type: "project.create",
    projectId: secondaryProject,
    title: "Isolation test only",
    workspaceRoot: secondaryWorkspace,
    defaultModelSelection: modelSelection,
  });
  await dispatch(secondaryRpc, {
    type: "thread.create",
    threadId: ids[1],
    projectId: secondaryProject,
    title: titles[1],
    model: modelSelection.model,
    modelSelection,
    runtimeMode: "full-access",
    interactionMode,
    branch: null,
    worktreePath: null,
  });
  await dispatch(rpc, { type: "thread.meta.update", threadId: ids[0], title: titles[0] });
  await secondaryPage.evaluate((id) => {
    window.location.hash = `/${id}`;
  }, ids[1]);
  // Metadata-only turns can succeed even when a chat never mounted. Genuine
  // approval/consent UI needs each requested conversation to be visible first.
  stage("profile-isolation-chat-prerequisites");
  for (const [i, p] of pages.entries()) {
    await p.getByTestId("composer-editor").waitFor({ state: "visible", timeout: 15000 });
    await waitFor(
      () =>
        p
          .getByText(titles[i], { exact: true })
          .evaluateAll((nodes) => nodes.some((node) => node.checkVisibility())),
      15000,
    );
  }
  const clients = [];
  let pushWork = Promise.resolve();
  let pushFailed = false;
  for (const [index, p] of pages.entries()) {
    await waitFor(
      async () =>
        (await p.evaluate(() => window.desktopBridge.computerAutomation.status())).available ===
        true,
      10000,
    );
    const client = ownClient(
      await RehearsalExternalClient.connect(
        await p.evaluate(() => window.desktopBridge.getWsUrl()),
        (channel, data) => {
          if (
            [
              "computer.activity",
              "computer.access.grantsChanged",
              "computer.access.requested",
              "agent.computerUseChanged",
              "orchestration.domainEvent",
            ].includes(channel)
          )
            pushWork = pushWork
              .then(() =>
                application.evaluate(
                  (_electron, value) => globalThis.__computerRehearsalIsolation.push(...value),
                  [index, channel, data],
                ),
              )
              .catch(() => {
                pushFailed = true;
              });
        },
      ),
    );
    clients.push(client);
  }
  const snapshot = async () => {
    await pushWork;
    if (pushFailed) throw new Error("Isolation push receipt incomplete.");
    const result = await application.evaluate(() =>
      globalThis.__computerRehearsalIsolationSnapshot(),
    );
    if (!result || result.failed !== false || typeof result.value !== "string")
      throw new Error("Isolation observer snapshot callback failed.");
    return JSON.parse(result.value);
  };
  const current = async (i) =>
    (await clients[i].rpc(ORCHESTRATION_WS_METHODS.getSnapshot)).threads.find(
      (t) => t.id === ids[i],
    );
  o.registerDiagnostics(async () => ({
    channels: await snapshot(),
    helperMonitorAtFailure: await application.evaluate(() =>
      globalThis.__computerRehearsalStop.diagnostics(),
    ),
    providerProgress: await Promise.all(
      clients.map(async (client, i) => {
        const tail = await client
          .rpc(ORCHESTRATION_WS_METHODS.getThreadTailDetails, {
            threadId: ids[i],
            messageLimit: 0,
            checkpointLimit: 0,
            activityLimit: 100,
          })
          .catch(() => undefined);
        return profileProviderProgress(await current(i).catch(() => undefined), tail?.activities);
      }),
    ),
  }));
  const submissions = [];
  const submit = async (i, text, phase = "metadata") => {
    const previous = (await current(i))?.latestTurn?.turnId;
    const submissionId = randomUUID();
    const result = await clients[i].rpc(WS_METHODS.nextTurnQueueSubmit, {
      submissionId,
      intent: "auto",
      command: {
        type: "thread.turn.start",
        commandId: submissionId,
        threadId: ids[i],
        createdAt: new Date().toISOString(),
        message: { messageId: randomUUID(), role: "user", text, attachments: [] },
        modelSelection,
        runtimeMode: "full-access",
        interactionMode,
      },
    });
    if (
      !Schema.is(TurnSubmissionResult)(result) ||
      result.submissionId !== submissionId ||
      !["started", "queued"].includes(result.disposition)
    )
      throw new Error("Isolation queue admission incomplete.");
    submissions.push({ profileOrdinal: i + 1, phase, disposition: result.disposition });
    return previous;
  };
  const completed = async (i, previous) =>
    waitFor(async () => {
      const turn = (await current(i))?.latestTurn;
      if (!turn || turn.turnId === previous) return false;
      if (["error", "interrupted"].includes(turn.state))
        throw new Error("Provider turn did not complete.");
      return turn.state === "completed";
    }, 150000);
  if (o.readinessOnly) {
    stage("profile-readiness-concurrent-polling");
    const previousTurns = await Promise.all(
      [0, 1].map((i) =>
        submit(
          i,
          "Read-only profile readiness. Call computer_status and computer_list_apps exactly once each. No access request, activation, inspection, screenshot, input, shell, files or network. Stop on failure and never retry. Finish READY.",
        ),
      ),
    );
    await Promise.all(
      [0, 1].map((i) =>
        waitFor(async () => {
          try {
            if (
              await profileOwnerLeaseReady(
                async () => (await snapshot()).profiles[i].held,
                async () => (await current(i))?.latestTurn,
                previousTurns[i],
              )
            )
              throw new Error("Isolation read-only owner polling receipt incomplete.");
          } catch (error) {
            if (
              !(error instanceof Error) ||
              error.message !== "Isolation owner turn ended without a lease."
            )
              throw error;
          }
          const turn = (await current(i))?.latestTurn;
          if (!turn || turn.turnId === previousTurns[i]) return false;
          if (["error", "interrupted"].includes(turn.state))
            throw new Error("Provider turn did not complete.");
          return turn.state === "completed";
        }, 150000),
      ),
    );
    // Exercise the exact bundled Node polling path without acquiring a lease.
    // Both completed metadata turns must be refused as owners with no lease.
    for (const i of [0, 1]) {
      let refused = false;
      try {
        await profileOwnerLeaseReady(
          async () => (await snapshot()).profiles[i].held,
          async () => (await current(i))?.latestTurn,
          undefined,
        );
      } catch (error) {
        if (
          error instanceof Error &&
          error.message === "Isolation owner turn ended without a lease."
        )
          refused = true;
        else throw error;
      }
      if (!refused) throw new Error("Isolation read-only owner polling receipt incomplete.");
    }
    const backendPids = await application.evaluate(() =>
      Object.values(globalThis.__computerRehearsalIsolationBackendPids),
    );
    const snapshots = await Promise.all(
      clients.map((c) => c.rpc(ORCHESTRATION_WS_METHODS.getSnapshot)),
    );
    const profileSnapshotsPrivate = snapshots.every(
      (s, i) =>
        s.threads.some((t) => t.id === ids[i]) && !s.threads.some((t) => t.id === ids[1 - i]),
    );
    for (const i of [0, 1]) {
      await dispatch((m, b) => clients[i].rpc(m, b), {
        type: "thread.session.stop",
        threadId: ids[i],
      });
      await waitFor(async () => (await current(i))?.session?.status === "stopped", 15000);
    }
    return {
      readinessOnly: true,
      channels: await snapshot(),
      distinctRendererProfiles: primaryId !== other.id,
      distinctBackendProcesses: backendPids.length === 2 && new Set(backendPids).size === 2,
      isolatedProviderHomes: home !== secondaryHome,
      sourceCredentialsUnchanged: (await fingerprint(join(sourceHome, "auth.json"))) === sourceHash,
      isolatedCredentialsUnchanged:
        (await fingerprint(join(home, "auth.json"))) === primaryHash &&
        (await fingerprint(join(secondaryHome, "auth.json"))) === secondaryHash,
      profileSnapshotsPrivate,
      bothSessionsStopped: true,
      bothChatSurfacesReady: true,
      ownerPollingReadOnlyChecked: true,
    };
  }
  const secondaryFixture = ownFixture(
    await createRehearsalFixture({ root, appId: apps[1], preparedDirectory: fixtureBinDirectory }),
  );
  const fixtures = [fixture, secondaryFixture];
  const consents = [];
  o.record({
    consents,
    submissions,
    bothChatSurfacesReady: true,
    distinctRendererProfiles: primaryId !== other.id,
    isolatedProviderHomes: home !== secondaryHome,
  });
  // Prepare both sessions and genuine grants before either provider can acquire.
  for (const i of [0, 1]) {
    stage(`profile-${i + 1}-consent`);
    await pages[i].bringToFront();
    await instructions(
      `Profile ${i + 1}: approve Codex's named request-access call if asked. Click Review access and allow only Computer Control Test Fixture. Leave remembering off. No input yet.`,
      pages[i],
    );
    const previous = await submit(
      i,
      `Consent-only isolation test. Call computer_status with {}, then computer_request_access exactly once with these arguments: ${JSON.stringify({ apps: [apps[i]], reason: "Synthetic two-profile isolation test" })}. The apps field is an array of one exact app ID and reason is required. The user will review genuine consent. Do not activate, inspect, capture, type or use any other tool. No shell/files/network. Stop on failure, never retry. Finish READY.`,
      "consent",
    );
    await waitFor(
      async () => pages[i].evaluate(() => window.__computerRehearsal.consentSettled),
      90000,
    );
    const consent = await pages[i].evaluate(() => {
      const s = window.__computerRehearsal;
      return {
        trustedReview: s.trustedConsent === true,
        visible: s.trustedConsentVisible === true,
        allowed: s.consentAllowed === true,
        settled: s.consentSettled === true,
      };
    });
    const grants = await clients[i].rpc(WS_METHODS.computerAccessList, { threadId: ids[i] });
    const remembered = await (i === 0 ? rpc : secondaryRpc)(
      WS_METHODS.computerAccessListRemembered,
      { projectId: i === 0 ? o.projectId : secondaryProject },
    );
    consent.remembered = !Array.isArray(remembered) || remembered.length !== 0;
    if (
      !Object.values(consent).slice(0, 4).every(Boolean) ||
      consent.remembered ||
      !Array.isArray(grants) ||
      grants.length !== 1 ||
      grants[0].appId !== apps[i]
    )
      throw new Error("Isolation consent receipt incomplete.");
    consents.push(consent);
    await completed(i, previous);
  }
  const backendPids = await application.evaluate(() =>
    Object.values(globalThis.__computerRehearsalIsolationBackendPids),
  );
  if (backendPids.length !== 2 || new Set(backendPids).size !== 2)
    throw new Error("Isolation backend prerequisite incomplete.");
  const device = await suspendedProbe(helper);
  if (device.available || device.reason !== "other-instance")
    throw new Error("Isolation device lock receipt incomplete.");
  if (o.inspectionDiagnostic) {
    stage("profile-inspection-diagnostic");
    await instructions(
      "Observation-only check: no RED or computer input. You can use your computer; leave the two synthetic fixtures unchanged.",
    );
    const previous = await Promise.all(
      [0, 1].map((i) =>
        submit(
          i,
          `Plan-mode observation-only diagnostic. Call computer_inspect sequentially exactly 20 times with ${JSON.stringify({ app: apps[i], maxNodes: 30 })}. No activation, screenshot, zoom, input, shell, files, network or other tools. Stop on any error or interruption; never retry. Finish READY.`,
          "inspection-diagnostic",
        ),
      ),
    );
    await Promise.all(
      [0, 1].map((i) =>
        waitFor(async () => {
          try {
            if (
              await profileOwnerLeaseReady(
                async () => (await snapshot()).profiles[i].held,
                async () => (await current(i))?.latestTurn,
                previous[i],
              )
            )
              throw new Error("Isolation read-only owner polling receipt incomplete.");
          } catch (error) {
            if (
              !(error instanceof Error) ||
              error.message !== "Isolation owner turn ended without a lease."
            )
              throw error;
          }
          const turn = (await current(i))?.latestTurn;
          if (!turn || turn.turnId === previous[i]) return false;
          if (["error", "interrupted"].includes(turn.state))
            throw new Error("Provider turn did not complete.");
          return turn.state === "completed";
        }, 150000),
      ),
    );
    const planModeVerified = (await Promise.all([current(0), current(1)])).every(
      (t) => t?.interactionMode === "plan",
    );
    for (const i of [0, 1]) {
      await dispatch((m, b) => clients[i].rpc(m, b), {
        type: "thread.session.stop",
        threadId: ids[i],
      });
      await waitFor(async () => (await current(i))?.session?.status === "stopped", 15000);
      await waitFor(async () => {
        const grants = await clients[i].rpc(WS_METHODS.computerAccessList, { threadId: ids[i] });
        return Array.isArray(grants) && grants.length === 0;
      }, 5000);
    }
    const snapshots = await Promise.all(
      clients.map((c) => c.rpc(ORCHESTRATION_WS_METHODS.getSnapshot)),
    );
    const receipt = {
      inspectionDiagnostic: true,
      planModeVerified,
      consents,
      submissions,
      channels: await snapshot(),
      bothChatSurfacesReady: true,
      distinctRendererProfiles: primaryId !== other.id,
      distinctBackendProcesses: true,
      isolatedProviderHomes: home !== secondaryHome,
      sourceCredentialsUnchanged: (await fingerprint(join(sourceHome, "auth.json"))) === sourceHash,
      isolatedCredentialsUnchanged:
        (await fingerprint(join(home, "auth.json"))) === primaryHash &&
        (await fingerprint(join(secondaryHome, "auth.json"))) === secondaryHash,
      profileSnapshotsPrivate: snapshots.every(
        (s, i) =>
          s.threads.some((t) => t.id === ids[i]) && !s.threads.some((t) => t.id === ids[1 - i]),
      ),
      bothSessionsStopped: true,
    };
    o.record(receipt);
    const checks = profileInspectionDiagnosticChecks({
      profileIsolationObservation: receipt,
      cleanup: { confirmed: true },
    });
    delete checks.cleanup;
    if (!Object.values(checks).every(Boolean))
      throw new Error("Isolation inspection diagnostic receipt incomplete.");
    await instructions(
      "Finished: observation-only diagnostic complete, both sessions stopped. No computer input ran.",
    );
    return receipt;
  }
  o.record({
    consents,
    submissions,
    bothChatSurfacesReady: true,
    distinctRendererProfiles: primaryId !== other.id,
    distinctBackendProcesses: true,
    isolatedProviderHomes: home !== secondaryHome,
    secondHelperReason: device.reason,
  });
  await instructions(
    "Both grants ready. Keep input idle during countdown and RED. Finish check will stay available after both sessions stop.",
  );
  for (const f of fixtures) f.child.stdin.write("WINDOWLESS_READY\n");
  for (const seconds of [3, 2, 1]) {
    for (const f of fixtures) f.child.stdin.write(`WINDOWLESS_COUNTDOWN_${seconds}\n`);
    await delay(1000);
  }
  const helperMonitorBaseline = await application.evaluate(() =>
    globalThis.__computerRehearsalStop.diagnostics(),
  );
  o.record({
    consents,
    submissions,
    bothChatSurfacesReady: true,
    distinctRendererProfiles: primaryId !== other.id,
    distinctBackendProcesses: true,
    isolatedProviderHomes: home !== secondaryHome,
    secondHelperReason: device.reason,
    helperMonitorBaseline,
  });
  let beforeNonHolderStop,
    afterNonHolderStop,
    nonHolderSessionStopped = false;
  for (const owner of [0, 1]) {
    const contender = 1 - owner;
    stage(`profile-${owner + 1}-contention`);
    fixtures[owner].child.stdin.write("PROFILE_HOLD\n");
    fixtures[contender].child.stdin.write("PROFILE_HOLD\n");
    // Start the contender's real observation loop before acquiring. Its next
    // inspection sees the fixture cue, without cold-starting a provider turn
    // while the owner consumes its bounded observation budget.
    const inspectionBaseline = (await snapshot()).profiles[contender].native.inspectionResponses;
    const previousContender = await submit(
      contender,
      `Use only F5 computer tools for exact granted app ${apps[contender]}. Inspect only this app sequentially, one call at a time, at most ${PROFILE_INSPECTION_POLL_LIMIT} times, while its Rehearsal instruction says Isolation waiting. When this fixture says Isolation released, call computer_activate_app exactly once for this app with screenshot:false. Another profile should then hold the lease: expect Busy and finish READY immediately. If the inspection limit is reached, finish without activating. No fallback, retry, other tools, shell/files/network or apps. Stop on any error or interruption.`,
      "contender",
    );
    await waitFor(
      async () =>
        (await snapshot()).profiles[contender].native.inspectionResponses > inspectionBaseline,
      150000,
    );
    const previousOwner = await submit(
      owner,
      `Use only F5 computer tools for exact granted app ${apps[owner]}. Activate it exactly once with screenshot:true. Then inspect only this app sequentially, one call at a time, at most ${PROFILE_INSPECTION_POLL_LIMIT} times, while the Rehearsal instruction says Isolation waiting. When it says Isolation released, finish READY immediately. If the inspection limit is reached, finish without further action. Do not press, type, move, click or touch any other app. Do not request new access or use shell/files/network. Stop on any error/interruption/ambiguity, never retry.`,
      "owner",
    );
    // Provider planning/queue admission is not a native execution latency check.
    // Use the same bounded turn budget as completion; still require a live lease.
    await waitFor(
      () =>
        profileOwnerLeaseReady(
          async () => (await snapshot()).profiles[owner].held,
          async () => (await current(owner))?.latestTurn,
          previousOwner,
        ),
      150000,
    );
    // Only fixture-owned instruction text changes here. The real provider must
    // observe it and make its own ordinary call; no lease or result is injected.
    fixtures[contender].child.stdin.write("PROFILE_RELEASE\n");
    await completed(contender, previousContender);
    const contention = await snapshot();
    if (
      contention.profiles[contender].busy !== 1 ||
      !contention.profiles[contender].busyWhileForeignHeld ||
      !contention.profiles[owner].held
    )
      throw new Error("Isolation contention receipt incomplete.");
    if (owner === 1) {
      beforeNonHolderStop = contention;
      await dispatch((m, b) => clients[0].rpc(m, b), {
        type: "thread.session.stop",
        threadId: ids[0],
      });
      await waitFor(async () => (await current(0))?.session?.status === "stopped", 15000);
      nonHolderSessionStopped = true;
      afterNonHolderStop = await snapshot();
      if (!afterNonHolderStop.profiles[1].held)
        throw new Error("Isolation non-holder stop receipt incomplete.");
    }
    fixtures[owner].child.stdin.write("PROFILE_RELEASE\n");
    await completed(owner, previousOwner);
    await waitFor(async () => !(await snapshot()).profiles[owner].held, 5000);
  }
  stage("profile-isolation-session-cleanup");
  await dispatch((m, b) => clients[1].rpc(m, b), { type: "thread.session.stop", threadId: ids[1] });
  await waitFor(async () => (await current(1))?.session?.status === "stopped", 15000);
  for (const i of [0, 1])
    await waitFor(async () => {
      const grants = await clients[i].rpc(WS_METHODS.computerAccessList, { threadId: ids[i] });
      return Array.isArray(grants) && grants.length === 0 && !(await snapshot()).profiles[i].held;
    }, 5000);
  const snapshots = await Promise.all(
    clients.map((c) => c.rpc(ORCHESTRATION_WS_METHODS.getSnapshot)),
  );
  const profileSnapshotsPrivate = snapshots.every(
    (s, i) => s.threads.some((t) => t.id === ids[i]) && !s.threads.some((t) => t.id === ids[1 - i]),
  );
  await instructions(
    "FINISHED: Both sessions stopped. Click Finish check in the active synthetic fixture. You can use your computer.",
  );
  // The second fixture is frontmost after the final owner turn. Keep its cue
  // and control visible rather than enabling a covered/background window.
  secondaryFixture.child.stdin.write("WINDOWLESS_FINISHED\n");
  await waitFor(() => secondaryFixture.acknowledged(), 90000);
  const receipt = {
    channels: await snapshot(),
    consents,
    submissions,
    helperMonitorBaseline,
    beforeNonHolderStop,
    afterNonHolderStop,
    nonHolderSessionStopped,
    bothSessionsStopped: true,
    distinctRendererProfiles: primaryId !== other.id,
    distinctBackendProcesses: true,
    isolatedProviderHomes: home !== secondaryHome,
    sourceCredentialsUnchanged: (await fingerprint(join(sourceHome, "auth.json"))) === sourceHash,
    isolatedCredentialsUnchanged:
      (await fingerprint(join(home, "auth.json"))) === primaryHash &&
      (await fingerprint(join(secondaryHome, "auth.json"))) === secondaryHash,
    profileSnapshotsPrivate,
    secondHelperReason: device.reason,
    humanFinishAcknowledged: secondaryFixture.acknowledged(),
    fixturesUntouched: fixtures.every((f) => f.presses() === 0 && !f.typed()),
    bothChatSurfacesReady: true,
  };
  o.record(receipt);
  const checks = profileIsolationChecks({
    profileIsolationObservation: receipt,
    cleanup: { confirmed: true },
  });
  if (!Object.values(checks).every(Boolean)) throw new Error("Isolation final receipt incomplete.");
  return receipt;
}
