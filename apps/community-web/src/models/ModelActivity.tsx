import { Button } from "@workspace/ui";
import { Check, Circle, LoaderCircle, OctagonX } from "lucide-react";
import { useEffect, useState } from "react";
import {
  generationStages,
  type ModelActivityState,
  type ModelStage,
  preparationStages,
  stageLabels,
} from "./model-progress";

/** Time measures waiting; only observed application events advance the steps. */
export function ModelActivity({
  activity,
  onCancel,
  mode = "query",
}: {
  activity: ModelActivityState;
  onCancel: () => void;
  mode?: "query" | "mutation";
}) {
  const [now, setNow] = useState(Date.now());
  const running = activity.outcome === "running";
  useEffect(() => {
    setNow(Date.now());
    if (!running) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [running]);
  const stages: readonly ModelStage[] =
    activity.kind === "prepare" ? preparationStages : generationStages;
  const index = stages.indexOf(activity.stage);
  const seconds = Math.max(0, Math.floor(((activity.endedAt ?? now) - activity.startedAt) / 1000));
  const success = activity.outcome === "ready" || activity.outcome === "done";
  const title = running
    ? mode === "mutation" && activity.stage === "validating_plan"
      ? "校验变更候选与当前授权"
      : stageLabels[activity.stage]
    : activity.outcome === "ready"
      ? "发送范围已就绪，等待你确认"
      : activity.outcome === "done"
        ? mode === "mutation"
          ? "变更候选已返回并通过校验"
          : "计划已返回并通过校验"
        : activity.outcome === "cancelled"
          ? "当前操作已取消"
          : "本次处理未完成";
  return (
    <section
      className={`model-activity model-activity-${activity.outcome}`}
      aria-label="AI 处理进度"
    >
      <div className="model-activity-head">
        <strong role="status">
          {running ? (
            <LoaderCircle size={17} className="model-activity-spin" aria-hidden="true" />
          ) : success ? (
            <Check size={17} aria-hidden="true" />
          ) : (
            <OctagonX size={17} aria-hidden="true" />
          )}
          {title}
        </strong>
        <span className="model-activity-time" aria-live="off">
          已用 {seconds} 秒
        </span>
      </div>
      <ol className="model-activity-steps">
        {stages.map((stage, position) => {
          const done = success || position < index;
          const active = position === index && !success;
          return (
            <li
              key={stage}
              className={done ? "is-done" : active ? "is-active" : ""}
              aria-current={active ? "step" : undefined}
            >
              {done ? (
                <Check size={14} aria-hidden="true" />
              ) : (
                <Circle size={14} aria-hidden="true" />
              )}
              <span>
                {mode === "mutation" && stage === "validating_plan"
                  ? "校验变更候选与当前授权"
                  : stageLabels[stage]}
              </span>
            </li>
          );
        })}
      </ol>
      {running && (
        <div className="model-activity-footer">
          <p>
            {seconds >= 15
              ? "仍在处理当前步骤，你可以继续等待或取消。"
              : activity.kind === "prepare"
                ? "此时尚未向模型发送问题。"
                : mode === "mutation"
                  ? "完成后仅生成候选草稿，数据变更仍需完整预览和独立确认。"
                  : "完成后将展示查询计划，数据库查询仍需你手动执行。"}
          </p>
          <Button type="button" onClick={onCancel}>
            取消当前操作
          </Button>
        </div>
      )}
    </section>
  );
}
