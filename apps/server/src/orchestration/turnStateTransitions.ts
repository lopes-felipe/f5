export function canRepairErroredTurnFromSuccessfulSettlement(input: {
  readonly currentTurnId: string;
  readonly currentState: string;
  readonly completedAt: string | null;
  readonly settledTurnId: string | undefined;
  readonly settlementAt: string;
}): boolean {
  return (
    input.currentState === "error" &&
    input.settledTurnId !== undefined &&
    input.currentTurnId === input.settledTurnId &&
    (input.completedAt === null || input.settlementAt >= input.completedAt)
  );
}
