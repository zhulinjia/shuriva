import { useState } from "react"
import { CalendarIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Calendar } from "@/components/ui/calendar"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"

/** Controlled single-date composition built from the official Calendar and Popover. */
export function DatePicker({ value, onChange, disabled = false, label = "选择日期" }: { value?: Date; onChange: (value: Date | undefined) => void; disabled?: boolean; label?: string }) {
  const [open, setOpen] = useState(false)
  return <Popover open={open} onOpenChange={setOpen}><PopoverTrigger render={<Button type="button" variant="outline" disabled={disabled} />}><CalendarIcon />{value ? value.toLocaleDateString() : label}</PopoverTrigger><PopoverContent className="w-auto p-0" align="start"><Calendar mode="single" selected={value} onSelect={(date) => { onChange(date); setOpen(false) }} /></PopoverContent></Popover>
}
