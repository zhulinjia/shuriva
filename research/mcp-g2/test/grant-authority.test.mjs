import assert from "node:assert/strict";
import { test } from "node:test";
import { grantAuthority } from "../dist/grant-authority.js";

const claims = { sub: "owner", client_id: "client", aud: "https://resource.invalid/mcp" };
const confirmed = async () => true;
const valid = {
  ownerId: "owner",
  clientId: "client",
  sessionId: "actual-session",
  resource: claims.aud,
  generation: 1,
  issuedGeneration: 1,
  expiresAt: Date.now() + 60000,
  revoked: false,
};

test("grant authority rejects missing/cross-principal/generation/expiry/removed-session records", async () => {
  for (const overrides of [
    null,
    { ownerId: "other" },
    { clientId: "other" },
    { sessionId: "" },
    { generation: 2 },
    { revoked: true },
    { expiresAt: 0 },
    { expiresAt: Number.NaN },
    { resource: "https://other.invalid/mcp" },
  ]) {
    const authorize = grantAuthority({
      observe: async (_hash, decide) =>
        decide({
          record: overrides === null ? null : { ...valid, ...overrides },
          sessionExpiresAt: valid.expiresAt,
        }),
    });
    assert.equal(await authorize("synthetic-token", claims, confirmed), false);
  }
  assert.equal(
    await grantAuthority({
      observe: async (_hash, decide) => decide({ record: valid, sessionExpiresAt: undefined }),
    })("synthetic-token", claims, confirmed),
    false,
  );
  assert.equal(
    await grantAuthority({
      observe: async (_hash, decide) =>
        decide({ record: valid, sessionExpiresAt: valid.expiresAt }),
    })("synthetic-token", claims, confirmed),
    true,
  );
});

test("revocation before the atomic observation cannot reuse an earlier grant state", async () => {
  let release, enter;
  const waiting = new Promise((resolve) => {
    enter = resolve;
  });
  const paused = new Promise((resolve) => {
    release = resolve;
  });
  let record = { ...valid };
  const authorize = grantAuthority({
    observe: async (_hash, decide) => {
      enter();
      await paused;
      return decide({ record, sessionExpiresAt: valid.expiresAt });
    },
  });
  const outcome = authorize("synthetic-token", claims, confirmed);
  await waiting;
  record = { ...record, generation: 2, revoked: true };
  release();
  assert.equal(await outcome, false);
});

test("atomic snapshot storage errors fail closed rather than returning cached authorization", async () => {
  const authorize = grantAuthority({
    observe: async () => {
      throw new Error("synthetic snapshot offline");
    },
  });
  await assert.rejects(() => authorize("synthetic-token", claims, confirmed));
});

test("grant and approval-session deadlines are rechecked after transaction completion", async () => {
  for (const expires of ["grant", "session"]) {
    let now = 0;
    const authorize = grantAuthority(
      {
        observe: async (_hash, decide) => {
          const result = await decide({
            record: { ...valid, expiresAt: expires === "grant" ? 100 : 1000 },
            sessionExpiresAt: expires === "session" ? 100 : 1000,
          });
          assert.equal(result, true);
          now = 101; // transaction completion crosses only the chosen deadline
          return result;
        },
      },
      () => now,
    );
    assert.equal(await authorize("synthetic-token", claims, confirmed), false);
  }
});
