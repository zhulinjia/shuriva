import type { McpOptions } from "@better-auth/mcp";

export const mcpOAuthScopes = [
  "metadata:read",
  "query:prepare",
  "operation:read",
  "operation:cancel",
  "change:propose",
] as const;

function validPage(path: string): boolean {
  return /^\/(?!\/)[A-Za-z0-9/_-]+$/.test(path);
}

function safeHttpUrl(raw: string): boolean {
  try {
    const url = new URL(raw);
    return (
      !url.username &&
      !url.password &&
      !raw.includes("#") &&
      !raw.includes("?") &&
      (url.protocol === "https:" ||
        (url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)))
    );
  } catch {
    return false;
  }
}

/** The deployment supplies the exact externally reachable resource and page
 * paths. Client approval and each action are checked by the application. */
export function createMcpOAuthOptions(input: {
  resource: string;
  loginPage: string;
  consentPage: string;
}): McpOptions {
  if (
    input.resource.length > 512 ||
    !safeHttpUrl(input.resource) ||
    !validPage(input.loginPage) ||
    !validPage(input.consentPage)
  )
    throw new Error("MCP_OAUTH_CONFIG_INVALID");
  return {
    resource: input.resource,
    resources: [input.resource],
    loginPage: input.loginPage,
    consentPage: input.consentPage,
    scopes: [...mcpOAuthScopes],
    grantTypes: ["authorization_code"],
    disableJwtPlugin: true,
    storeTokens: "hashed",
    accessTokenExpiresIn: 300,
    refreshTokenReuseInterval: 0,
    allowDynamicClientRegistration: false,
    allowUnauthenticatedClientRegistration: false,
    clientPrivileges: ({ session }) => Boolean(session),
    validateRedirectUri: (uri, registered) => registered.includes(uri) && safeHttpUrl(uri),
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
}
