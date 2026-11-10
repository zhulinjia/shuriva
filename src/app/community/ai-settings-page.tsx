import { useQuery } from "@tanstack/react-query"
import { Button } from "@/components/ui/button"
import { getAiProviders } from "@/services/ai-api"
import { apiErrorMessage } from "@/services/community-api"
import { AiProviderSettings } from "./ai-provider-settings"

export function AiSettingsPage() {
    const settings = useQuery({ queryKey: ["live-ai-providers"], queryFn: getAiProviders, retry: false })
    return (
        <div className="mx-auto w-full max-w-5xl p-6 md:p-10">
            <h1 className="text-2xl font-semibold">AI 设置</h1>
            <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
                分别管理各家模型服务，选择一个用于创建和修改工作台。密钥加密保存在服务端，不会回显。
            </p>
            {settings.isError && (
                <div className="mt-5 flex flex-wrap items-center gap-3">
                    <p role="alert" className="text-sm text-destructive">
                        {settings.data
                            ? "无法刷新已保存的配置，当前输入已保留。"
                            : apiErrorMessage(settings.error, "读取 AI 配置失败，请重试。")}
                    </p>
                    <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        disabled={settings.isFetching}
                        onClick={() => void settings.refetch()}
                    >
                        重新读取
                    </Button>
                </div>
            )}
            {settings.data ? (
                <AiProviderSettings state={settings.data} />
            ) : settings.isPending ? (
                <p className="mt-7 text-sm text-muted-foreground" role="status">
                    正在读取配置…
                </p>
            ) : null}
        </div>
    )
}
