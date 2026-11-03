import { performance } from "node:perf_hooks";
import type { ExecuteValues, FieldPacket, Pool, PoolConnection, QueryResult } from "mysql2/promise";
import { ExternalMcpError } from "./model.js";
export interface MetadataSession {
  execute<T extends QueryResult = QueryResult>(
    sql: string,
    values?: ExecuteValues[],
  ): Promise<[T, FieldPacket[]]>;
  query<T extends QueryResult = QueryResult>(
    sql: string,
    values?: ExecuteValues[],
  ): Promise<[T, FieldPacket[]]>;
}
/** Metadata only. A timed-out transaction is destroyed and keeps its physical
 * slot; its server-side completion is not inferred from a rejected promise. */
export class MetadataDatabase {
  private outstanding = 0;
  constructor(private readonly pool: Pool) {}
  health() {
    return { outstanding: this.outstanding, capacity: 8, available: this.outstanding < 8 };
  }
  execute<T extends QueryResult = QueryResult>(sql: string, values: ExecuteValues[] = []) {
    return this.run((c) => c.execute<T>(sql, values));
  }
  query<T extends QueryResult = QueryResult>(sql: string, values: ExecuteValues[] = []) {
    return this.run((c) => c.query<T>(sql, values));
  }
  transaction<T>(action: (c: MetadataSession) => Promise<T>, assert: () => void = () => {}) {
    return this.run(action, true, assert);
  }
  private async run<T>(
    action: (c: MetadataSession) => Promise<T>,
    transaction = false,
    assert: () => void = () => {},
  ): Promise<T> {
    if (this.outstanding >= 8) throw new ExternalMcpError("EXTERNAL_MCP_STORAGE_CAPACITY", 503);
    this.outstanding++;
    let connection: PoolConnection | undefined,
      destroyed = false,
      expired = false,
      timer: ReturnType<typeof setTimeout> | undefined,
      started = false;
    const until = performance.now() + 5000;
    const destroy = () => {
      expired = true;
      if (connection && !destroyed) {
        destroyed = true;
        connection.destroy();
      }
    };
    const checkTime = () => {
      if (expired || performance.now() >= until) {
        destroy();
        throw new ExternalMcpError("EXTERNAL_MCP_STORAGE_TIMEOUT", 503);
      }
    };
    const check = () => {
      checkTime();
      assert();
    };
    const work = (async () => {
      try {
        connection = await this.pool.getConnection();
        check();
        const raw = connection;
        const c: MetadataSession = {
          async execute<U extends QueryResult>(sql: string, values: ExecuteValues[] = []) {
            check();
            const result = await raw.execute<U>(sql, values);
            check();
            return result;
          },
          async query<U extends QueryResult>(sql: string, values: ExecuteValues[] = []) {
            check();
            const result = await raw.query<U>(sql, values);
            check();
            return result;
          },
        };
        await c.query("SET SESSION innodb_lock_wait_timeout=2, SESSION lock_wait_timeout=2");
        if (transaction) {
          check();
          await raw.beginTransaction();
          started = true;
          check();
        }
        const result = await action(c);
        check();
        if (transaction) {
          await raw.commit();
          check();
        }
        return result;
      } catch (error) {
        if (
          connection &&
          !destroyed &&
          error &&
          typeof error === "object" &&
          "fatal" in error &&
          error.fatal === true
        ) {
          destroyed = true;
          connection.destroy();
        }
        if (connection && !destroyed && started) {
          try {
            checkTime();
            await connection.rollback();
            checkTime();
          } catch {
            destroyed = true;
            connection.destroy();
          }
        }
        throw error;
      } finally {
        if (connection && !destroyed) connection.release();
        if (!destroyed) this.outstanding--;
      }
    })();
    try {
      return await Promise.race([
        work,
        new Promise<never>((_yes, no) => {
          timer = setTimeout(() => {
            destroy();
            no(new ExternalMcpError("EXTERNAL_MCP_STORAGE_TIMEOUT", 503));
          }, 5000);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}
