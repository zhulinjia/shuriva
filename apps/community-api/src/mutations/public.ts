/** Public structured-plan contract. A valid plan is not authority to preview or execute. */
export { type MutationPlan, mutationPlanSchema } from "./model.js";
/** Read-only infrastructure schema inspection for explicit coordinated migrations. */
export { inspectStage8 as inspectMutationSchema } from "./migration.js";
