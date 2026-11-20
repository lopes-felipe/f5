import "../../index.css";
import { expect, it } from "vitest";
import { render } from "vitest-browser-react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ComposerPromptEditor } from "../ComposerPromptEditor";
import ChatMarkdown from "../ChatMarkdown";
import { serverConfigQueryOptions } from "../../lib/serverReactQuery";
import { createTestServerProvider } from "../../testServerProvider";
it("keeps a model reference as an editor token and a sent chip", async () => {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  const provider = createTestServerProvider("codex", {
    models: [{ slug: "gpt-5", name: "GPT-5", capabilities: {}, isCustom: false }],
  });
  const model = provider.models[0]!;
  client.setQueryData<unknown>(serverConfigQueryOptions().queryKey, { providers: [provider] });
  const raw = "model:" + provider.instanceId + "/" + model.slug;
  const screen = await render(
    <QueryClientProvider client={client}>
      <ComposerPromptEditor
        value={raw + " "}
        cursor={0}
        terminalContexts={[]}
        disabled={false}
        placeholder=""
        onChange={() => {}}
        onRemoveTerminalContext={() => {}}
        onPaste={() => {}}
      />
      <ChatMarkdown text={raw} cwd={undefined} />
    </QueryClientProvider>,
  );
  try {
    await expect.poll(() => document.querySelectorAll('[title="' + raw + '"]').length).toBe(2);
    expect(document.querySelector('[data-testid="composer-editor"]')?.textContent).toContain(
      model.name,
    );
  } finally {
    await screen.unmount();
    client.clear();
  }
});
