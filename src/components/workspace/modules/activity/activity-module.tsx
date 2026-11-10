import { Database } from "lucide-react"
import type { Datasource, ModuleAccess } from "@/services"
import { Button } from "@/components/ui/button"
import { UsageTrend } from "../../usage-trend"
import {
  ModuleFailure,
  ModuleFooter,
  ModuleHeading,
} from "../../module-shared/module-frame"

type ActivityModuleProps = {
  access: ModuleAccess
  trend: readonly number[]
  activeCustomerCount: number
  hasSelectedCustomer: boolean
  compact: boolean
  source: Datasource | undefined
  onShowBindings: () => void
  onRestoreSource?: (sourceId: string) => void
  restoringSourceId?: string | null
}

/** Usage trend for the customer workspace, scoped to the selected customer. */
export function ActivityModule({
  access,
  trend,
  activeCustomerCount,
  hasSelectedCustomer,
  compact,
  source,
  onShowBindings,
  onRestoreSource,
  restoringSourceId,
}: ActivityModuleProps) {
  const values = hasSelectedCustomer
    ? trend.map((value) => Math.round(value * 0.63))
    : trend

  return (
    <section className="overflow-hidden rounded-lg border border-border bg-card">
      <ModuleHeading
        title="产品使用趋势"
        aside={
          <span className="text-caption text-muted-foreground">
            近 12 天 · 按客户标识联动
          </span>
        }
        actions={
          <Button
            type="button"
            variant="ghost"
            size="xs"
            onClick={onShowBindings}
          >
            <Database aria-hidden="true" />
            来源
          </Button>
        }
      />
      {access.ok ? (
        <>
          <UsageTrend
            values={values}
            activeCustomerCount={
              hasSelectedCustomer ? 1 : activeCustomerCount
            }
            compact={compact}
          />
          <ModuleFooter source={source} />
        </>
      ) : (
        <ModuleFailure
          access={access}
          onRestoreSource={onRestoreSource}
          restoringSourceId={restoringSourceId}
        />
      )}
    </section>
  )
}
