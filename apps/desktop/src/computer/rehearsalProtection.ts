import { ComputerControlError } from "@t3tools/shared/computerControl";
import type { ComputerAutomationBackendStatus, ComputerInspectResult } from "@t3tools/contracts";
import { isAbsolute } from "node:path";
import { rehearsalExecutionCode } from "./rehearsalResponses";

export const BROWSER_PROTECTION_IDS = {
  browser: "com.google.Chrome",
  terminal: "com.apple.Terminal",
} as const;
export const BROWSER_SECURE_LABEL = "F5 browser secure fixture";
export const BROWSER_MARKER_LABEL = "F5 browser capture marker";
export const BROWSER_SECURE_SENTINEL = "F5_SYNTHETIC_PASSWORD_SENTINEL";

/** Keep permission/error enums, never native messages, app content or status detail. */
export function protectionFailureSummary(error: unknown, status: ComputerAutomationBackendStatus) {
  const result = error instanceof ComputerControlError ? error.error : undefined;
  return {
    outcome: result?._tag ?? "ProtectionCheckFailed",
    ...(result?._tag === "Unavailable"
      ? {
          unavailableReason: result.reason,
          ...(result.missing ? { missing: result.missing } : {}),
          ...(result.captureFailure
            ? {
                captureFailure: {
                  stage: result.captureFailure.stage,
                  ...(result.captureFailure.domain ? { domain: result.captureFailure.domain } : {}),
                  ...(result.captureFailure.code !== undefined
                    ? { code: result.captureFailure.code }
                    : {}),
                },
              }
            : {}),
        }
      : {}),
    ...(result?._tag === "Execution" && rehearsalExecutionCode(result.message)
      ? { executionCode: rehearsalExecutionCode(result.message) }
      : {}),
    helperAvailable: status.available,
    ...(!status.available ? { helperUnavailableReason: status.reason } : {}),
  };
}

/** Exact fixture-only arguments shared by headless setup and the desktop check.
 * The mock keychain is a Chrome test flag, never a production backend setting. */
export function protectionChromeArguments(
  profile: string,
  url: string,
  mode: "headless" | "desktop",
) {
  if (!isAbsolute(profile) || !/^http:\/\/127\.0\.0\.1:\d{1,5}\/[a-f0-9]{32}\/fixture$/.test(url))
    throw new Error("Invalid private fixture launch.");
  return [
    `--user-data-dir=${profile}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-sync",
    "--disable-background-networking",
    "--disable-extensions",
    "--use-mock-keychain",
    ...(mode === "headless"
      ? ["--headless=new", "--dump-dom"]
      : ["--new-window", "--window-size=800,600", "--window-position=650,100"]),
    url,
  ];
}

/** A different failure (or an unavailable helper) is never protection proof. */
export function expectedProtectionRefusal(
  error: unknown,
  kind: "typing-grant" | "secure-field" | "view-grant",
): boolean {
  if (!(error instanceof ComputerControlError)) return false;
  const result = error.error;
  return kind === "secure-field"
    ? result._tag === "TargetBlocked" && result.kind === "secure-field"
    : result._tag === "NotGranted" && result.needed === (kind === "view-grant" ? "view" : "type");
}

export interface ProtectionFixtureState {
  ready: true;
  secureFocused: boolean;
  secureUnchanged: boolean;
  inputEvents: number;
}
export function protectionFixtureState(value: unknown): ProtectionFixtureState | undefined {
  if (!value || typeof value !== "object") return undefined;
  const state = value as Record<string, unknown>;
  if (
    state.ready !== true ||
    typeof state.secureFocused !== "boolean" ||
    typeof state.secureUnchanged !== "boolean" ||
    !Number.isSafeInteger(state.inputEvents) ||
    (state.inputEvents as number) < 0 ||
    (state.inputEvents as number) > 1000
  )
    return undefined;
  return {
    ready: true,
    secureFocused: state.secureFocused,
    secureUnchanged: state.secureUnchanged,
    inputEvents: state.inputEvents as number,
  };
}

export function browserSecureInspection(snapshot: ComputerInspectResult): boolean {
  const secure = snapshot.nodes.filter((node) => node.name === BROWSER_SECURE_LABEL);
  return (
    snapshot.appId === BROWSER_PROTECTION_IDS.browser &&
    snapshot.accessible &&
    secure.length === 1 &&
    secure[0]!.focused &&
    secure[0]!.value === undefined &&
    secure[0]!.actions.length === 0 &&
    !JSON.stringify(snapshot).includes(BROWSER_SECURE_SENTINEL)
  );
}

/** Fixture content only; the password is synthetic and never sent to the server. */
export function browserProtectionHtml(statePath: string): string {
  if (!/^\/[a-f0-9]{32}\/state$/.test(statePath)) throw new Error("Invalid fixture state path.");
  return `<!doctype html><meta charset="utf-8"><title>F5 browser protection fixture</title>
<style>body{margin:40px;background:#eee;font:20px sans-serif}#marker{width:400px;height:40px;background:#00f;margin-bottom:30px}input{display:block;width:400px;height:40px;margin:20px 0;background:#f0f;border:0}</style>
<div id="marker" role="img" aria-label="${BROWSER_MARKER_LABEL}"></div>
<label for="secure">Synthetic password test</label>
<input id="secure" aria-label="${BROWSER_SECURE_LABEL}" type="password" autocomplete="off" autofocus value="${BROWSER_SECURE_SENTINEL}">
<script>
const secure=document.getElementById('secure');let inputEvents=0;
secure.addEventListener('input',()=>inputEvents++);
const report=()=>fetch(${JSON.stringify(statePath)},{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({ready:true,secureFocused:document.activeElement===secure,secureUnchanged:secure.value===${JSON.stringify(BROWSER_SECURE_SENTINEL)},inputEvents})}).catch(()=>{});
setInterval(report,100);report();
</script>`;
}
