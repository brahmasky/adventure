export type HougeErrorCode =
  | "TRIGGER_VALIDATION_ERROR"
  | "IDEMPOTENCY_CONFLICT"
  | "TASK_CONTRACT_INVALID"
  | "POLICY_DENIED"
  | "APPROVAL_REQUIRED"
  | "REVALIDATION_DENIED"
  | "BUDGET_FUSE"
  | "RUN_STATE_INVALID"
  | "TOOL_SCHEMA_INVALID"
  | "TOOL_EXECUTION_FAILED";

export class HougeError extends Error {
  constructor(
    public readonly code: HougeErrorCode,
    message: string,
    public readonly details: Record<string, unknown> = {}
  ) {
    super(message);
    this.name = "HougeError";
  }
}
