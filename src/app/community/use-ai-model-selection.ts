import { useState } from "react"
import { useQuery } from "@tanstack/react-query"
import { getAiProviders } from "@/services/ai-api"
import type { AiModelSelection } from "@/shared/ai-settings"

export function useAiModelSelection(initial?: AiModelSelection) {
    const providers = useQuery({ queryKey: ["live-ai-providers"], queryFn: getAiProviders, retry: false })
    const [selection, setSelection] = useState<AiModelSelection | undefined>(initial)
    return { providers, selection, setSelection }
}
