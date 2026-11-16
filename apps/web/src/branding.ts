export const APP_BASE_NAME = "F5";
/** Only development builds carry a stage label; releases are plain "F5". */
export const APP_STAGE_LABEL: string | null = import.meta.env.DEV ? "Dev" : null;
export const APP_DISPLAY_NAME = APP_STAGE_LABEL
  ? `${APP_BASE_NAME} (${APP_STAGE_LABEL})`
  : APP_BASE_NAME;
export const APP_VERSION = import.meta.env.APP_VERSION || "0.0.0";
