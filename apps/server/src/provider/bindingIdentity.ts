import {
  ProviderDriverKind,
  defaultInstanceIdForDriver,
  type ProviderInstanceId,
  type ProviderKind,
} from "@t3tools/contracts";

export function resolveBindingInstanceId(binding: {
  readonly provider: ProviderKind;
  readonly providerInstanceId?: ProviderInstanceId | null;
}): ProviderInstanceId {
  return (
    binding.providerInstanceId ??
    defaultInstanceIdForDriver(ProviderDriverKind.make(binding.provider))
  );
}
