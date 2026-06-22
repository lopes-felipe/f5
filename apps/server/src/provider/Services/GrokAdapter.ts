/**
 * GrokAdapter — shape type for the Grok provider adapter.
 *
 * The driver model bundles one adapter per instance as a captured closure,
 * so this module only keeps a named shape interface for the driver bundle.
 *
 * @module GrokAdapter
 */
import type { ProviderAdapterError } from "../Errors.ts";
import type { ProviderAdapterShape } from "./ProviderAdapter.ts";

export interface GrokAdapterShape extends ProviderAdapterShape<ProviderAdapterError> {}
