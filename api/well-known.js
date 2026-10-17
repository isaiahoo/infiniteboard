// OAuth discovery documents (RFC 9728 protected resource metadata, RFC 8414 server metadata).
// vercel.json rewrites /.well-known/* here.
import { json, originOf, preflight } from "./_lib/http.js";

export function GET(request) {
  const origin = originOf(request);
  const doc = new URL(request.url).searchParams.get("doc");
  if (doc === "resource") {
    return json({
      resource: `${origin}/api/mcp`,
      authorization_servers: [origin],
      bearer_methods_supported: ["header"],
      scopes_supported: ["board"],
      resource_name: "InfiniteBoard",
    }, 200, { "Cache-Control": "public, max-age=300" });
  }
  return json({
    issuer: origin,
    authorization_endpoint: `${origin}/api/oauth/authorize`,
    token_endpoint: `${origin}/api/oauth/token`,
    registration_endpoint: `${origin}/api/oauth/register`,
    revocation_endpoint: `${origin}/api/oauth/revoke`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none", "client_secret_post", "client_secret_basic"],
    scopes_supported: ["board"],
    authorization_response_iss_parameter_supported: true,
  }, 200, { "Cache-Control": "public, max-age=300" });
}

export const OPTIONS = preflight;
