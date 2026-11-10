import { ChevronRight, Database, Users } from "lucide-react"
import type {
  CustomerRecord,
  Datasource,
  ModuleAccess,
  PermissionPolicy,
} from "@/services"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  ModuleFailure,
  ModuleFooter,
  ModuleHeading,
} from "../../module-shared/module-frame"

type RestoreSourceProps = {
  onRestoreSource?: (sourceId: string) => void
  restoringSourceId?: string | null
}

type CustomerProfileModuleProps = RestoreSourceProps & {
  access: ModuleAccess
  customers: readonly CustomerRecord[]
  selectedCustomer: CustomerRecord | undefined
  policy: PermissionPolicy | null
  showPhone: boolean
  source: Datasource | undefined
  onSelect: (customer: CustomerRecord) => void
  onClear: () => void
  onShowBindings: () => void
}

/** Customer profile / customer picker shown beside the orders module. */
export function CustomerProfileModule({
  access,
  customers,
  selectedCustomer,
  policy,
  showPhone,
  source,
  onSelect,
  onClear,
  onShowBindings,
  onRestoreSource,
  restoringSourceId,
}: CustomerProfileModuleProps) {
  return (
    <section className="overflow-hidden rounded-lg border border-border bg-card">
      <ModuleHeading
        title="客户资料"
        badge={
          <Badge variant="outline" className="font-normal">
            {source?.engine ?? "未绑定"}
          </Badge>
        }
        actions={
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            aria-label="客户资料数据来源"
            onClick={onShowBindings}
          >
            <Database aria-hidden="true" />
          </Button>
        }
      />
      {access.ok ? (
        selectedCustomer ? (
          <CustomerProfile
            customer={selectedCustomer}
            policy={policy}
            showPhone={showPhone}
            onClear={onClear}
          />
        ) : (
          <CustomerList customers={customers} onSelect={onSelect} />
        )
      ) : (
        <ModuleFailure
          access={access}
          onRestoreSource={onRestoreSource}
          restoringSourceId={restoringSourceId}
        />
      )}
      {access.ok ? <ModuleFooter source={source} /> : null}
    </section>
  )
}

type CustomerDirectoryModuleProps = RestoreSourceProps & {
  access: ModuleAccess
  customers: readonly CustomerRecord[]
  source: Datasource | undefined
  onShowBindings: () => void
}

/** Full customer directory used by the members workspace. */
export function CustomerDirectoryModule({
  access,
  customers,
  source,
  onShowBindings,
  onRestoreSource,
  restoringSourceId,
}: CustomerDirectoryModuleProps) {
  return (
    <section className="overflow-hidden rounded-lg border border-border bg-card">
      <ModuleHeading
        title="客户资料"
        count={access.ok ? customers.length : undefined}
        badge={
          <Badge variant="outline" className="font-normal">
            {source?.engine ?? "未绑定"}
          </Badge>
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
        customers.length > 0 ? (
          <div className="grid gap-2 px-4 pb-5 min-[701px]:grid-cols-2">
            {customers.map((customer) => (
              <div
                key={customer.id}
                className="rounded-lg border border-border bg-muted/50 px-3 py-2.5"
              >
                <div className="flex items-center gap-2.5">
                  <span className="grid size-9 shrink-0 place-items-center rounded-full bg-primary/10 text-label font-semibold text-primary">
                    {customer.name.slice(0, 1)}
                  </span>
                  <span className="min-w-0 flex-1">
                    <strong className="block truncate text-label font-medium text-foreground">
                      {customer.name}
                    </strong>
                    <small className="block truncate font-mono text-caption text-muted-foreground">
                      {customer.id}
                    </small>
                  </span>
                  <Badge
                    variant="outline"
                    className="border-success-border bg-success-soft font-normal text-success"
                  >
                    {customer.plan}
                  </Badge>
                </div>
                <dl className="mt-2 grid grid-cols-[auto_minmax(0,1fr)] gap-x-2 gap-y-1 text-caption">
                  <dt className="text-muted-foreground">门店</dt>
                  <dd className="truncate text-right text-foreground">
                    {customer.store}
                  </dd>
                  <dt className="text-muted-foreground">邮箱</dt>
                  <dd className="truncate text-right text-foreground">
                    {customer.email ?? "不可见"}
                  </dd>
                  <dt className="text-muted-foreground">注册</dt>
                  <dd className="text-right text-foreground tabular-nums">
                    {customer.registered}
                  </dd>
                </dl>
              </div>
            ))}
          </div>
        ) : (
          <p className="px-4 pb-8 text-center text-label text-muted-foreground">
            当前没有可见客户。记录范围由演示策略决定。
          </p>
        )
      ) : (
        <ModuleFailure
          access={access}
          onRestoreSource={onRestoreSource}
          restoringSourceId={restoringSourceId}
        />
      )}

      {access.ok ? <ModuleFooter source={source} /> : null}
    </section>
  )
}

