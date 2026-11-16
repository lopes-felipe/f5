import "../../index.css";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { EventId, ThreadId } from "@t3tools/contracts";
import { injectMcpAppCsp, type McpAppView } from "@t3tools/shared/mcpApp";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import { render } from "vitest-browser-react";
import { useStore } from "../../store";
import type { Thread } from "../../types";
import { McpAppFrame } from "./McpAppFrame";
const api = vi.hoisted(() => ({
  toolInfo: vi.fn(),
  callTool: vi.fn(),
  readResource: vi.fn(),
  updateModelContext: vi.fn(),
  openExternal: vi.fn(),
  submit: vi.fn(),
}));
const documentChecks = vi.hoisted(() => ({
  pauseNext: false,
  resume: undefined as (() => void) | undefined,
}));
vi.mock("../../lib/mcpAppDocumentGuard", async (original) => {
  const { makeMcpAppDocumentGuard } =
    await original<typeof import("../../lib/mcpAppDocumentGuard")>();
  return {
    makeMcpAppDocumentGuard: (...args: Parameters<typeof makeMcpAppDocumentGuard>) => {
      const guard = makeMcpAppDocumentGuard(...args);
      return {
        ...guard,
        check: async () => {
          const valid = await guard.check();
          if (documentChecks.pauseNext) {
            documentChecks.pauseNext = false;
            await new Promise<void>((resolve) => {
              documentChecks.resume = resolve;
            });
          }
          return valid;
        },
      };
    },
  };
});
vi.mock("../../nativeApi", () => ({
  ensureNativeApi: () => ({ mcpApps: api, shell: api, nextTurnQueue: api }),
}));
const threadId = ThreadId.makeUnsafe("mcp-app-browser");
const at = "2026-10-19T12:00:00.000Z";
const thread: Thread = {
  id: threadId,
  codexThreadId: null,
  projectId: "project" as Thread["projectId"],
  title: "Weather",
  model: "gpt-5",
  runtimeMode: "approval-required",
  interactionMode: "default",
  session: {
    provider: "codex",
    status: "ready",
    orchestrationStatus: "ready",
    createdAt: at,
    updatedAt: at,
  },
  messages: [],
  commandExecutions: [],
  proposedPlans: [],
  error: null,
  createdAt: at,
  archivedAt: null,
  lastInteractionAt: at,
  estimatedContextTokens: null,
  estimatedThinkingTokens: null,
  modelContextWindowTokens: null,
  latestTurn: null,
  branch: null,
  worktreePath: null,
  turnDiffSummaries: [],
  activities: [],
  detailsLoaded: true,
  tasks: [],
  tasksTurnId: null,
  tasksUpdatedAt: null,
};
const app: McpAppView = {
  reference: {
    attachmentId: "mcp-app-document",
    server: "weather",
    tool: "forecast",
    resourceUri: "ui://weather/dashboard",
  },
  arguments: { city: "Berlin" },
  result: { content: [{ type: "text", text: "Sunny" }] },
};
const originalFetch = globalThis.fetch;
let mode = "tool",
  reports: unknown[] = [];
