import { fileURLToPath } from "node:url";
import { playwright } from "@vitest/browser-playwright";
import { defineConfig, mergeConfig } from "vitest/config";

import viteConfig from "./vite.config";

const srcPath = fileURLToPath(new URL("./src", import.meta.url));

export default mergeConfig(
  viteConfig,
  defineConfig({
    resolve: {
      alias: {
        "~": srcPath,
      },
    },
    test: {
      include: [
        "src/components/ChatView.browser.tsx",
        "src/components/ThreadSidebar.browser.tsx",
        "src/components/ThreadRecencyController.browser.tsx",
        "src/components/ThreadStatusNotificationController.browser.tsx",
        "src/components/KeybindingsToast.browser.tsx",
        "src/components/WebSocketConnectionSurface.browser.tsx",
        "src/components/settings/DisplayProfileSelector.browser.tsx",
        "src/components/settings/McpServersSettings.browser.tsx",
        "src/components/settings/SettingsRouteState.browser.tsx",
        "src/components/onboarding/HarnessValidationPanel.browser.tsx",
        "src/routes/-_chat.settings.browser.tsx",
        "src/routes/-_chat.index.browser.tsx",
        "src/components/chat/AssistantMessageActions.browser.tsx",
        "src/components/chat/ClaudeTraitsPicker.browser.tsx",
        "src/components/chat/CodexTraitsPicker.browser.tsx",
        "src/components/chat/ChatHeader.browser.tsx",
        "src/components/chat/CommandTranscriptCard.browser.tsx",
        "src/components/chat/MessagesTimeline.browser.tsx",
        "src/components/workflow/WorkflowCreateDialog.browser.tsx",
        "src/components/workflow/WorkflowImplementDialog.browser.tsx",
      ],
      browser: {
        enabled: true,
        provider: playwright(),
        instances: [{ browser: "chromium" }],
        headless: true,
      },
      testTimeout: 30_000,
      hookTimeout: 30_000,
    },
  }),
);
