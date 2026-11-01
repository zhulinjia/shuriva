import assert from "node:assert/strict";
import { test } from "node:test";
import type { Pool } from "mysql2/promise";
import { mysqlMcpGrantObservation } from "../src/mcp/mysql-grant-observation.js";

test("failed rollback destroys the owned connection and never returns it to the pool", async () => {
  let destroyed = false,
    released = false;
  const connection = {
    query: async () => {},
    beginTransaction: async () => {},
    execute: async () => {
      throw new Error("synthetic query failure");
    },
    rollback: async () => {
      throw new Error("synthetic rollback failure");
    },
    destroy: () => {
      destroyed = true;
    },
    release: () => {
      released = true;
    },
  };
  const pool = { getConnection: async () => connection } as unknown as Pool;
  const observation = mysqlMcpGrantObservation(pool, async () => undefined);
  await assert.rejects(() => observation.observe("a".repeat(64), async () => true), AggregateError);
  assert.equal(destroyed, true);
  assert.equal(released, false);
});

test("a stalled authorization destroys its locked connection and cannot commit later", async () => {
  let destroyed = false,
    released = false,
    committed = false,
    resume: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    resume = resolve;
  });
  const connection = {
    query: async () => {},
    beginTransaction: async () => {},
    execute: async () => [[]],
    commit: async () => {
      committed = true;
    },
    rollback: async () => {},
    destroy: () => {
      destroyed = true;
    },
    release: () => {
      released = true;
    },
  };
  const pool = { getConnection: async () => connection } as unknown as Pool;
  const observation = mysqlMcpGrantObservation(pool, async () => undefined, 20);
  await assert.rejects(
    () =>
      observation.observe("a".repeat(64), async () => {
        await gate;
        return true;
      }),
    /MCP_GRANT_DEADLINE_EXCEEDED/,
  );
  resume();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(destroyed, true);
  assert.equal(released, false);
  assert.equal(committed, false);
});

test("a late pool checkout is released and retains its bounded slot until it arrives", async () => {
  let give: (value: unknown) => void = () => {},
    released = 0,
    started = false;
  const checkout = new Promise((resolve) => {
    give = resolve;
  });
  const pool = { getConnection: async () => checkout } as unknown as Pool;
  const observation = mysqlMcpGrantObservation(pool, async () => undefined, 10);
  const requests = Array.from({ length: 8 }, () =>
    observation.observe("a".repeat(64), async () => true),
  );
  await assert.rejects(
    () => observation.observe("a".repeat(64), async () => true),
    /MCP_GRANT_CAPACITY/,
  );
  await Promise.all(
    requests.map((request) => assert.rejects(() => request, /MCP_GRANT_DEADLINE_EXCEEDED/)),
  );
  await assert.rejects(
    () => observation.observe("a".repeat(64), async () => true),
    /MCP_GRANT_CAPACITY/,
  );
  give({
    release: () => {
      released++;
    },
    beginTransaction: async () => {
      started = true;
    },
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(released, 8);
  assert.equal(started, false);
});

test("destroyed connections retain capacity because the server thread is not proven stopped", async () => {
  let resume: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    resume = resolve;
  });
  const pool = {
    getConnection: async () => ({
      query: async () => {},
      beginTransaction: async () => {},
      execute: async () => [[]],
      destroy: () => {},
      release: () => {},
      rollback: async () => {},
    }),
  } as unknown as Pool;
  const observation = mysqlMcpGrantObservation(pool, async () => undefined, 15);
  const requests = Array.from({ length: 8 }, () =>
    observation.observe("a".repeat(64), async () => {
      await gate;
      return true;
    }),
  );
  await Promise.all(
    requests.map((request) => assert.rejects(() => request, /MCP_GRANT_DEADLINE_EXCEEDED/)),
  );
  resume();
  await new Promise((resolve) => setImmediate(resolve));
  await assert.rejects(
    () => observation.observe("a".repeat(64), async () => true),
    /MCP_GRANT_CAPACITY/,
  );
});

test("an elapsed deadline prevents commit even when the timer callback has not run", async () => {
  let destroyed = false,
    committed = false;
  const connection = {
    query: async () => {},
    beginTransaction: async () => {},
    execute: async () => [[]],
    commit: async () => {
      committed = true;
    },
    rollback: async () => {},
    destroy: () => {
      destroyed = true;
    },
    release: () => {},
  };
  const pool = { getConnection: async () => connection } as unknown as Pool;
  const observation = mysqlMcpGrantObservation(pool, async () => undefined, 10);
  await assert.rejects(
    () =>
      observation.observe("a".repeat(64), async () => {
        const end = performance.now() + 25;
        while (performance.now() < end) {
          /* simulate delayed event loop */
        }
        return true;
      }),
    /MCP_GRANT_DEADLINE_EXCEEDED/,
  );
  assert.equal(destroyed, true);
  assert.equal(committed, false);
});

test("an unused checkout after a delayed timer is released without consuming capacity", async () => {
  let released = 0,
    destroyed = 0;
  const pool = {
    getConnection: async () => {
      const end = performance.now() + 20;
      while (performance.now() < end) {
        /* delay the timer callback */
      }
      return {
        release: () => {
          released++;
        },
        destroy: () => {
          destroyed++;
        },
      };
    },
  } as unknown as Pool;
  const observation = mysqlMcpGrantObservation(pool, async () => undefined, 5);
  for (let i = 0; i < 10; i++)
    await assert.rejects(
      () => observation.observe("a".repeat(64), async () => true),
      /MCP_GRANT_DEADLINE_EXCEEDED/,
    );
  assert.equal(released, 10);
  assert.equal(destroyed, 0);
});

test("a delayed grant query cannot start another locking session lookup", async () => {
  let lookup = false,
    destroyed = false;
  const pool = {
    getConnection: async () => ({
      query: async () => {},
      beginTransaction: async () => {},
      execute: async () => {
        const end = performance.now() + 20;
        while (performance.now() < end) {
          /* delay the timer callback */
        }
        return [
          [
            {
              id: "g",
              ownerId: "o",
              clientId: "c",
              approvalSessionId: "s",
              resource: "r",
              generation: 1,
              issuedGeneration: 1,
              expiresAt: new Date(Date.now() + 60_000),
              revokedAt: null,
            },
          ],
        ];
      },
      destroy: () => {
        destroyed = true;
      },
      release: () => {},
      rollback: async () => {},
    }),
  } as unknown as Pool;
  const observation = mysqlMcpGrantObservation(
    pool,
    async () => {
      lookup = true;
      return Date.now() + 60_000;
    },
    5,
  );
  await assert.rejects(
    () => observation.observe("a".repeat(64), async () => true),
    /MCP_GRANT_DEADLINE_EXCEEDED/,
  );
  assert.equal(lookup, false);
  assert.equal(destroyed, true);
});