function CustomerProfile({
  customer,
  policy,
  showPhone,
  onClear,
}: {
  customer: CustomerRecord
  policy: PermissionPolicy | null
  showPhone: boolean
  onClear: () => void
}) {
  return (
    <div className="px-4 pb-3">
      <div className="text-center">
        <span className="inline-grid size-12 place-items-center rounded-full bg-primary/10 text-lg font-semibold text-primary">
          {customer.name.slice(0, 1)}
        </span>
        <h4 className="mt-2 text-card-title font-medium text-foreground">
          {customer.name}
        </h4>
        <p className="mt-0.5 font-mono text-caption text-muted-foreground">
          {customer.id}
        </p>
        <Badge
          variant="outline"
          className="mt-1.5 border-success-border bg-success-soft font-normal text-success"
        >
          {customer.plan}
        </Badge>
      </div>

      <dl className="mt-3 divide-y divide-border text-caption">
        <ProfileRow label="所属门店">{customer.store}</ProfileRow>
        {customer.email !== undefined ? (
          <ProfileRow
            label="邮箱"
            hint={policy?.fields.email === "masked" ? "脱敏" : undefined}
          >
            {customer.email}
          </ProfileRow>
        ) : null}
        {showPhone && customer.phone !== undefined ? (
          <ProfileRow
            label="手机号"
            hint={policy?.fields.phone === "masked" ? "脱敏" : undefined}
          >
            {customer.phone}
          </ProfileRow>
        ) : null}
        <ProfileRow label="注册日期">{customer.registered}</ProfileRow>
        <ProfileRow label="订阅状态">
          <span className="inline-flex items-center gap-1.5">
            <span className="size-1.5 rounded-full bg-success" aria-hidden="true" />
            服务中
          </span>
        </ProfileRow>
      </dl>

      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="mt-2 w-full"
        onClick={onClear}
      >
        <Users aria-hidden="true" />
        查看全部客户
      </Button>
    </div>
  )
}

function ProfileRow({
  label,
  hint,
  children,
}: {
  label: string
  hint?: string
  children: React.ReactNode
}) {
  return (
    <div className="flex items-start justify-between gap-2 py-1.5">
      <dt className="flex items-center gap-1 text-muted-foreground">
        {label}
        {hint ? (
          <Badge
            variant="outline"
            className="h-4 border-warning-border bg-warning-soft px-1 text-[10px] font-normal text-warning"
          >
            {hint}
          </Badge>
        ) : null}
      </dt>
      <dd className="min-w-0 truncate text-right text-foreground">
        {children}
      </dd>
    </div>
  )
}

function CustomerList({
  customers,
  onSelect,
}: {
  customers: readonly CustomerRecord[]
  onSelect: (customer: CustomerRecord) => void
}) {
  if (customers.length === 0) {
    return (
      <p className="px-4 pb-5 text-center text-caption leading-relaxed text-muted-foreground">
        当前没有可见客户。记录范围由演示策略决定。
      </p>
    )
  }

  return (
    <div className="px-2 pb-2">
      <p className="px-2 pb-1 text-caption text-muted-foreground">
        点击客户，联动订单与使用数据
      </p>
      <div className="max-h-[330px] overflow-y-auto">
        {customers.map((customer) => (
          <button
            key={customer.id}
            type="button"
            onClick={() => onSelect(customer)}
            className="flex w-full items-center gap-2.5 rounded-md px-2 py-2 text-left transition-colors hover:bg-accent focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-ring"
          >
            <span className="grid size-7 shrink-0 place-items-center rounded-full bg-muted text-caption font-medium text-muted-foreground">
              {customer.name.slice(0, 1)}
            </span>
            <span className="min-w-0 flex-1">
              <strong className="block truncate text-label font-normal text-foreground">
                {customer.name}
              </strong>
              <small className="block truncate text-caption text-muted-foreground">
                {customer.plan} · {customer.store}
              </small>
            </span>
            <ChevronRight
              className="size-3.5 shrink-0 text-muted-foreground"
              aria-hidden="true"
            />
          </button>
        ))}
      </div>
    </div>
  )
}
