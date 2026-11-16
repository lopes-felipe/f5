import { ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts";
import { createTestServerProvider } from "./testServerProvider";
import { expect, it } from "vitest";
import { isListedModel, pickPreferredModel, getWorkflowModelCapabilities } from "./providerModels";
import { filterPickerVisibleModels } from "./components/chat/providerIconUtils";
import { resolveThreadModel, resolveProjectModel } from "./orchestrationState";

it("preserves server-owned thread and project model slugs", () => {
  for (const model of ["gpt-6-sol", "claude-sonnet-5-5", "gpt-future"]) {
    expect(resolveThreadModel({ model, sessionProviderName: null })).toBe(model);
    expect(resolveProjectModel(model)).toBe(model);
  }
});
it("chooses listed preferences, then listed options, then the only remaining option", () => {
  const options = [
    { slug: "old", name: "Old", isUnlisted: true },
    { slug: "new", name: "New" },
  ];
  expect(pickPreferredModel(options, ["old"])?.slug).toBe("new");
  expect(pickPreferredModel(options, ["new"])?.slug).toBe("new");
  expect(pickPreferredModel(options.slice(0, 1))?.slug).toBe("old");
  expect(isListedModel({ isCustom: true, isUnlisted: true })).toBe(true);
  expect(filterPickerVisibleModels(options, new Set()).map((model) => model.slug)).toEqual(["new"]);
  expect(filterPickerVisibleModels(options, new Set(["old"]))).toEqual(options);
});

it("uses the workflow dispatch instance, including a nondefault-only instance", () => {
  const driver = ProviderDriverKind.make("codex");
  const personal = createTestServerProvider("codex", {
    instanceId: ProviderInstanceId.make("codex-personal"),
    models: [
      {
        slug: "future",
        name: "Future",
        isCustom: false,
        capabilities: { source: "reported", supportsFastMode: false },
      },
    ],
  });
  const standard = createTestServerProvider("codex", {
    models: [
      {
        slug: "future",
        name: "Future",
        isCustom: false,
        capabilities: { source: "reported", supportsFastMode: true },
      },
    ],
  });
  expect(
    getWorkflowModelCapabilities([personal, standard], driver, "future").supportsFastMode,
  ).toBe(true);
  expect(getWorkflowModelCapabilities([personal], driver, "future").supportsFastMode).toBe(false);
});
