import type { ModelCapabilities, ServerProviderSkill } from "@t3tools/contracts";
import {
  createReportedCodexModelCapabilities,
  formatModelDisplayName,
  normalizeModelSlug,
} from "@t3tools/shared/model";

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
export function parseCodexModelList(entries: ReadonlyArray<unknown>): {
  models: ReadonlyArray<ReportedProviderModel>;
  presentSlugs: ReadonlyArray<string>;
} {
  const bySlug = new Map<string, ReportedProviderModel>();
  const presentSlugs = new Set<string>();
  for (const entry of entries) {
    if (!isRecord(entry)) continue;
    const raw = nonEmpty(entry.model) ?? nonEmpty(entry.id);
    const slug = raw ? (normalizeModelSlug(raw, "codex") ?? raw) : undefined;
    if (!slug) continue;
    presentSlugs.add(slug);
    if (entry.hidden === true || bySlug.has(slug)) continue;
    bySlug.set(slug, {
      slug,
      name: formatModelDisplayName("codex", slug) ?? nonEmpty(entry.displayName) ?? slug,
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
  return { models: [...bySlug.values()], presentSlugs: [...presentSlugs] };
}

export function applyConfiguredCodexServiceTier(
  models: ReadonlyArray<ReportedProviderModel>,
  serviceTier: unknown,
): ReadonlyArray<ReportedProviderModel> {
  if (typeof serviceTier !== "string") return models;
  return models.map((model) => {
    const tier = model.capabilities.serviceTiers?.find(
      (tier) => tier.id === serviceTier || (serviceTier === "fast" && tier.id === "priority"),
    );
    return tier
      ? { ...model, capabilities: { ...model.capabilities, defaultServiceTier: tier.id } }
      : model;
  });
}

async function readConfiguredServiceTier(client: CodexControlClient): Promise<unknown> {
  let cancelTimeout: (() => void) | undefined;
  try {
    return await Promise.race([
      // No cwd: the shared catalog must not inherit launch-project configuration.
      Promise.resolve()
        .then(() => client.readConfig(false))
        .then((result) => result.config.service_tier)
        .catch(() => undefined),
      new Promise<undefined>((resolve) => {
        const timer = setTimeout(() => resolve(undefined), 3_000);
        cancelTimeout = () => clearTimeout(timer);
      }),
    ]);
  } finally {
    cancelTimeout?.();
  }
}

/** Session-scoped lookup built from the session's own `model/list` response. */
export function readCodexReportedModelCapabilities(
  response: unknown,
): ReadonlyMap<string, ModelCapabilities> {
  const data = isRecord(response) && Array.isArray(response.data) ? response.data : [];
  return new Map(
    parseCodexModelList(
      data.map((row) => (isRecord(row) ? { ...row, hidden: false } : row)),
    ).models.map((model) => [model.slug, model.capabilities]),
  );
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
  readonly skills?: ReadonlyArray<ServerProviderSkill>;
  readonly presentSlugs: ReadonlyArray<string>;
  readonly complete: boolean;
  readonly fetchedAt: string;
  readonly anomaly?: string;
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
  parentSignal?: AbortSignal,
): Promise<CodexInstanceCatalog> {
  const timeout = AbortSignal.timeout(timeoutMs);
  const signal = parentSignal ? AbortSignal.any([parentSignal, timeout]) : timeout;
  let client: CodexControlClient | undefined;
  try {
    client = await CodexControlClient.create(environment, signal);
    const opened = client;
    const listed = (async () => {
      const [pages, serviceTier] = await Promise.all([
        opened.listModelPages(),
        readConfiguredServiceTier(opened),
      ]);
      const { models, presentSlugs } = parseCodexModelList(pages.entries);
      if (models.length === 0) throw new Error("Empty Codex model catalog");
      const skills = await opened
        .listSkills([environment.cwd])
        .then(parseCodexInstanceSkills)
        .catch(() => undefined);
      return {
        models: applyConfiguredCodexServiceTier(models, serviceTier),
        ...(skills ? { skills } : {}),
        presentSlugs,
        complete: pages.complete,
        ...(pages.anomaly ? { anomaly: pages.anomaly } : {}),
        fetchedAt: new Date().toISOString(),
      };
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
