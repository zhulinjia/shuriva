export type PlanStage =
  | "checking_context"
  | "waiting_connector"
  | "confirming_access"
  | "contacting_model"
  | "awaiting_model"
  | "validating_plan";
