import type { EngineMarkEngine } from "@/components/datasources/engine-mark"
import type { LiveSource } from "@/services/community-api"

export const engineName: Record<LiveSource["engine"], EngineMarkEngine> = {
  sqlite: "SQLite", postgresql: "PostgreSQL", mysql: "MySQL",
}
