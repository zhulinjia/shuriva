import { getOAuthProviderApi, type OAuthOptions } from "@better-auth/oauth-provider";
import { createAuthEndpoint } from "better-auth/api";
import { APIError } from "better-call";
import { z } from "zod";

/** A companion-plugin proof using the SDK's documented, read-only provider API.
 * G2 calls its server API directly. This test endpoint is never product-mounted.
 * There is no local implementation of OAuth or access to the plugin's tables.
 */
export function localResourceVerifier(
  options: OAuthOptions<string[]>,
  resource: string,
  issuer: string,
  authorizeGrant: (
    token: string,
    claims: Readonly<Record<string, unknown>>,
    confirmAuthentication: () => Promise<boolean>,
  ) => Promise<boolean>,
  requiredScope = "metadata:read",
  clock = () => Date.now(),
) {
  return {
    id: "g2-local-resource-verifier",
    endpoints: {
      g2ValidateToken: createAuthEndpoint(
        "/g2/internal-validate-token",
        {
          method: "POST",
          body: z.object({ token: z.string().min(1).max(4096) }),
        },
        async (context) => {
          let claims: Readonly<Record<string, unknown>>;
          try {
            claims = await getOAuthProviderApi(context, options).requireActiveAccessToken(
              context.body.token,
            );
          } catch (error) {
            if (error instanceof APIError && [400, 401, 403].includes(error.statusCode))
              throw new APIError("UNAUTHORIZED", { message: "MCP_TOKEN_REJECTED" });
            throw new APIError("SERVICE_UNAVAILABLE", { message: "MCP_AUTHORIZATION_UNAVAILABLE" });
          }
          const audience = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
          if (
            claims.iss !== issuer ||
            audience.length !== 1 ||
            audience[0] !== resource ||
            typeof claims.sub !== "string" ||
            typeof claims.client_id !== "string"
          )
            throw new APIError("UNAUTHORIZED", { message: "MCP_RESOURCE_REJECTED" });
          if (typeof claims.scope !== "string" || !claims.scope.split(" ").includes(requiredScope))
            throw new APIError("FORBIDDEN", { message: "MCP_SCOPE_REJECTED" });
          const initial = claims;
          const unexpired = (value: Readonly<Record<string, unknown>>) =>
            typeof value.exp === "number" &&
            Number.isFinite(value.exp) &&
            value.exp * 1000 > clock();
          if (!unexpired(initial))
            throw new APIError("UNAUTHORIZED", { message: "MCP_TOKEN_REJECTED" });
          let granted: boolean;
          try {
            granted = await authorizeGrant(context.body.token, initial, async () => {
              // The grant/session adapter keeps its locks while the public auth
              // API makes this final token observation. No cross-module SQL.
              const current = await getOAuthProviderApi(context, options).requireActiveAccessToken(
                context.body.token,
              );
              if (
                current.iss !== initial.iss ||
                current.sub !== initial.sub ||
                current.client_id !== initial.client_id ||
                current.scope !== initial.scope ||
                JSON.stringify(current.aud) !== JSON.stringify(initial.aud) ||
                !unexpired(current)
              )
                return false;
              claims = current;
              return true;
            });
          } catch (error) {
            if (error instanceof APIError && [400, 401, 403].includes(error.statusCode))
              throw new APIError("UNAUTHORIZED", { message: "MCP_TOKEN_REJECTED" });
            throw new APIError("SERVICE_UNAVAILABLE", { message: "MCP_AUTHORIZATION_UNAVAILABLE" });
          }
          if (!granted || !unexpired(claims))
            throw new APIError("UNAUTHORIZED", { message: "MCP_GRANT_REJECTED" });
          return claims;
        },
      ),
    },
  };
}
