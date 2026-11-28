import type { PairedServer } from "../src/core/pairing";

// The unsigned hosted simulator cannot use the iOS keychain. This fixture keeps
// its generated device credential in memory for the duration of the smoke test.
let pairedServer: PairedServer | null = null;

export async function readPairedServer() {
  return pairedServer;
}

export async function writePairedServer(server: PairedServer | null) {
  pairedServer = server;
}
