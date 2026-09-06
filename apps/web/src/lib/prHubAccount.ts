/** The current server-verified account incarnation; credentials never enter this store. */
let generation: string | undefined;

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
