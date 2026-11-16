import { expect, it } from "vitest";
import { rehearsalMcpApproval } from "./rehearsalMcpApproval";

const consent = {
  serverName: "__f5_computer",
  requestedSchema: { type: "object", properties: {} },
  _meta: { codex_approval_kind: "mcp_tool" },
};
it("accepts once only for the exact test server's represented consent", () => {
  expect(rehearsalMcpApproval("mcpServer/elicitation/request", consent, "__f5_computer")).toBe(
    "accept",
  );
});
it.each(["__f5_computer_lookalike", "computer-use", "cua_repl"])("refuses %s", (serverName) => {
  expect(
    rehearsalMcpApproval(
      "mcpServer/elicitation/request",
      { ...consent, serverName },
      "__f5_computer",
    ),
  ).toBe("decline");
});
it("refuses commands, missing provenance, URL consent and unrepresented form fields", () => {
  for (const [method, payload] of [
    ["item/commandExecution/requestApproval", consent],
    ["mcpServer/elicitation/request", { ...consent, serverName: undefined }],
    ["mcpServer/elicitation/request", { ...consent, mode: "url" }],
    [
      "mcpServer/elicitation/request",
      {
        ...consent,
        requestedSchema: { type: "object", properties: { password: { type: "string" } } },
      },
    ],
  ] as const)
    expect(rehearsalMcpApproval(method, payload, "__f5_computer")).toBe("decline");
});
