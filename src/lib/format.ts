const CURRENCY = new Intl.NumberFormat("zh-CN", {
  style: "currency",
  currency: "CNY",
  maximumFractionDigits: 2,
})

const SHORT_DATE_TIME = new Intl.DateTimeFormat("zh-CN", {
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
  timeZone: "Asia/Shanghai",
})

const SHORT_DATE = new Intl.DateTimeFormat("zh-CN", {
  month: "2-digit",
  day: "2-digit",
  timeZone: "Asia/Shanghai",
})

export function formatCurrency(value: number) {
  return CURRENCY.format(value)
}

export function formatDateTime(value: string) {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : SHORT_DATE_TIME.format(date)
}

export function formatShortDate(value: string | number | Date) {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? String(value) : SHORT_DATE.format(date)
}
