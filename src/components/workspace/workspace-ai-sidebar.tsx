import type { ThreadMessageLike } from "@assistant-ui/react"
import type { Datasource, Workspace } from "@/services"
import { DraftChat } from "@/components/create/draft-chat"

const AI_INITIAL_MESSAGES: readonly ThreadMessageLike[] = [
  {
    role: "assistant",
    content: [
      {
        type: "text",
        text: "告诉我你想怎样修改工作台，例如隐藏字段、显示使用趋势或调整默认日期范围。\n\n修改会先显示为草稿，保存后才更新工作台；放弃修改会恢复已保存的版本。",
      },
    ],
  },
]

const AI_QUICK_PROMPTS = [
  "隐藏手机号列",
  "显示成本列",
  "增加使用趋势图表",
  "日期范围改为最近 7 天",
] as const

const AI_CONTEXT_NOTE =
  "本地 Mock 对话：只修改当前草稿的结构，不执行 SQL，也不代表真实权限验证。保存前不会影响已保存的工作台。"

type WorkspaceAiSidebarProps = {
  draft: Workspace
  datasources: readonly Datasource[]
  saving: boolean
  canEdit: boolean
  onDraftChange: (draft: Workspace) => void
  onOpenBindings: () => void
  onGeneratingChange: (running: boolean) => void
}

export function WorkspaceAiSidebar({
  draft,
  datasources,
  saving,
  canEdit,
  onDraftChange,
  onOpenBindings,
  onGeneratingChange,
}: WorkspaceAiSidebarProps) {
  return (
    <DraftChat
      draft={draft}
      datasources={datasources}
      onDraftChange={onDraftChange}
      onOpenBindings={onOpenBindings}
      title="AI 修改工作台"
      initialMessages={AI_INITIAL_MESSAGES}
      quickPrompts={AI_QUICK_PROMPTS}
      contextNote={AI_CONTEXT_NOTE}
      composerPlaceholder="描述要修改的工作台结构…"
      readOnly={!canEdit || saving}
      readOnlyMessage={saving ? "正在保存，请稍候。" : undefined}
      onRunningChange={onGeneratingChange}
    />
  )
}
