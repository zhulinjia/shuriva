import { create } from "zustand"
import { persist } from "zustand/middleware"
import type { PreviewRole, ProductEdition } from "@/services"

type DemoStore = {
  edition: ProductEdition
  previewRole: PreviewRole
  setEdition: (edition: ProductEdition) => void
  setPreviewRole: (role: PreviewRole) => void
  resetUi: () => void
}

export const useDemoStore = create<DemoStore>()(
  persist(
    (set) => ({
      edition: "community",
      previewRole: "owner",
      setEdition: (edition) =>
        set({ edition, previewRole: "owner" }),
      setPreviewRole: (previewRole) => set({ previewRole }),
      resetUi: () => set({ edition: "community", previewRole: "owner" }),
    }),
    {
      name: "shuriva-demo-ui-v1",
      partialize: (state) => ({
        edition: state.edition,
        previewRole: state.previewRole,
      }),
    }
  )
)
