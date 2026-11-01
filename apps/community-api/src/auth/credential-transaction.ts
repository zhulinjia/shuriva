import { AsyncLocalStorage } from "node:async_hooks";
import { Kysely, MysqlDialect, sql } from "kysely";
import { kyselyAdapter } from "@better-auth/kysely-adapter";
import type { BetterAuthOptions } from "better-auth";
import type { DBAdapter } from "better-auth/adapters";
import type { Pool } from "mysql2/promise";
import { OperationalError } from "../operational-error.js";

/** Keep credential verification, session insertion and password rotation on
 * one transaction connection. The SDK remains responsible for authentication.
 * The shared user-row lock also serializes with the local recovery command.
 */
export function credentialTransactions(pool: Pool) {
  // mysql2 exposes the callback pool for Kysely. Its lifecycle remains owned by
  // the app; fixtures guard both public promise and callback checkouts.
  const db = new Kysely<unknown>({ dialect: new MysqlDialect({ pool: pool.pool }) });
  const current = new AsyncLocalStorage<{ adapter: DBAdapter; signOutSessionId?: string }>();
  let configured: BetterAuthOptions | undefined;
  const adapter = (options: BetterAuthOptions): DBAdapter => {
    configured = options;
    const base = kyselyAdapter(db, { type: "mysql", transaction: true })(options);
    return new Proxy(base, {
      get(target, key) {
        const active = current.getStore()?.adapter ?? target;
        const value: unknown = Reflect.get(active, key, active);
        return typeof value === "function" ? value.bind(active) : value;
      },
    });
  };
  const run = async <T>(operation: () => Promise<T>): Promise<T> => {
    const options = configured;
    if (!options) throw new OperationalError("AUTH_ADAPTER_NOT_READY");
    const rollback = new Error("AUTH_RESPONSE_ROLLBACK");
    let failed: { value: T } | undefined;
    try {
      return await db
        .transaction()
        .setIsolationLevel("read committed")
        .execute(async (tx) => {
          // Community has one administrator. Use the same deterministic lock as
          // terminal recovery, before the SDK reads any credential or session.
          await sql`SELECT id FROM \`user\` ORDER BY id FOR UPDATE`.execute(tx);
          const scoped = kyselyAdapter(tx, { type: "mysql", transaction: false })(options);
          return current.run({ adapter: scoped }, async () => {
            const value = await operation();
            // HTTP failures are returned Responses, not thrown SDK APIErrors.
            // Neither form is allowed to commit a partially changed password.
            if (value instanceof Response && !value.ok) {
              failed = { value };
              throw rollback;
            }
            return value;
          });
        });
    } catch (error) {
      if (error === rollback && failed) return failed.value;
      throw error;
    }
  };
  const captureSignOutSession = (id: string | undefined) => {
    const state = current.getStore();
    if (!state) throw new OperationalError("AUTH_ADAPTER_NOT_READY");
    state.signOutSessionId = id;
  };
  const assertSignOutRevoked = async () => {
    const state = current.getStore();
    if (!state) throw new OperationalError("AUTH_ADAPTER_NOT_READY");
    if (!state.signOutSessionId) return;
    const row = await state.adapter.findOne({
      model: "session",
      select: ["id"],
      where: [{ field: "id", value: state.signOutSessionId }],
    });
    if (row) throw new OperationalError("AUTH_SESSION_REVOCATION_FAILED");
  };
  return { adapter, run, captureSignOutSession, assertSignOutRevoked };
}

/** Proxy preserves the SDK endpoint's generic call signature and metadata. */
export function transactionalEndpoint<T extends (...args: never[]) => unknown>(
  endpoint: T,
  run: <R>(operation: () => Promise<R>) => Promise<R>,
): T {
  return new Proxy(endpoint, {
    apply(target, receiver, args) {
      return run(async () => Reflect.apply(target, receiver, args));
    },
  });
}
