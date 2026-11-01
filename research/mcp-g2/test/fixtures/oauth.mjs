import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mcp } from "@better-auth/mcp";
import { betterAuth } from "better-auth";
import { getMigrations } from "better-auth/db/migration";
import { Kysely, MysqlDialect } from "kysely";
import {
  authSessionAccess,
  authSessionReferenceDeadline,
  createAuth,
} from "../../../../apps/community-api/dist/src/auth.js";
import { localResourceVerifier } from "../../dist/resource-verifier.js";
import { databaseFixture } from "./database.mjs";
import { grantFixture } from "./grants.mjs";

/** Two SDK instances share only explicitly configured auth tables/cookies.
 * The real product auth factory retains its own routes and transaction wrapper.
 * OAuth endpoints are exercised directly; no product router is widened in G2.
 */
export async function oauthFixture({
  approvalClock = () => Date.now(),
  resourceClock = () => Date.now(),
  extensionPlugins = () => [],
  oauthOptionsFactory,
} = {}) {
  const db = await databaseFixture();
  try {
    const origin = "http://127.0.0.1:19491";
    const secret = randomBytes(32).toString("hex");
    const resource = `${origin}/mcp`;
    const auth = createAuth(
      { databaseUrl: "mysql://unused/guarded-fixture", secret, origin },
      db.pool,
    );
    const sdkDatabase = new Kysely({ dialect: new MysqlDialect({ pool: db.sdkPool.pool }) });
    const defaultOAuthOptions = {
      resource,
      resources: [resource],
      loginPage: "/login",
      consentPage: "/consent",
      scopes: ["metadata:read", "query:prepare"],
      grantTypes: ["authorization_code"],
      disableJwtPlugin: true,
      storeTokens: "hashed",
      accessTokenExpiresIn: 300,
      refreshTokenReuseInterval: 0,
      allowDynamicClientRegistration: false,
      allowUnauthenticatedClientRegistration: false,
      clientPrivileges: ({ session }) => Boolean(session),
      validateRedirectUri: (uri, registered) => registered.includes(uri),
      // Windows MySQL folds table names. Explicit physical names keep the
      // SDK's startup schema validation aligned with the real identifiers.
      schema: {
        oauthClient: { modelName: "mcp_oauth_client" },
        oauthResource: { modelName: "mcp_oauth_resource" },
        oauthClientResource: { modelName: "mcp_oauth_client_resource" },
        oauthRefreshToken: { modelName: "mcp_oauth_refresh_token" },
        oauthAccessToken: { modelName: "mcp_oauth_access_token" },
        oauthConsent: { modelName: "mcp_oauth_consent" },
        oauthClientAssertion: { modelName: "mcp_oauth_client_assertion" },
      },
    };
    const oauthOptions = oauthOptionsFactory
      ? oauthOptionsFactory({ origin, resource })
      : defaultOAuthOptions;
    let grants;
    let sdkValidated = 0;
    const authorizeGrant = async (token, claims, confirmAuthentication) => {
      sdkValidated++;
      return grants ? grants.authorize(token, claims, confirmAuthentication) : false;
    };
    const options = {
      database: { db: sdkDatabase, type: "mysql" },
      secret,
      baseURL: origin,
      basePath: "/api/auth",
      trustedOrigins: [origin],
      advanced: { database: { generateId: () => randomUUID() } },
      logger: { disabled: true },
      onAPIError: { throw: true },
      session: { cookieCache: { enabled: false } },
      plugins: [
        mcp(oauthOptions),
        localResourceVerifier(
          oauthOptions,
          resource,
          `${origin}/api/auth`,
          authorizeGrant,
          "metadata:read",
          resourceClock,
        ),
        ...extensionPlugins({ oauthOptions, db, resource, issuer: `${origin}/api/auth` }),
      ],
    };
    const migration = await getMigrations(options);
    if (migration.unsafeChanges.length || migration.schemaProblems.length)
      throw new Error("G2_OAUTH_SCHEMA_UNSAFE");
    const migrationSql = await migration.compileMigrations();
    await migration.runMigrations();
    const [observedTables] = await db.pool.query("SHOW TABLES");
    const [caseMode] = await db.pool.query("SELECT @@lower_case_table_names AS mode");
    const provider = betterAuth(options);
    await provider.$context;
    const password = randomBytes(20).toString("hex");
    const email = `${randomUUID()}@example.invalid`;
    await auth.api.signUpEmail({ body: { name: "isolated-g2", email, password } });
    async function login() {
      const result = await auth.api.signInEmail({ body: { email, password }, returnHeaders: true });
      return {
        cookie: result.headers
          .getSetCookie()
          .map((v) => v.split(";")[0])
          .join("; "),
        userId: result.response.user.id,
        token: result.response.token,
      };
    }
    const identity = await login();
    const headers = new Headers({ cookie: identity.cookie, origin });
    const client = await provider.api.createOAuthClient({
      headers,
      body: {
        client_name: "isolated-g2-client",
        redirect_uris: ["http://127.0.0.1:19492/callback"],
        token_endpoint_auth_method: "none",
        grant_types: ["authorization_code"],
        application_type: "native",
        response_types: ["code"],
        scope: "metadata:read query:prepare",
      },
    });
    const sessions = authSessionAccess(auth, db.pool);
    const approvingSession = await sessions.authenticate({ cookie: identity.cookie });
    if (!approvingSession) throw new Error("G2_APPROVAL_SESSION_MISSING");
    grants = await grantFixture(
      db.pool,
      authSessionReferenceDeadline,
      approvingSession,
      client.client_id,
      resource,
    );
    const approvals = new Map();
    let consentGeneration;
    const codeKey = (code) => createHash("sha256").update(code).digest("hex");
    const remember = (code, generation) => {
      for (const [key, approval] of approvals)
        if (approval.expiresAt <= approvalClock()) approvals.delete(key);
      if (
        typeof code !== "string" ||
        !code ||
        !Number.isSafeInteger(generation) ||
        generation < 1 ||
        approvals.size >= 16
      )
        throw new Error("G2_APPROVAL_BINDING_REQUIRED");
      approvals.set(codeKey(code), { generation, expiresAt: approvalClock() + 300000 });
    };
    async function authorize(changes = {}) {
      const approvalGeneration = await grants.generation();
      const verifier = randomBytes(32).toString("base64url");
      const state = randomBytes(24).toString("base64url");
      const query = new URLSearchParams({
        client_id: client.client_id,
        redirect_uri: "http://127.0.0.1:19492/callback",
        response_type: "code",
        scope: "metadata:read",
        state,
        resource,
        code_challenge_method: "S256",
        code_challenge: createHash("sha256").update(verifier).digest("base64url"),
        ...changes,
      });
      const response = await provider.handler(
        new Request(`${origin}/api/auth/oauth2/authorize?${query}`, {
          headers,
          redirect: "manual",
        }),
      );
      return { response, verifier, state, query, approvalGeneration };
    }
    async function consent(attempt) {
      return grants.approve(attempt.approvalGeneration, async () => {
        const location = attempt.response.headers.get("location");
        if (!location) throw new Error("G2_CONSENT_REDIRECT_MISSING");
        const query = new URL(location, origin).searchParams;
        if (query.has("code")) {
          // Cached SDK consent is not a fresh application approval. Its generation
          // can only be advanced by the explicit consent POST below.
          if (consentGeneration !== attempt.approvalGeneration)
            throw new Error("G2_REAPPROVAL_REQUIRED");
          remember(query.get("code"), consentGeneration);
          return { code: query.get("code"), state: query.get("state") };
        }
        const response = await provider.handler(
          new Request(`${origin}/api/auth/oauth2/consent`, {
            method: "POST",
            headers: new Headers({
              cookie: identity.cookie,
              origin,
              "content-type": "application/json",
            }),
            body: JSON.stringify({
              accept: true,
              oauth_query: query.toString(),
            }),
          }),
        );
        if (response.status !== 200) throw new Error(`G2_CONSENT_REJECTED_${response.status}`);
        const result = await response.json();
        if (result.redirect !== true || typeof result.url !== "string")
          throw new Error("G2_CONSENT_RESPONSE_INVALID");
        // Origin-bearing consent POSTs use this installed SDK's JSON redirect contract.
        const destination = new URL(result.url);
        consentGeneration = attempt.approvalGeneration;
        remember(destination.searchParams.get("code"), attempt.approvalGeneration);
        return {
          code: destination.searchParams.get("code"),
          state: destination.searchParams.get("state"),
        };
      });
    }
    async function exchange(request) {
      const code = new URLSearchParams(await request.clone().text()).get("code");
      const key = code ? codeKey(code) : "";
      const approval = approvals.get(key);
      approvals.delete(key);
      const response = await provider.handler(request);
      if (!response.ok) return response;
      if (!approval || approval.expiresAt <= approvalClock())
        return Response.json(
          { error: "invalid_grant", error_description: "MCP_APPROVAL_STALE" },
          { status: 400 },
        );
      const value = await response.clone().json();
      if (typeof value.access_token !== "string") throw new Error("G2_ACCESS_TOKEN_MISSING");
      try {
        await grants.register(value.access_token, approval.generation);
      } catch (error) {
        return Response.json(
          {
            error: "invalid_grant",
            error_description:
              error instanceof Error && error.message === "G2_APPROVAL_STALE"
                ? "MCP_APPROVAL_STALE"
                : "MCP_AUTHORIZATION_UNAVAILABLE",
          },
          { status: 400 },
        );
      }
      return response;
    }
    async function token(code, verifier, changes = {}) {
      return exchange(
        new Request(`${origin}/api/auth/oauth2/token`, {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            grant_type: "authorization_code",
            code,
            code_verifier: verifier,
            client_id: client.client_id,
            redirect_uri: "http://127.0.0.1:19492/callback",
            resource,
            ...changes,
          }),
        }),
      );
    }
    async function introspect(token, clientId = client.client_id) {
      const response = await provider.handler(
        new Request(`${origin}/api/auth/oauth2/introspect`, {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({ token, client_id: clientId }),
        }),
      );
      return { response, payload: await response.json() };
    }
    return {
      ...db,
      origin,
      resource,
      auth,
      provider,
      headers,
      identity,
      password,
      email,
      client,
      authorize,
      consent,
      token,
      exchange,
      introspect,
      login,
      migrationSql,
      grants,
      sdkValidated: () => sdkValidated,
      validate: (token) => provider.api.g2ValidateToken({ body: { token } }),
      validateWith: async (token, expectedResource, expectedIssuer, scope) => {
        const other = betterAuth({
          ...options,
          plugins: [
            mcp(oauthOptions),
            localResourceVerifier(
              oauthOptions,
              expectedResource,
              expectedIssuer,
              authorizeGrant,
              scope,
              resourceClock,
            ),
          ],
        });
        await other.$context;
        return other.api.g2ValidateToken({ body: { token } });
      },
      schemaEvidence: {
        mode: caseMode[0].mode,
        tables: observedTables.map((row) => Object.values(row)[0]),
        planned: migration.toBeCreated.map((item) => item.table),
      },
      sessions,
    };
  } catch (error) {
    try {
      await db.close();
    } catch (cleanup) {
      throw new AggregateError([error, cleanup], "G2_OAUTH_FIXTURE_FAILED");
    }
    throw error;
  }
}
