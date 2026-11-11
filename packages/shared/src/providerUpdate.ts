// Native updaters download large binaries silently; early termination can leave a partial install.
export const PROVIDER_UPDATE_TIMEOUT_MINUTES = 30;
export const PROVIDER_UPDATE_TIMEOUT_MS = PROVIDER_UPDATE_TIMEOUT_MINUTES * 60_000;
export const PROVIDER_UPDATE_TIMEOUT_MESSAGE = `Update timed out after ${PROVIDER_UPDATE_TIMEOUT_MINUTES} minutes.`;
