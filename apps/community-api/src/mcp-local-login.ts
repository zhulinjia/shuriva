import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import {
  auth,
  type OAuthClientProvider,
  type OAuthDiscoveryState,
  type StoredOAuthTokens,
} from "@modelcontextprotocol/client";
import { localAddress, localCredential, localEntry } from "./mcp/local-vault.js";
import { trustedLocalFetch } from "./mcp/local-channel.js";
import { mcpOAuthScopes } from "./mcp/oauth-config.js";

async function login() {
  const [
    reference,
    resource = "",
    issuer = "",
    clientId = "",
    callback = "",
    scope = "metadata:read",
  ] = process.argv.slice(2);
  if (
    ![7, 8].includes(process.argv.length) ||
    !reference ||
    !clientId ||
    clientId.length > 255 ||
    !scope.split(" ").every((s) => mcpOAuthScopes.some((known) => known === s)) ||
    !scope.split(" ").includes("metadata:read")
  )
    throw Error("MCP_LOCAL_ARGUMENT_INVALID");
  const resourceUrl = localAddress(resource, "/mcp"),
    issuerUrl = localAddress(issuer, "/api/auth"),
    redirect = localAddress(callback, "/callback");
  const entry = localEntry(reference),
    state = randomBytes(32).toString("base64url");
  let verifier = "",
    tokens: StoredOAuthTokens | undefined,
    discovery: OAuthDiscoveryState | undefined;
  const provider: OAuthClientProvider = {
    redirectUrl: callback,
    clientMetadata: {
      redirect_uris: [callback],
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code"],
      response_types: ["code"],
    },
    clientInformation: () => ({ client_id: clientId, issuer }),
    tokens: () => tokens,
    saveTokens: (value) => {
      tokens = value;
    },
    state: () => state,
    saveCodeVerifier: (value) => {
      verifier = value;
    },
    codeVerifier: () => verifier,
    saveDiscoveryState: (value) => {
      discovery = value;
    },
    discoveryState: () => discovery,
    redirectToAuthorization: (url) => {
      if (url.origin !== issuerUrl.origin || url.pathname !== "/api/auth/oauth2/authorize")
        throw Error("MCP_LOCAL_ISSUER_REJECTED");
      process.stderr.write(
        `Open this URL in the browser signed into Shuriva, then confirm the local user trust domain:\n${url.href}\n`,
      );
    },
  };
  const allowed = new Set([
    `${resourceUrl.origin}/.well-known/oauth-protected-resource/mcp`,
    `${resourceUrl.origin}/.well-known/oauth-protected-resource`,
    `${issuerUrl.origin}/.well-known/oauth-authorization-server/api/auth`,
    `${issuerUrl.origin}/.well-known/openid-configuration/api/auth`,
    `${issuer}/oauth2/token`,
  ]);
  const fetchFn: typeof fetch = async (input, init) => {
    const request = new Request(input, init);
    if (!allowed.has(request.url) || !["GET", "POST"].includes(request.method))
      throw Error("MCP_LOCAL_TARGET_REJECTED");
    const response = await trustedLocalFetch(
      resource,
      65536,
    )(new Request(request, { redirect: "error", signal: AbortSignal.timeout(10000) }));
    const reader = response.body?.getReader(),
      parts: Uint8Array[] = [];
    let size = 0;
    try {
      if (reader)
        for (;;) {
          const chunk = await reader.read();
          if (chunk.done) break;
          size += chunk.value.byteLength;
          if (size > 65536) throw Error("MCP_LOCAL_METADATA_TOO_LARGE");
          parts.push(chunk.value);
        }
    } finally {
      await reader?.cancel();
    }
    const bytes = Buffer.concat(parts, size);
    // Exact issuer/resource are independently enforced even with cached SDK discovery.
    if (response.ok && request.method === "GET") {
      const data: unknown = JSON.parse(Buffer.from(bytes).toString("utf8"));
      if (!data || typeof data !== "object") throw Error("MCP_LOCAL_METADATA_INVALID");
      if ("resource" in data && data.resource !== resource)
        throw Error("MCP_LOCAL_RESOURCE_REJECTED");
      if ("issuer" in data && data.issuer !== issuer) throw Error("MCP_LOCAL_ISSUER_REJECTED");
      if (
        "authorization_servers" in data &&
        (!Array.isArray(data.authorization_servers) ||
          data.authorization_servers.length !== 1 ||
          data.authorization_servers[0] !== issuer)
      )
        throw Error("MCP_LOCAL_ISSUER_REJECTED");
    }
    return new Response(bytes, { status: response.status, headers: response.headers });
  };
  let settle!: (value: { code: string; iss?: string } | { error: string }) => void;
  const returned = new Promise<{ code: string; iss?: string } | { error: string }>((resolve) => {
    settle = resolve;
  });
  let accepted = false;
  const server = createServer(
    { maxHeaderSize: 8192, headersTimeout: 5000, requestTimeout: 5000 },
    (req, res) => {
      res.setHeader("Cache-Control", "no-store");
      const url = new URL(req.url ?? "/", redirect.origin);
      if (
        accepted ||
        req.method !== "GET" ||
        req.headers.host !== redirect.host ||
        url.pathname !== redirect.pathname ||
        url.searchParams.getAll("state").length !== 1 ||
        url.searchParams.get("state") !== state ||
        !(
          (url.searchParams.getAll("code").length === 1 &&
            !!url.searchParams.get("code") &&
            !url.searchParams.has("error")) ||
          (url.searchParams.getAll("error").length === 1 && !url.searchParams.has("code"))
        )
      ) {
        res.writeHead(403).end("Callback rejected");
        return;
      }
      accepted = true;
      if (url.searchParams.has("error")) {
        res.writeHead(200).end("Authorization denied. Return to the local terminal.");
        settle({ error: "MCP_LOCAL_AUTH_DENIED" });
        return;
      }
      res
        .writeHead(200, { "content-type": "text/plain; charset=utf-8" })
        .end("Authorization received. Return to the local terminal.");
      settle({
        code: url.searchParams.get("code") as string,
        iss: url.searchParams.get("iss") ?? undefined,
      });
    },
  );
  const timer = setTimeout(() => {
    server.closeAllConnections();
    server.close();
  }, 120000);
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(Number(redirect.port), "127.0.0.1", resolve);
    });
    const options = {
      serverUrl: resource,
      resourceMetadataUrl: new URL(
        `${resourceUrl.origin}/.well-known/oauth-protected-resource/mcp`,
      ),
      scope,
      fetchFn,
    };
    if ((await auth(provider, options)) !== "REDIRECT") throw Error("MCP_LOCAL_AUTH_REJECTED");
    const response = await Promise.race([
      returned,
      new Promise<never>((_, reject) =>
        server.once("close", () => reject(Error("MCP_LOCAL_LOGIN_EXPIRED"))),
      ),
    ]);
    if ("error" in response) throw Error(response.error);
    if (
      (await auth(provider, {
        ...options,
        authorizationCode: response.code,
        iss: response.iss,
      })) !== "AUTHORIZED" ||
      !tokens
    )
      throw Error("MCP_LOCAL_AUTH_REJECTED");
    const saved = localCredential.parse({
      token: tokens.access_token,
      resource,
      clientId,
      expiresAt: Date.now() + Math.min(tokens.expires_in ?? 0, 300) * 1000,
    });
    if (saved.expiresAt <= Date.now()) throw Error("MCP_LOCAL_AUTH_REJECTED");
    entry.setPassword(JSON.stringify(saved));
    if (entry.getPassword() !== JSON.stringify(saved)) throw Error("MCP_LOCAL_VAULT_UNAVAILABLE");
    process.stderr.write(
      `Saved short-lived credentials in the OS credential store. Reference: ${reference}\n`,
    );
  } finally {
    clearTimeout(timer);
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    verifier = "";
    tokens = undefined;
  }
}
login().catch(() => {
  process.stderr.write(
    "MCP_LOCAL_LOGIN_FAILED: verify the registered local domain, callback and approved scope.\n",
  );
  process.exitCode = 1;
});
