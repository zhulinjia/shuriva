export const preparationStages = [
  "checking_access",
  "submitting_schema",
  "waiting_connector",
  "reading_schema",
  "building_preview",
] as const;
export const generationStages = [
  "checking_context",
  "waiting_connector",
  "confirming_access",
  "contacting_model",
  "awaiting_model",
  "validating_plan",
] as const;
export type PreparationStage = (typeof preparationStages)[number];
export type GenerationStage = (typeof generationStages)[number];
export type ModelStage = PreparationStage | GenerationStage;
export type ModelActivityState = {
  kind: "prepare" | "generate";
  stage: ModelStage;
  startedAt: number;
  endedAt?: number;
  outcome: "running" | "ready" | "done" | "failed" | "cancelled";
};
export const stageLabels: Record<ModelStage, string> = {
  checking_access: "确认工作空间和数据源权限",
  submitting_schema: "提交结构读取请求",
  waiting_connector: "等待连接器接收任务",
  reading_schema: "连接器正在读取授权结构",
  building_preview: "核对敏感策略，整理发送范围",
  checking_context: "核对发送范围和模型配置",
  confirming_access: "重新确认本机权限和结构",
  contacting_model: "连接模型服务并发送请求",
  awaiting_model: "请求已发送，等待模型返回",
  validating_plan: "校验模型返回的查询计划",
};
export function isGenerationStage(value: unknown): value is GenerationStage {
  return typeof value === "string" && (generationStages as readonly string[]).includes(value);
}
