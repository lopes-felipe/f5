/** Stable identity shared by the server ledger and browser recovery controls. */
export function usageLimitFailureKey(
  limit:
    | {
        readonly providerInstanceId: string;
        readonly turnId?: string | null;
        readonly deliveryId?: string | null;
      }
    | null
    | undefined,
): string | null {
  if (!limit) return null;
  if (limit.turnId) return `instance:${limit.providerInstanceId}:turn:${limit.turnId}`;
  if (limit.deliveryId) return `instance:${limit.providerInstanceId}:delivery:${limit.deliveryId}`;
  return null;
}
