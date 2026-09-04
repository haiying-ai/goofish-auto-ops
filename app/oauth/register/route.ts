import { OAuthError, registerOAuthClient } from "../../../lib/oauth";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    if (!request.headers.get("content-type")?.includes("application/json")) {
      throw new OAuthError("invalid_client_metadata", "客户端注册必须使用 JSON");
    }
    const body = (await request.json()) as Record<string, unknown>;
    const client = await registerOAuthClient({
      clientName: body.client_name,
      redirectUris: body.redirect_uris,
      tokenEndpointAuthMethod: body.token_endpoint_auth_method,
    });
    return Response.json(client, {
      status: 201,
      headers: { "cache-control": "no-store" },
    });
  } catch (error) {
    return oauthError(error);
  }
}

function oauthError(error: unknown) {
  const known = error instanceof OAuthError;
  return Response.json(
    {
      error: known ? error.code : "invalid_client_metadata",
      error_description: error instanceof Error ? error.message : "客户端注册失败",
    },
    {
      status: known ? error.status : 400,
      headers: { "cache-control": "no-store" },
    },
  );
}
