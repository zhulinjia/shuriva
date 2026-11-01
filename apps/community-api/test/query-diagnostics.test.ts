import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import type { QueryConnector } from "../src/connectors/public.js";
import type { ScopeSourceLookup } from "../src/datasources/public.js";
import { createDiagnosticLogger, withDiagnostics } from "../src/logging/public.js";
import { ReadService } from "../src/queries/service.js";

test("query registration emits correlation IDs even when history is disabled, without SQL or parameter values", async () => {
  const lines: string[] = [];
  const logger = createDiagnosticLogger({
    write: (line) => {
      lines.push(line);
    },
  });
  const scope = {
    ownerId: randomUUID(),
    workspaceId: randomUUID(),
    sourceId: randomUUID(),
    connectorId: randomUUID(),
  };
  const service = new ReadService({} as ScopeSourceLookup, {} as QueryConnector);
  const sql = "SELECT sensitive_business_value FROM orders WHERE secret = ?";
  try {
    await withDiagnostics(logger, {}, async () => {
      const id = service.jobs.create(
        scope,
        randomUUID(),
        sql,
        [{ kind: "string", value: "private-user-value" }],
        1,
      );
      await service.trackExecution(scope, id);
      const event = lines
        .map((line) => JSON.parse(line) as Record<string, unknown>)
        .find((entry) => entry.event === "query.registered");
      assert.equal(event?.taskId, id);
      assert.equal(event?.sourceId, scope.sourceId);
      assert.equal(event?.connectorId, scope.connectorId);
    });
    assert.equal(lines.join("").includes("sensitive_business_value"), false);
    assert.equal(lines.join("").includes("private-user-value"), false);
  } finally {
    service.close();
  }
});
