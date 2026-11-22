import { describe, expect, it } from "vitest";
import {
  configureCodexCyberAccess,
  createReportedCodexModelCapabilities,
  normalizeCodexModelOptions,
} from "./model";

describe("Codex Cyber Access", () => {
  const capabilities = createReportedCodexModelCapabilities({
    model: "gpt-test",
    availableAccessPrograms: { cyber: ["daybreakRed", "daybreakBlue"] },
  });
  const descriptor = (config: unknown, account = "chatgpt") =>
    configureCodexCyberAccess(capabilities, config, account).optionDescriptors?.find(
      (option) => option.id === "cyberAccessProgram",
    );
  it("offers Standard as an explicit opt-out and prefers Blue when configured", () => {
    expect(descriptor({})?.currentValue).toBe("standard");
    expect(descriptor({ daybreak: true })?.currentValue).toBe("daybreakBlue");
    expect(descriptor(undefined)?.currentValue).toBeUndefined();
    expect(descriptor({ daybreak: true })?.type).toBe("select");
  });
  it("honors API-key access program opt-outs and unknown config", () => {
    expect(
      descriptor({ features: { api_key_cyber_access_programs: false } }, "apiKey"),
    ).toBeUndefined();
    expect(descriptor(undefined, "apiKey")).toBeUndefined();
    expect(descriptor({}, "apiKey")).toBeDefined();
  });
  it("keeps explicit choices only for reported eligible models", () => {
    const blueOnly = createReportedCodexModelCapabilities({
      model: "gpt-blue",
      availableAccessPrograms: { cyber: ["daybreakBlue"] },
    });
    expect(
      normalizeCodexModelOptions("gpt-blue", { cyberAccessProgram: "daybreakRed" }, blueOnly),
    ).toBeUndefined();
    expect(
      normalizeCodexModelOptions("gpt-test", { cyberAccessProgram: "standard" }, capabilities),
    ).toEqual({ cyberAccessProgram: "standard" });
    expect(
      normalizeCodexModelOptions("custom", { cyberAccessProgram: "daybreakRed" }),
    ).toBeUndefined();
    expect(
      createReportedCodexModelCapabilities({ model: "gpt-test" }).optionDescriptors,
    ).not.toEqual(expect.arrayContaining([expect.objectContaining({ id: "cyberAccessProgram" })]));
  });
});