let active: Awaited<ReturnType<typeof render>> | undefined;
let skew = 0;
let elsewhere: HTMLButtonElement | undefined;
const source = () =>
  injectMcpAppCsp(
    `<!doctype html><style>html,body{margin:0;height:100%}button{display:block;width:100%;height:100vh}</style><button id="act">Weather action</button><script>
const pending=new Map();let next=1;
const request=(method,params)=>new Promise(resolve=>{const id=next++;pending.set(id,resolve);parent.postMessage({jsonrpc:'2.0',id,method,params},'*');});
window.addEventListener('message',event=>{if(event.source===parent&&event.data?.jsonrpc==='2.0'&&pending.has(event.data.id)){pending.get(event.data.id)(event.data);pending.delete(event.data.id);}});
const ready=request('ui/initialize',{protocolVersion:'2026-01-26'}).then((reply)=>{parent.postMessage({jsonrpc:'2.0',method:'ui/notifications/initialized'},'*');parent.postMessage({mcpProbe:'ready',hostContext:reply.result?.hostContext},'*');});
const fullscreenMode=${JSON.stringify(mode)}==='fullscreen';
let displayMode='inline';
const askFullscreen=async(source,mode='fullscreen')=>{
 const reply=await request('ui/request-display-mode',{mode});
 displayMode=reply.result?.mode;
 parent.postMessage({mcpProbe:source,mode:displayMode},'*');
};
if(fullscreenMode){
 ready.then(()=>{document.getElementById('act').focus();void askFullscreen('load');});
 window.addEventListener('message',({data})=>{
  if(data==='retry'){document.getElementById('act').focus();void askFullscreen('retry');}
  if(data==='forge-retry'){
   Object.defineProperty(navigator,'userActivation',{value:{isActive:true},configurable:true});
   document.getElementById('act').focus();void askFullscreen('forge-retry');
  }
  if(data==='inline')void askFullscreen('inline','inline');
  if(data?.method==='ui/notifications/host-context-changed'){
   const left=displayMode==='fullscreen'&&data.params.displayMode==='inline';
   displayMode=data.params.displayMode??displayMode;
   if(left){document.getElementById('act').focus();void askFullscreen('exit');}
  }
 });
}
document.getElementById('act').onclick=async()=>{await ready; const mode=${JSON.stringify(mode)};
if(mode==='fullscreen'){void askFullscreen('tap');return;}
if(mode==='noop')return;
if(mode==='link'){const reply=await request('ui/open-link',{url:'https://example.com/weather'});parent.postMessage({mcpProbe:'done',reply},'*');return;}
if(mode==='navigate'){location.href='data:text/html,'+encodeURIComponent('<script>parent.postMessage({jsonrpc:"2.0",id:999,method:"tools/call",params:{name:"forecast",arguments:{city:"foreign"}}},"*");<\\/script>');return;}
const reply=await request(mode==='message'?'ui/message':'tools/call',mode==='message'?{role:'user',content:[{type:'text',text:'Explain this weather'}]}:{name:'forecast',arguments:{city:mode==='long'?Array(2500).fill('Weather detail').join('\\n'):'Berlin'}});parent.postMessage({mcpProbe:'done',reply},'*');};
</script>`,
    undefined,
  );
