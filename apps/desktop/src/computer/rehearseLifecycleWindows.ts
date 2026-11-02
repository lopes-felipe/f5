import { randomUUID } from "node:crypto";
import type { ComputerInspectResult } from "@t3tools/contracts";
import { ComputerControlError } from "@t3tools/shared/computerControl";
import {
  acceptanceAssert as assert,
  acceptanceUntil as until,
  acceptanceWait as wait,
  expectWindowsRefusal as refused,
  runWindowsAcceptance,
} from "./rehearsalWindowsAcceptance";

if (import.meta.main)
  await runWindowsAcceptance("windows-native-authority-lifecycle", async (s) => {
    const app = await s.fixture("approved");
    await s.fixture("idle");
    await s.start();
    s.grant([app.appId]);
    const inspect = () =>
      s.request<ComputerInspectResult>({ op: "inspect", appId: app.appId, maxNodes: 800 });
    const initial = await inspect();
    const button = initial.nodes.find(
      (n) => n.name === "Rehearsal press" && n.actions.includes("press"),
    );
    const input = initial.nodes.find((n) => n.enabled && n.actions.includes("setValue"));
    assert(button && input, "fixture-accessibility-missing");
    const press = () =>
      s.request({
        op: "elementAction",
        appId: app.appId,
        snapshotId: initial.snapshotId,
        elementRef: button.elementRef,
        action: "press",
      });
    s.arm(1, { kind: "foreground" });
    await press();
    await until(() => app.fixture.presses() === 1);
    s.generations.delete(1);
    await wait(1400);
    await refused(press, "Interrupted");
    s.helper.control({ type: "permit", executionGeneration: 1, expiresInMs: 1000 });
    await refused(press, "Interrupted");
    assert(app.fixture.presses() === 1, "expired-permit-replayed-input");
    s.checks.expiryLatches = true;
    await s.retire(1);
    s.arm(1, { kind: "foreground" });
    await refused(press, "Interrupted");
    s.generations.delete(1);
    s.checks.retiredGenerationRefused = true;
    s.arm(2, { kind: "foreground" });
    const old = s.authorization;
    s.grant([]);
    await refused(
      () =>
        s.request(
          {
            op: "elementAction",
            appId: app.appId,
            snapshotId: initial.snapshotId,
            elementRef: button.elementRef,
            action: "press",
          },
          old,
        ),
      "Interrupted",
    );
    s.grant([app.appId]);
    await refused(press, "StaleElement");
    assert(app.fixture.presses() === 1, "revoked-grant-replayed-input");
    s.checks.revocationAndGrantVersion = true;
    const beforeReplacement = await inspect();
    const oldInput = beforeReplacement.nodes.find(
      (n) => n.enabled && n.actions.includes("setValue"),
    );
    assert(oldInput, "fixture-input-missing");
    await app.observer.command("replace-input");
    await refused(
      () =>
        s.request({
          op: "elementAction",
          appId: app.appId,
          snapshotId: beforeReplacement.snapshotId,
          elementRef: oldInput.elementRef,
          action: "setValue",
          value: "F5_WINDOWS_REHEARSAL Ω🙂",
        }),
      "StaleElement",
    );
    assert(!app.fixture.typed(), "stale-reference-delivered-input");
    s.checks.replacedElementRefused = true;
    await s.retire(2);
    s.arm(3, { kind: "app", appId: app.appId });
    const tree = await inspect();
    const backgroundButton = tree.nodes.find(
      (n) => n.name === "Rehearsal press" && n.actions.includes("press"),
    );
    assert(backgroundButton, "fixture-button-missing");
    const queued = Array.from({ length: 80 }, async () => {
      try {
        await s.request({
          op: "elementAction",
          appId: app.appId,
          delivery: "background",
          snapshotId: tree.snapshotId,
          elementRef: backgroundButton.elementRef,
          action: "press",
        });
        return "ok";
      } catch (error) {
        return error instanceof ComputerControlError ? error.error._tag : "invalid";
      }
    });
    await until(() => app.fixture.presses() >= 2);
    await s.helper.suspend(3);
    s.generations.delete(3);
    await s.helper.drain(3, 5000);
    const outcomes = await Promise.all(queued);
    assert(
      outcomes.includes("Busy") &&
        outcomes.includes("Interrupted") &&
        outcomes.every((tag) => ["ok", "Busy", "Interrupted"].includes(tag)),
      "queue-bound-or-drain-failed",
    );
    const count = app.fixture.presses();
    await wait(750);
    assert(app.fixture.presses() === count && count < 40, "queued-input-replayed");
    s.checks.saturationAndDrain = true;
    await s.retire(3);
    const stale = await inspect();
    s.helper.retry();
    await until(() => s.helper.status().available, 10000);
    await refused(inspect, "Interrupted");
    s.checks.restartDropsGrants = true;
    s.authorization = {
      ...s.authorization,
      sessionGeneration: randomUUID(),
      executionGeneration: 4,
    };
    s.publish();
    await refused(
      () =>
        s.request({
          op: "inspect",
          appId: app.appId,
          maxNodes: 800,
          snapshotId: stale.snapshotId,
          elementRef: stale.nodes[0]!.elementRef,
        }),
      "StaleElement",
    );
    const fresh = await inspect();
    const freshButton = fresh.nodes.find(
      (n) => n.name === "Rehearsal press" && n.actions.includes("press"),
    );
    assert(freshButton, "restarted-fixture-button-missing");
    await refused(
      () =>
        s.request({
          op: "elementAction",
          appId: app.appId,
          snapshotId: fresh.snapshotId,
          elementRef: freshButton.elementRef,
          action: "press",
        }),
      "Interrupted",
    );
    assert(app.fixture.presses() === count, "restart-replayed-input");
    s.checks.restartDropsPermitsAndReferences = true;
  });
