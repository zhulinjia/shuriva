import assert from "node:assert/strict";
import { test } from "node:test";
import { changeDraftLimits, changeInput, validateChangeInput } from "../src/mcp/change-input.js";
import { boundedJson } from "../src/mcp/input-limits.js";

const workspaceId = "11111111-1111-4111-8111-111111111111",
  sourceId = "22222222-2222-4222-8222-222222222222",
  requestId = "33333333-3333-4333-8333-333333333333";
const grant = {
  workspaceId,
  sourceId,
  tables: [["orders", ["id", "label"]] as [string, string[]]],
};
const value = { kind: "string", value: "synthetic" };
const input = {
  workspaceId,
  sourceId,
  requestId,
  plan: {
    operation: "update",
    table: "orders",
    changes: [{ column: "label", value }],
    where: [{ column: "id", operator: "eq", value }],
  },
};
test("structured change handoff accepts only fields of the verified grant", () => {
  assert.deepEqual(validateChangeInput(input, grant), input);
  assert.throws(
    () => validateChangeInput({ ...input, workspaceId: sourceId }, grant),
    /MCP_SCOPE_REJECTED/,
  );
  assert.throws(
    () => validateChangeInput({ ...input, plan: { ...input.plan, table: "other" } }, grant),
    /MCP_SCOPE_REJECTED/,
  );
  assert.throws(
    () =>
      validateChangeInput(
        { ...input, plan: { ...input.plan, changes: [{ column: "secret", value }] } },
        grant,
      ),
    /MCP_SCOPE_REJECTED/,
  );
  assert.throws(
    () =>
      validateChangeInput(
        { ...input, plan: { ...input.plan, where: [{ column: "secret", operator: "eq", value }] } },
        grant,
      ),
    /MCP_SCOPE_REJECTED/,
  );
  assert.throws(
    () =>
      validateChangeInput({ ...input, plan: { ...input.plan, sql: "DELETE FROM orders" } }, grant),
    /MCP_PLAN_INVALID/,
  );
  assert.throws(
    () =>
      validateChangeInput(
        {
          ...input,
          plan: {
            ...input.plan,
            changes: [{ column: "label", value: { ...value, value: "x".repeat(24577) } }],
          },
        },
        grant,
      ),
    /MCP_PLAN_INVALID/,
  );
});

test("published draft complexity budget fits the actual JSON-RPC transport envelope", () => {
  assert.match(changeInput.description ?? "", /1800 JSON value nodes/);
  const rows = (count: number) =>
    Array.from({ length: count }, () =>
      ["a", "b", "c", "d"].map((column) => ({ column, value: { kind: "string", value: "x" } })),
    );
  const make = (count: number) => ({
    ...input,
    plan: { operation: "insert", table: "orders", rows: rows(count) },
  });
  const tooComplex = make(100);
  assert.ok(Buffer.byteLength(JSON.stringify(tooComplex)) < changeDraftLimits.bytes);
  assert.equal(changeInput.safeParse(tooComplex).success, false);
  const accepted = changeInput.parse(make(40));
  const wire = Buffer.from(
    JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "change_propose", arguments: accepted },
    }),
  );
  assert.doesNotThrow(() => boundedJson(wire));
});
