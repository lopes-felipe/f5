/** The current server-verified account incarnation; credentials never enter this store. */
let generation: string | undefined;
let account: { host: string; viewerId: number; generation: string } | undefined;

export function setPrHubAccount(value: typeof account): void {
  account = value;
  generation = value?.generation;
}

/** Stable draft ownership survives credential replacement and server restart. */
export function getPrHubDraftIdentity(): readonly [string, number] | undefined {
  return account?.generation === generation && account
    ? [account.host, account.viewerId]
    : undefined;
}

export function getPrHubAccountGeneration(): string | undefined {
  return generation;
}

export function setPrHubAccountGeneration(value: string | undefined): void {
  generation = value;
}

export function assertPrHubAccountGeneration(expected: string | undefined): void {
  if (generation !== expected) {
    throw new Error("The GitHub account changed. Refresh PR Hub before continuing.");
  }
}
