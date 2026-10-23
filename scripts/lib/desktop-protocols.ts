import { PROMPT_LINK_SCHEME } from "@t3tools/shared/promptLinks";

/**
 * URL schemes the packaged app registers at install time: Info.plist on macOS and the desktop
 * entry on Linux. Development builds register `f5-dev` at runtime instead.
 */
export const DESKTOP_PROTOCOLS = [{ name: "F5 prompt link", schemes: [PROMPT_LINK_SCHEME] }];
