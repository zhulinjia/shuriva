import assert from "node:assert/strict";
import { test } from "node:test";
import { createMcpOAuthOptions } from "../src/mcp/oauth-config.js";

test("MCP OAuth requires explicit safe resource and application-owned pages", () => {
  const valid = {
    resource: "https://service.example/mcp",
    loginPage: "/login",
    consentPage: "/mcp/consent",
  };
  const options = createMcpOAuthOptions(valid);
  assert.equal(options.resource, valid.resource);
  assert.deepEqual(options.grantTypes, ["authorization_code"]);
  assert.equal(options.storeTokens, "hashed");
  assert.equal(options.disableJwtPlugin, true);
  for (const resource of [
    "http://10.1.2.3/mcp",
    "https://user:pass@example.com/mcp",
    "https://example.com/mcp#fragment",
    "https://example.com/mcp?tenant=A",
    "invalid",
  ]) {
    assert.throws(() => createMcpOAuthOptions({ ...valid, resource }), /MCP_OAUTH_CONFIG_INVALID/);
  }
  for (const loginPage of [
    "//other.example",
    "https://other.example/login",
    "/login?return=other",
    "/\\other",
  ]) {
    assert.throws(() => createMcpOAuthOptions({ ...valid, loginPage }), /MCP_OAUTH_CONFIG_INVALID/);
  }
});

test("MCP redirect matching requires a registered safe exact callback", async () => {
  const options = createMcpOAuthOptions({
    resource: "http://127.0.0.1:3000/mcp",
    loginPage: "/login",
    consentPage: "/consent",
  });
  assert.ok(options.validateRedirectUri);
  const check = options.validateRedirectUri;
  assert.equal(
    await check("http://127.0.0.1:9876/callback", ["http://127.0.0.1:9876/callback"], true),
    true,
  );
  assert.equal(
    await check("http://127.0.0.1:9876/callback?x=1", ["http://127.0.0.1:9876/callback?x=1"], true),
    false,
  );
  assert.equal(
    await check("https://other.example/callback", ["https://client.example/callback"], true),
    false,
  );
  assert.equal(await check("custom://client/callback", ["custom://client/callback"], true), false);
});
