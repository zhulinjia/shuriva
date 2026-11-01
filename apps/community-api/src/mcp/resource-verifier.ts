import { getOAuthProviderApi, type OAuthOptions } from "@better-auth/oauth-provider";
import { APIError, createAuthEndpoint, isAPIError } from "better-auth/api";
import { z } from "zod";
import { AuthorizationWork } from "./authorization-work.js";
import type { AuthorizedMcpGrant, VerifiedMcpToken } from "./grant-authority.js";

type GrantAuthority = (
  token: string,
  initial: VerifiedMcpToken,
  confirm: () => Promise<VerifiedMcpToken | null>,
) => Promise<AuthorizedMcpGrant | null>;

/** Convert the verified SDK DTO at the boundary. No caller-supplied owner,
 * client or expiry is allowed to substitute for the SDK's token claims. */
function verifiedToken(claims: Readonly<Record<string, unknown>>): VerifiedMcpToken | null {
  const audience = typeof claims.aud === "string" ? [claims.aud] : claims.aud;
  if (
    typeof claims.sub !== "string" ||
    !claims.sub ||
    typeof claims.client_id !== "string" ||
    !claims.client_id ||
    typeof claims.iss !== "string" ||
    !claims.iss ||
    !Array.isArray(audience) ||
    audience.some((value: unknown) => typeof value !== "string") ||
    typeof claims.scope !== "string" ||
    typeof claims.exp !== "number" ||
    !Number.isSafeInteger(claims.exp) ||
    claims.exp <= 0 ||
    !Number.isSafeInteger(claims.exp * 1000)
  )
    return null;
  return {
    ownerId: claims.sub,
    clientId: claims.client_id,
    issuer: claims.iss,
    audience: [...audience],
    scopes: claims.scope.split(" "),
    expiresAt: claims.exp * 1000,
  };
}

/** Companion plugin used through the server API only. Its internal endpoint
 * must never be added to the externally accessible authentication allowlist. */
export function createMcpResourceVerifier(
  options: OAuthOptions<string[]>,
  authorize: GrantAuthority,
) {
  const authenticationWork = new AuthorizationWork();
  return {
    id: "mcp-server-resource-verifier",
    endpoints: {
      verifyMcpResourceToken: createAuthEndpoint(
        "/mcp-internal/token-check",
        { method: "POST", body: z.object({ token: z.string().min(1).max(4096) }).strict() },
        async (context) => {
          const check = async () =>
            authenticationWork.run(async () =>
              verifiedToken(
                await getOAuthProviderApi(context, options).requireActiveAccessToken(
                  context.body.token,
                ),
              ),
            );
          try {
            const initial = await check();
            if (!initial) throw new APIError("UNAUTHORIZED", { message: "MCP_TOKEN_REJECTED" });
            const grant = await authorize(context.body.token, initial, check);
            if (!grant) throw new APIError("UNAUTHORIZED", { message: "MCP_GRANT_REJECTED" });
            return grant;
          } catch (error) {
            if (isAPIError(error) && [400, 401, 403].includes(error.statusCode))
              throw new APIError("UNAUTHORIZED", { message: "MCP_TOKEN_REJECTED" });
            throw new APIError("SERVICE_UNAVAILABLE", { message: "MCP_AUTHORIZATION_UNAVAILABLE" });
          }
        },
      ),
    },
  };
}
