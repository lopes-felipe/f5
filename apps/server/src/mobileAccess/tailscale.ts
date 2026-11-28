import { execFile } from "node:child_process";
import { isIPv4, isIPv6 } from "node:net";
import { networkInterfaces } from "node:os";
import { promisify } from "node:util";

const exec = promisify(execFile);
const MAC_TAILSCALE = "/Applications/Tailscale.app/Contents/MacOS/Tailscale";

export interface TailscaleInterface {
  address: string;
  magicDnsName?: string;
  detection: "cli" | "heuristic";
}

export function isTailscaleAddress(address: string): boolean {
  if (isIPv6(address)) return /^fd7a:115c:a1e0:/i.test(address);
  if (!isIPv4(address)) return false;
  const [first, second] = address.split(".").map(Number);
  return first === 100 && second !== undefined && second >= 64 && second <= 127;
}

export async function detectTailscale(): Promise<TailscaleInterface | null> {
  for (const binary of process.platform === "darwin"
    ? ["tailscale", MAC_TAILSCALE]
    : ["tailscale"]) {
    try {
      const { stdout } = await exec(binary, ["status", "--json"], {
        timeout: 3000,
        maxBuffer: 4 * 1024 * 1024,
        windowsHide: true,
      });
      const status = JSON.parse(stdout) as {
        BackendState?: unknown;
        Self?: { TailscaleIPs?: unknown; DNSName?: unknown };
      };
      if (status.BackendState !== "Running") return null;
      const addresses = status.Self?.TailscaleIPs;
      const address: unknown = Array.isArray(addresses) ? addresses[0] : null;
      if (typeof address !== "string" || !isTailscaleAddress(address)) return null;
      const dns = status.Self?.DNSName;
      const name = typeof dns === "string" ? dns.replace(/\.$/, "").toLowerCase() : "";
      return {
        address,
        detection: "cli",
        ...(/^(?:[a-z0-9-]+\.)+ts\.net$/.test(name) ? { magicDnsName: name } : {}),
      };
    } catch (error) {
      // A present but unhealthy CLI is authoritative. Use the heuristic only
      // when the binary is unavailable.
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  for (const [name, addresses] of Object.entries(networkInterfaces())) {
    if (!/^(utun|tailscale)/.test(name)) continue;
    const match = addresses?.find(({ address }) => isIPv4(address) && isTailscaleAddress(address));
    if (match) return { address: match.address, detection: "heuristic" };
  }
  return null;
}

export function formatMobileHost(address: string, port: number): string {
  return (isIPv6(address) ? "[" + address + "]" : address) + ":" + port;
}
