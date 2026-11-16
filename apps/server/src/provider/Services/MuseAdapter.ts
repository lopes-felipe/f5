/**
 * MuseAdapter — shape type for the Muse Code provider adapter.
 *
 * @module MuseAdapter
 */
import type { ProviderAdapterError } from "../Errors.ts";
import type { ProviderAdapterShape } from "./ProviderAdapter.ts";

export interface MuseAdapterShape extends ProviderAdapterShape<ProviderAdapterError> {}
