/**
 * HarnessValidation - On-demand provider harness validation service.
 *
 * Runs install/auth/connectivity checks for supported provider CLIs without
 * requiring an active persisted thread binding.
 *
 * @module HarnessValidation
 */
import type { ProviderStartOptions, ServerHarnessValidationResult } from "@t3tools/contracts";
import { ServiceMap } from "effect";
import type { Effect } from "effect";

import type { ProviderValidationBusyError } from "../Errors.ts";

export interface HarnessValidationShape {
  readonly validate: (input?: {
    readonly providerOptions?: ProviderStartOptions;
  }) => Effect.Effect<ReadonlyArray<ServerHarnessValidationResult>, ProviderValidationBusyError>;
}

export class HarnessValidation extends ServiceMap.Service<
  HarnessValidation,
  HarnessValidationShape
>()("t3/provider/Services/HarnessValidation") {}
