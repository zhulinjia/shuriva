import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { auth as sdkAuth } from "@modelcontextprotocol/client";
import { CallbackApprovals } from "../dist/callback.js";
import { oauthFixture } from "./fixtures/oauth.mjs";

test("official SDK OAuth Client discovers the actual provider, validates bound callback, then exchanges S256 code", async (t) => {
  const f = await oauthFixture();
  t.after(() => f.close());
  const identity = await f.sessions.authenticate({ cookie: f.identity.cookie });
  assert.ok(identity);
  const context = { ...identity, connectionId: randomUUID() };
  const redirectUri = "http://127.0.0.1:19492/callback";
  const issuer = `${f.origin}/api/auth`;
  const approvals = new CallbackApprovals((value) => f.sessions.active(value));
  const state = await approvals.begin({ ...context, issuer, resource: f.resource, redirectUri });
  let redirect, verifier, tokens, discovery;
  const provider = {
    redirectUrl: redirectUri,
    clientMetadata: {
      redirect_uris: [redirectUri],
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code"],
      response_types: ["code"],
      application_type: "native",
      scope: "metadata:read",
    },
    clientInformation: () => f.client,
    tokens: () => tokens,
    saveTokens: (value) => {
      tokens = value;
    },
    state: () => state,
    redirectToAuthorization: (value) => {
      redirect = value;
    },
    saveCodeVerifier: (value) => {
      verifier = value;
    },
    codeVerifier: () => verifier,
    saveDiscoveryState: (value) => {
      discovery = value;
    },
    discoveryState: () => discovery,
  };
  const paths = new Set([
    "/.well-known/oauth-protected-resource/mcp",
    "/.well-known/oauth-authorization-server/api/auth",
    "/api/auth/.well-known/oauth-authorization-server",
    "/api/auth/oauth2/token",
  ]);
  const visited = [];
  // In-process Request bridge for OAuth algorithms; native TCP/SSRF is covered
  // separately. This bridge is never a fallback to real external fetch.
  const fetchFn = async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    assert.equal(url.origin, f.origin);
    assert.ok(
      paths.has(url.pathname),
      "every discovery/token destination must be explicitly approved",
    );
    visited.push(url.pathname);
    return url.pathname === "/api/auth/oauth2/token"
      ? f.exchange(request)
      : f.provider.handler(request);
  };
  const options = {
    serverUrl: f.resource,
    scope: "metadata:read",
    fetchFn,
    resourceMetadataUrl: new URL(`${f.origin}/.well-known/oauth-protected-resource/mcp`),
  };
  assert.equal(await sdkAuth(provider, options), "REDIRECT");
  assert.ok(redirect);
  assert.equal(redirect.searchParams.get("state"), state);
  assert.equal(redirect.searchParams.get("code_challenge_method"), "S256");
  assert.equal(redirect.searchParams.get("resource"), f.resource);
  assert.equal(redirect.searchParams.get("scope"), "metadata:read");
  const consentResponse = await f.provider.handler(
    new Request(redirect, { headers: f.headers, redirect: "manual" }),
  );
  const approval = await f.consent({
    response: consentResponse,
    approvalGeneration: await f.grants.generation(),
  });
  const callback = new URL(redirectUri);
  callback.search = new URLSearchParams({
    code: approval.code,
    state: approval.state,
    iss: issuer,
  });
  const bound = await approvals.consume(callback.href, context);
  assert.equal(
    await sdkAuth(provider, {
      ...options,
      authorizationCode: bound.authorizationCode,
      iss: bound.authorizationResponseIssuer,
    }),
    "AUTHORIZED",
  );
  assert.ok(tokens.access_token);
  assert.equal(tokens.refresh_token, undefined);
  assert.equal((await f.validate(tokens.access_token)).active, true);
  assert.ok(visited.includes("/api/auth/oauth2/token"));
  await assert.rejects(() => approvals.consume(callback.href, context), /MCP_CALLBACK_REJECTED/);
});