const receive = (event: MessageEvent) => {
  if (event.data?.mcpProbe) {
    const frame = [...document.querySelectorAll("iframe")].find(
      (frame) => frame.contentWindow === event.source,
    );
    reports.push({ ...event.data, frameTitle: frame?.title });
  }
};
beforeEach(() => {
  documentChecks.pauseNext = false;
  documentChecks.resume = undefined;
  skew = 0;
  const now = performance.now.bind(performance);
  vi.spyOn(performance, "now").mockImplementation(() => now() + skew);
  mode = "tool";
  reports = [];
  useStore.setState({ threads: [thread] });
  api.toolInfo.mockReset().mockResolvedValue({
    name: "forecast",
    readOnlyHint: false,
    sessionIdentity: "session-1",
    description: "Refresh weather",
  });
  api.callTool.mockReset().mockResolvedValue({ content: [{ type: "text", text: "Sunny" }] });
  api.submit.mockReset().mockResolvedValue({ disposition: "queued" });
  api.openExternal.mockReset().mockResolvedValue(undefined);
  api.readResource.mockReset().mockResolvedValue({ contents: [] });
  api.updateModelContext.mockReset().mockResolvedValue(undefined);
  vi.spyOn(globalThis, "fetch").mockImplementation((input, init) =>
    String(input).includes("/attachments/mcp-app-document")
      ? Promise.resolve(new Response(source(), { headers: { "content-type": "text/html" } }))
      : originalFetch(input, init),
  );
  window.addEventListener("message", receive);
});
afterEach(async () => {
  documentChecks.resume?.();
  elsewhere?.remove();
  elsewhere = undefined;
  await active?.unmount();
  active = undefined;
  window.removeEventListener("message", receive);
  vi.restoreAllMocks();
  useStore.setState({ threads: [] });
});
async function mount(withSibling = false) {
  active = await render(
    <QueryClientProvider client={new QueryClient()}>
      <McpAppFrame app={app} threadId={threadId} />
      {withSibling && (
        <McpAppFrame
          app={{
            ...app,
            reference: {
              ...app.reference,
              attachmentId: "mcp-app-document-sibling",
              tool: "sibling",
            },
          }}
          threadId={threadId}
        />
      )}
    </QueryClientProvider>,
  );
}
async function ready() {
  await expect
    .poll(() => reports.some((report) => (report as { mcpProbe?: string }).mcpProbe === "ready"))
    .toBe(true);
}
it("uses an opaque sandbox and calls a read-only tool without an approval prompt", async () => {
  api.toolInfo.mockResolvedValue({
    name: "forecast",
    readOnlyHint: true,
    sessionIdentity: "session-1",
  });
  await mount();
  await ready();
  expect(document.querySelector("iframe")?.getAttribute("sandbox")).toBe("allow-scripts");
  await page.getByTitle("forecast app", { exact: true }).click();
  await expect.poll(() => api.callTool.mock.calls.length).toBe(1);
  expect(api.callTool).toHaveBeenCalledWith({
    threadId,
    attachmentId: app.reference.attachmentId,
    name: "forecast",
    arguments: { city: "Berlin" },
    sessionIdentity: "session-1",
    approved: false,
  });
  expect(page.getByRole("dialog").query()).toBeNull();
});
it("gives the app the reader's palette, fonts and radius as host styles", async () => {
  await mount();
  await ready();
  const report = reports.find((entry) => (entry as { mcpProbe?: string }).mcpProbe === "ready") as {
    hostContext: { theme: string; styles: { variables: Record<string, string> } };
  };
  const variables = report.hostContext.styles.variables;
  for (const name of [
    "--color-background-info",
    "--color-text-info",
    "--color-border-secondary",
    "--color-ring-primary",
  ])
    expect(variables[name], name).toMatch(/^#[0-9a-f]{6}$/);
  expect(variables["--font-sans"]).toContain("Inter");
  expect(variables["--font-mono"]).toContain("JetBrains Mono");
  expect(variables["--border-radius-md"]).toBe("12px");
});
it("leaves fullscreen and waits for explicit approval before sending one tool call", async () => {
  await mount();
  await ready();
  await page.getByRole("button", { name: "Expand app", exact: true }).click();
  await page.getByTitle("forecast app", { exact: true }).click();
  await expect.element(page.getByRole("dialog")).toBeVisible();
  expect(api.callTool).not.toHaveBeenCalled();
  await expect
    .element(page.getByRole("button", { name: "Return to conversation", exact: true }))
    .not.toBeInTheDocument();
  await page.getByRole("button", { name: "Allow", exact: true }).click();
  await expect.poll(() => api.callTool.mock.calls.length).toBe(1);
  expect(api.callTool.mock.calls[0]?.[0]).toMatchObject({
    approved: true,
    sessionIdentity: "session-1",
  });
});
it("requires confirmation for ui/message and uses the durable normal submission path", async () => {
  mode = "message";
  await mount();
  await ready();
  await page.getByTitle("forecast app", { exact: true }).click();
  await expect.element(page.getByRole("dialog")).toBeVisible();
  expect(api.submit).not.toHaveBeenCalled();
  await page.getByRole("button", { name: "Allow", exact: true }).click();
  await expect.poll(() => api.submit.mock.calls.length).toBe(1);
  expect(api.submit.mock.calls[0]?.[0]).toMatchObject({
    intent: "auto",
    command: {
      type: "thread.turn.start",
      threadId,
      message: { text: "Explain this weather", role: "user" },
    },
  });
});
it("opens a link only after the user confirms it", async () => {
  mode = "link";
  await mount();
  await ready();
  await page.getByTitle("forecast app", { exact: true }).click();
  await expect.element(page.getByRole("dialog")).toHaveTextContent("https://example.com/weather");
  expect(api.openExternal).not.toHaveBeenCalled();
  await page.getByRole("button", { name: "Allow", exact: true }).click();
  await expect.poll(() => api.openExternal.mock.calls).toEqual([["https://example.com/weather"]]);
});
it("stops after navigation and rejects synthetic messages even with the iframe WindowProxy", async () => {
  mode = "navigate";
  await mount();
  await ready();
  const frame = document.querySelector<HTMLIFrameElement>("iframe")!;
  window.dispatchEvent(
    new MessageEvent("message", {
      source: frame.contentWindow!,
      data: { jsonrpc: "2.0", id: "forged", method: "tools/call", params: { name: "forecast" } },
    }),
  );
  await page.getByTitle("forecast app", { exact: true }).click();
  await expect
    .element(page.getByText("This app stopped after closing or navigating away.", { exact: true }))
    .toBeVisible();
  expect(api.toolInfo).not.toHaveBeenCalled();
  expect(api.callTool).not.toHaveBeenCalled();
});
it("leaves fullscreen for native approval while keeping the app bridge connected", async () => {
  await mount();
  await ready();
  await page.getByRole("button", { name: "Expand app", exact: true }).click();
  useStore.setState({
    threads: [
      {
        ...thread,
        activities: [
          {
            id: EventId.makeUnsafe("approval"),
            createdAt: at,
            kind: "approval.requested",
            summary: "Approval",
            tone: "approval",
            payload: { requestId: "approval", requestKind: "command" },
            turnId: null,
          },
        ],
      },
    ],
  });
  await expect
    .element(page.getByRole("button", { name: "Return to conversation", exact: true }))
    .not.toBeInTheDocument();
  api.toolInfo.mockResolvedValue({
    name: "forecast",
    readOnlyHint: true,
    sessionIdentity: "session-1",
  });
  await page.getByTitle("forecast app", { exact: true }).click();
  await expect.poll(() => api.callTool.mock.calls.length).toBe(1);
});
it("shows the reconnect message when the native session is absent", async () => {
  useStore.setState({ threads: [{ ...thread, session: null }] });
  await mount();
  await expect
    .element(page.getByText("Send a message to reconnect.", { exact: true }))
    .toBeVisible();
  expect(document.querySelector("iframe")).toBeNull();
  expect(api.toolInfo).not.toHaveBeenCalled();
});

it("returns fullscreen to inline on a trusted Escape inside the opaque frame", async () => {
  mode = "noop";
  await mount();
  await ready();
  await page.getByRole("button", { name: "Expand app", exact: true }).click();
  await page.getByTitle("forecast app", { exact: true }).click();
  await userEvent.keyboard("{Escape}");
  await expect.element(page.getByRole("button", { name: "Expand app", exact: true })).toBeVisible();
  expect(api.toolInfo).not.toHaveBeenCalled();
});
it("does not execute a tool after the user cancels its approval", async () => {
  await mount();
  await ready();
  await page.getByTitle("forecast app", { exact: true }).click();
  await expect.element(page.getByRole("dialog")).toBeVisible();
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect
    .poll(() => reports.some((report) => (report as { mcpProbe?: string }).mcpProbe === "done"))
    .toBe(true);
  expect(api.callTool).not.toHaveBeenCalled();
});
it("abandons a pending catalog read when the user navigates away", async () => {
  let finish: ((value: unknown) => void) | undefined;
  api.toolInfo.mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  await mount();
  await ready();
  await page.getByTitle("forecast app", { exact: true }).click();
  await expect.poll(() => api.toolInfo.mock.calls.length).toBe(1);
  await active!.unmount();
  active = undefined;
  finish?.({ name: "forecast", readOnlyHint: true, sessionIdentity: "session-1" });
  await Promise.resolve();
  await Promise.resolve();
  expect(api.callTool).not.toHaveBeenCalled();
});

it("keeps long approval payloads scrollable with both decisions visible", async () => {
  mode = "long";
  await mount();
  await ready();
  await page.getByTitle("forecast app", { exact: true }).click();
  await expect.element(page.getByRole("dialog")).toBeVisible();
  const pre = document.querySelector("[data-slot=dialog-popup] pre")!;
  expect(pre.textContent?.length).toBeGreaterThan(30000);
  expect(pre.getBoundingClientRect().height).toBeLessThanOrEqual(window.innerHeight * 0.6 + 1);
  expect(pre.scrollHeight).toBeGreaterThan(pre.clientHeight);
  for (const name of ["Allow", "Cancel"]) {
    const button = page.getByRole("button", { name, exact: true }).element();
    const rect = button.getBoundingClientRect();
    expect(rect.top).toBeGreaterThanOrEqual(0);
    expect(rect.bottom).toBeLessThanOrEqual(window.innerHeight);
  }
  expect(api.callTool).not.toHaveBeenCalled();
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
});

async function expectMode(probe: string, mode: string, frameTitle = "forecast app") {
  await expect
    .poll(() =>
      reports
        .filter((report) => {
          const value = report as { mcpProbe?: string; frameTitle?: string };
          return value.mcpProbe === probe && value.frameTitle === frameTitle;
        })
        .at(-1),
    )
    .toMatchObject({ mcpProbe: probe, mode });
}
function tellApp(message: string, title = "forecast app") {
  [...document.querySelectorAll("iframe")]
    .find((frame) => frame.title === title)!
    .contentWindow!.postMessage(message, "*");
}
function outsideButton() {
  elsewhere ??= document.body.appendChild(document.createElement("button"));
  elsewhere.textContent = "Elsewhere";
  return elsewhere;
}
it("denies fullscreen on load and idle retries, but permits app input and always permits exit", async () => {
  mode = "fullscreen";
  await userEvent.click(outsideButton());
  await mount();
  await ready();
  await expectMode("load", "inline");
  skew += 5_000;
  tellApp("retry");
  await expectMode("retry", "inline");
  await page.getByTitle("forecast app", { exact: true }).click();
  await expectMode("tap", "fullscreen");
  await expect.element(page.getByRole("button", { name: "Return to conversation" })).toBeVisible();
  outsideButton().focus();
  await userEvent.keyboard("a");
  tellApp("inline");
  await expectMode("inline", "inline");
  await expect.element(page.getByRole("button", { name: "Expand app", exact: true })).toBeVisible();
});
it("does not accept a sibling frame's activation or an app-forged activation property", async () => {
  mode = "fullscreen";
  await mount(true);
  await expectMode("load", "inline");
  await expectMode("load", "inline", "sibling app");
  skew += 5_000;
  await page.getByTitle("forecast app", { exact: true }).click();
  await expectMode("tap", "fullscreen");
  expect(navigator.userActivation.isActive).toBe(true);
  tellApp("retry", "sibling app");
  await expectMode("retry", "inline", "sibling app");
  expect(document.activeElement).toBe(page.getByTitle("sibling app", { exact: true }).element());
  tellApp("forge-retry", "sibling app");
  await expectMode("forge-retry", "inline", "sibling app");
});
it("rejects parent input arriving during a document check", async () => {
  mode = "fullscreen";
  await mount();
  await expectMode("load", "inline");
  skew += 5_000;
  documentChecks.pauseNext = true;
  await page.getByTitle("forecast app", { exact: true }).click();
  await expect.poll(() => documentChecks.resume).toBeTypeOf("function");
  outsideButton().focus();
  await userEvent.keyboard("a");
  documentChecks.resume!();
  await expectMode("tap", "inline");
  await expect.element(page.getByRole("button", { name: "Expand app", exact: true })).toBeVisible();
});
it("cannot reopen after Escape on the parent page", async () => {
  mode = "fullscreen";
  await mount();
  await expectMode("load", "inline");
  skew += 5_000;
  await page.getByTitle("forecast app", { exact: true }).click();
  await expectMode("tap", "fullscreen");
  page.getByRole("button", { name: "Return to conversation" }).element().focus();
  await userEvent.keyboard("{Escape}");
  await expectMode("exit", "inline");
  await expect.element(page.getByRole("button", { name: "Expand app", exact: true })).toBeVisible();
});
it("rejects activation elsewhere and cannot reopen after the exit button or Escape", async () => {
  mode = "fullscreen";
  await mount();
  await ready();
  await expectMode("load", "inline");
  await page.getByRole("button", { name: "Expand app", exact: true }).click();
  await page.getByRole("button", { name: "Return to conversation" }).click();
  await expectMode("exit", "inline");
  reports = [];
  tellApp("retry");
  await expectMode("retry", "inline");
  skew += 5_000;
  await page.getByTitle("forecast app", { exact: true }).click();
  await expectMode("tap", "fullscreen");
  await userEvent.keyboard("{Escape}");
  await expectMode("exit", "inline");
  await expect.element(page.getByRole("button", { name: "Expand app", exact: true })).toBeVisible();
});
