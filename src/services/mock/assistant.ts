import type { Datasource, Workspace } from "./types"

export type DraftEditResult = {
  reply: string
  /** `null` means the request did not change the draft. */
  draft: Workspace | null
}

function formatChanges(reply: string, changes: readonly string[]) {
  return `${reply}\n\n${changes.map((change) => `- ${change}`).join("\n")}`
}

function noChange(reply: string): DraftEditResult {
  return { draft: null, reply }
}

/**
 * Browser-only draft edit simulation. It never queries the database, never
 * changes permissions and never invents business values. It only adjusts the
 * workspace structure (visible modules, columns and filter defaults).
 */
export function applyMockDraftEdit(
  text: string,
  draft: Workspace,
  datasources: readonly Datasource[]
): DraftEditResult {
  const next = structuredClone(draft)
  const changes: string[] = []
  const wantsHide = /隐藏|移除|去掉|不要/.test(text)

  if (/手机/.test(text)) {
    next.config.showPhone = !wantsHide
    changes.push(
      wantsHide
        ? "从布局中隐藏手机号列；底层字段权限不会因此改变"
        : "在布局中显示已授权的手机号列"
    )
  }

  if (/成本/.test(text)) {
    next.config.showCost = !wantsHide
    changes.push(
      wantsHide
        ? "隐藏成本列"
        : "显示成本列；正式版本仍由字段权限决定是否可见"
    )
  }

  if (/趋势|折线|柱状|图表|使用情况|活跃/.test(text)) {
    if (draft.kind !== "customer") {
      return noChange(
        "当前模板不支持使用趋势模块。客户业务工作台可以组合订单、客户资料和使用趋势，你可以在创建时使用客户场景。"
      )
    }

    if (wantsHide) {
      next.config.showActivity = false
      changes.push("隐藏使用趋势模块")
    } else {
      next.config.showActivity = true
      if (!next.bindings.activity) {
        const eventSource = next.datasourceIds
          .map((id) => datasources.find((source) => source.id === id))
          .find((source) => source?.domain === "events")

        if (!eventSource) {
          return noChange(
            "增加趋势图需要用户行为数据源（包含 user_events 表）。请先在数据源中添加或选择一个行为数据源。"
          )
        }

        next.bindings.activity = eventSource.id
        changes.push("增加使用趋势模块，并绑定行为数据源")
      } else {
        changes.push("使用趋势模块已显示")
      }
    }
  }

  if (/7\s*天|一周|最近一周/.test(text)) {
    next.config.defaultDays = "7"
    changes.push("日期范围筛选切换为最近 7 天")
  } else if (/30\s*天|一个月|最近一月/.test(text)) {
    next.config.defaultDays = "30"
    changes.push("日期范围筛选切换为最近 30 天")
  } else if (/全部时间|所有时间|不限时间/.test(text)) {
    next.config.defaultDays = "all"
    changes.push("日期范围筛选切换为全部时间")
  } else if (/日期|时间范围|筛选器|筛选/.test(text)) {
    if (draft.config.defaultDays === "30") {
      changes.push("日期范围筛选已保留，默认最近 30 天")
    } else {
      next.config.defaultDays = "30"
      changes.push("增加日期范围筛选，默认最近 30 天")
    }
  }

  if (/指标|统计卡片|卡片/.test(text)) {
    changes.push("业务指标保持结构占位；接入真实查询后才展示数值")
  }

  if (changes.length === 0) {
    return noChange(
      "当前没有真实查询结果，无法回答具体业务数值。你可以继续调整工作台结构，例如隐藏手机号、显示成本、增加趋势图或调整日期范围。"
    )
  }

  const hasRealChange = JSON.stringify(next) !== JSON.stringify(draft)

  if (!hasRealChange) {
    return {
      draft: null,
      reply: formatChanges("当前结构里已经有这些内容：", changes),
    }
  }

  return {
    draft: next,
    reply: formatChanges("草稿预览已更新，请核对后保存。", changes),
  }
}
