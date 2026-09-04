import { oauthProtectedResourceMetadata } from "../../lib/access";
import { AUTO_OPS_SCOPE } from "../../lib/oauth";

export const dynamic = "force-dynamic";

export async function GET(
  request: Request,
  context: { params: Promise<{ path: string[] }> },
) {
  const { path } = await context.params;
  const pathname = `/${path.join("/")}`;
  if (
    pathname === "/.well-known/oauth-protected-resource" ||
    pathname === "/.well-known/oauth-protected-resource/mcp" ||
    pathname === "/.well-known/oauth-protected-resource/api/mcp"
  ) {
    return Response.json(oauthProtectedResourceMetadata(request), {
      headers: { "cache-control": "public, max-age=300" },
    });
  }
  if (pathname === "/.well-known/oauth-authorization-server") {
    const origin = new URL(request.url).origin;
    return Response.json(
      {
        issuer: origin,
        authorization_endpoint: `${origin}/oauth/authorize`,
        token_endpoint: `${origin}/oauth/token`,
        registration_endpoint: `${origin}/oauth/register`,
        revocation_endpoint: `${origin}/oauth/revoke`,
        response_types_supported: ["code"],
        response_modes_supported: ["query"],
        grant_types_supported: ["authorization_code", "refresh_token"],
        token_endpoint_auth_methods_supported: ["none"],
        revocation_endpoint_auth_methods_supported: ["none"],
        code_challenge_methods_supported: ["S256"],
        scopes_supported: [AUTO_OPS_SCOPE],
        service_documentation: `${origin}/api/agent`,
      },
      { headers: { "cache-control": "public, max-age=300" } },
    );
  }
  return Response.json({ error: "Not found" }, { status: 404 });
}
