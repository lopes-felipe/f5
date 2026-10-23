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
const source = () =>
  injectMcpAppCsp(
    `<!doctype html><style>html,body{margin:0;height:100%}button{display:block;width:100%;height:100vh}</style><button id="act">Weather action</button><script>
const pending=new Map();let next=1;
const request=(method,params)=>new Promise(resolve=>{const id=next++;pending.set(id,resolve);parent.postMessage({jsonrpc:'2.0',id,method,params},'*');});
window.addEventListener('message',event=>{if(event.source===parent&&event.data?.jsonrpc==='2.0'&&pending.has(event.data.id)){pending.get(event.data.id)(event.data);pending.delete(event.data.id);}});
const ready=request('ui/initialize',{protocolVersion:'2026-01-26'}).then(()=>{parent.postMessage({jsonrpc:'2.0',method:'ui/notifications/initialized'},'*');parent.postMessage({mcpProbe:'ready'},'*');});
document.getElementById('act').onclick=async()=>{await ready; const mode=${JSON.stringify(mode)};
if(mode==='noop')return;
if(mode==='link'){const reply=await request('ui/open-link',{url:'https://example.com/weather'});parent.postMessage({mcpProbe:'done',reply},'*');return;}
if(mode==='navigate'){location.href='data:text/html,'+encodeURIComponent('<script>parent.postMessage({jsonrpc:"2.0",id:999,method:"tools/call",params:{name:"forecast",arguments:{city:"foreign"}}},"*");<\\/script>');return;}
const reply=await request(mode==='message'?'ui/message':'tools/call',mode==='message'?{role:'user',content:[{type:'text',text:'Explain this weather'}]}:{name:'forecast',arguments:{city:mode==='long'?Array(2500).fill('Weather detail').join('\\n'):'Berlin'}});parent.postMessage({mcpProbe:'done',reply},'*');};
</script>`,
    undefined,
  );
const receive = (event: MessageEvent) => {
  if (event.data?.mcpProbe) reports.push(event.data);
};
beforeEach(() => {
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
  await active?.unmount();
  active = undefined;
  window.removeEventListener("message", receive);
  vi.restoreAllMocks();
  useStore.setState({ threads: [] });
});
async function mount() {
  active = await render(
    <QueryClientProvider client={new QueryClient()}>
      <McpAppFrame app={app} threadId={threadId} />
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
