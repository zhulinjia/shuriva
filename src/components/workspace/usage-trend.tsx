import {
  Bar,
  BarChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  type TooltipContentProps,
} from "recharts"
import { MOCK_NOW } from "@/services"
import { formatShortDate } from "@/lib/format"

type UsageTrendProps = {
  values: readonly number[]
  activeCustomerCount: number
  compact?: boolean
}

function toSeries(values: readonly number[]) {
  const base = Date.parse(MOCK_NOW)

  return values.map((value, index) => {
    const date = new Date(base - (values.length - 1 - index) * 86_400_000)
    return {
      label: formatShortDate(date),
      value,
    }
  })
}

function UsageTooltip({ active, payload }: TooltipContentProps) {
  if (!active || !payload?.length) return null
  const item = payload[0]

  return (
    <div className="rounded-md border border-border bg-popover px-2.5 py-1.5 text-caption text-foreground shadow-raised">
      <span className="text-muted-foreground">{item.payload?.label}</span>
      <strong className="ml-2 font-medium tabular-nums">
        {item.value} 次访问
      </strong>
    </div>
  )
}

export function UsageTrend({
  values,
  activeCustomerCount,
  compact = false,
}: UsageTrendProps) {
  const series = toSeries(values)
  const first = series[0]?.label ?? ""
  const last = series.at(-1)?.label ?? ""
  const total = values.reduce((sum, value) => sum + value, 0)

  return (
    <div className="grid items-center gap-5 px-4 pb-4 max-[700px]:gap-3 max-[700px]:px-3 max-[700px]:pb-3 min-[701px]:grid-cols-[130px_minmax(0,1fr)]">
      <div>
        <p className="text-caption text-muted-foreground">授权范围内活跃客户</p>
        <p className="mt-1 text-number font-semibold text-foreground tabular-nums">
          {activeCustomerCount}
          <small className="ml-1 text-caption font-normal text-muted-foreground">
            位
          </small>
        </p>
        <p className="mt-1 text-caption leading-relaxed text-muted-foreground">
          示例活动数据，不随订单时间筛选变化
        </p>
      </div>

      <figure className="min-w-0">
        <div
          className="h-[104px] w-full"
          role="img"
          aria-label={`近 12 天模拟产品使用趋势，从 ${first} 到 ${last}，合计 ${total} 次访问。`}
        >
          <ResponsiveContainer width="100%" height="100%">
            <BarChart
              data={series}
              margin={{ top: 8, right: 0, bottom: 0, left: 0 }}
              barCategoryGap="28%"
              accessibilityLayer
            >
              <XAxis
                dataKey="label"
                interval={2}
                tickLine={false}
                axisLine={false}
                tick={{
                  fill: "var(--muted-foreground)",
                  fontSize: 9,
                }}
                tickMargin={6}
              />
              <Tooltip
                cursor={{ fill: "var(--muted)", opacity: 0.55 }}
                content={UsageTooltip}
              />
              <Bar
                dataKey="value"
                name="每日访问次数"
                fill="var(--chart-1)"
                radius={[3, 3, 0, 0]}
                isAnimationActive={false}
              />
            </BarChart>
          </ResponsiveContainer>
        </div>
        <figcaption className="mt-1 text-right text-caption text-muted-foreground">
          {first} — {last} · 每日访问次数
        </figcaption>

        <details className="mt-1 text-caption text-muted-foreground">
          <summary className="cursor-pointer rounded-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring">
            查看数据表
          </summary>
          <div className="mt-1.5 max-h-36 overflow-y-auto rounded-md border border-border">
            <table className="w-full text-left">
              <caption className="sr-only">
                近 12 天每日访问次数（模拟数据）
              </caption>
              <thead className="bg-muted/50">
                <tr>
                  <th scope="col" className="px-2 py-1 font-medium">
                    日期
                  </th>
                  <th scope="col" className="px-2 py-1 text-right font-medium">
                    访问次数
                  </th>
                </tr>
              </thead>
              <tbody>
                {series.map((item) => (
                  <tr key={item.label} className="border-t border-border">
                    <td className="px-2 py-1">{item.label}</td>
                    <td className="px-2 py-1 text-right tabular-nums">
                      {item.value}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>

        {compact ? (
          <table className="sr-only">
            <caption>近 12 天每日访问次数（模拟数据）</caption>
            <thead>
              <tr>
                <th scope="col">日期</th>
                <th scope="col">访问次数</th>
              </tr>
            </thead>
            <tbody>
              {series.map((item) => (
                <tr key={item.label}>
                  <td>{item.label}</td>
                  <td>{item.value}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : null}
      </figure>
    </div>
  )
}
