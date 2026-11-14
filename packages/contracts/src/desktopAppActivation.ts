import { Schema } from "effect";

export const DesktopAppActivationRequest = Schema.Struct({
  id: Schema.String,
  path: Schema.String,
});
export type DesktopAppActivationRequest = typeof DesktopAppActivationRequest.Type;
