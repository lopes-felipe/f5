import type { ModelCapabilities, ServerProviderSkill } from "@t3tools/contracts";
import { createReportedCodexModelCapabilities, normalizeModelSlug } from "@t3tools/shared/model";

import {
  CodexControlClient,
  type CodexControlEnvironmentConfig,
} from "../codex/CodexControlClient.ts";
import type { ReportedProviderModel } from "./providerSnapshot.ts";

/** Wall-clock budget for one instance model probe, process start included. */
export const CODEX_MODEL_PROBE_TIMEOUT_MS = 8_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function nonEmpty(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

/**
 * Normalize `model/list` entries into reported models. Hidden models are
 * dropped (they are not meant for pickers) and duplicates keep the first row.
 */
export function parseCodexModelList(
  entries: ReadonlyArray<unknown>,
): ReadonlyArray<ReportedProviderModel> {
  const bySlug = new Map<string, ReportedProviderModel>();
  for (const entry of entries) {
    if (!isRecord(entry) || entry.hidden === true) continue;
    const raw = nonEmpty(entry.model) ?? nonEmpty(entry.id);
    const slug = raw ? (normalizeModelSlug(raw, "codex") ?? raw) : undefined;
    if (!slug || bySlug.has(slug)) continue;
    bySlug.set(slug, {
      slug,
      name: nonEmpty(entry.displayName) ?? slug,
      capabilities: createReportedCodexModelCapabilities({
        model: slug,
        ...(Array.isArray(entry.supportedReasoningEfforts)
          ? { supportedReasoningEfforts: entry.supportedReasoningEfforts.filter(isRecord) }
          : {}),
        defaultReasoningEffort: entry.defaultReasoningEffort,
        ...(Array.isArray(entry.serviceTiers)
          ? { serviceTiers: entry.serviceTiers.filter(isRecord) }
          : {}),
        defaultServiceTier: entry.defaultServiceTier,
        upgrade: entry.upgrade,
      }),
    });
  }
  return [...bySlug.values()];
}

/** Session-scoped lookup built from the session's own `model/list` response. */
export function readCodexReportedModelCapabilities(
  response: unknown,
): ReadonlyMap<string, ModelCapabilities> {
  const data = isRecord(response) && Array.isArray(response.data) ? response.data : [];
  return new Map(parseCodexModelList(data).map((model) => [model.slug, model.capabilities]));
}

/**
 * Instance-private skills from `skills/list`. Repository (`repo`) skills are
 * project-shared and come from the project scan, so they are excluded here.
 */
export function parseCodexInstanceSkills(
  entries: ReadonlyArray<unknown>,
): ReadonlyArray<ServerProviderSkill> {
  const byName = new Map<string, ServerProviderSkill>();
  for (const entry of entries) {
    const skills = isRecord(entry) && Array.isArray(entry.skills) ? entry.skills : [];
    for (const skill of skills) {
      if (!isRecord(skill) || skill.scope === "repo") continue;
      const name = nonEmpty(skill.name);
      const path = nonEmpty(skill.path);
      if (!name || !path || byName.has(name)) continue;
      const description = nonEmpty(skill.description);
      const shortDescription =
        (isRecord(skill.interface) ? nonEmpty(skill.interface.shortDescription) : undefined) ??
        nonEmpty(skill.shortDescription);
      const scope = nonEmpty(skill.scope);
      byName.set(name, {
        name,
        path,
        enabled: skill.enabled !== false,
        ...(description ? { description } : {}),
        ...(shortDescription ? { shortDescription } : {}),
        ...(scope ? { scope } : {}),
      });
    }
  }
  return [...byName.values()];
}

export interface CodexInstanceCatalog {
  readonly models: ReadonlyArray<ReportedProviderModel>;
  readonly skills: ReadonlyArray<ServerProviderSkill>;
}

/**
 * Opens a short-lived control client, pages `model/list` and reads the
 * instance skill catalog, then always closes the process. Rejects when the
 * budget elapses; callers fall back to built-ins. A failed skills read keeps
 * the models.
 */
export async function probeCodexInstanceCatalog(
  environment: CodexControlEnvironmentConfig,
  timeoutMs = CODEX_MODEL_PROBE_TIMEOUT_MS,
): Promise<CodexInstanceCatalog> {
  const signal = AbortSignal.timeout(timeoutMs);
  let client: CodexControlClient | undefined;
  try {
    client = await CodexControlClient.create(environment, signal);
    const opened = client;
    const listed = (async () => {
      const models = parseCodexModelList(await opened.listModels());
      const skills = await opened
        .listSkills([environment.cwd])
        .then(parseCodexInstanceSkills)
        .catch(() => []);
      return { models, skills };
    })();
    const aborted = new Promise<never>((_, reject) => {
      if (signal.aborted) reject(new Error("Codex model probe timed out."));
      signal.addEventListener("abort", () => reject(new Error("Codex model probe timed out.")), {
        once: true,
      });
    });
    return await Promise.race([listed, aborted]);
  } finally {
    await client?.closeAndWait();
  }
}
