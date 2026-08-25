import {
  AUTO_OPS_SCOPE,
  configuredOwnerEmail,
  oauthResource,
  trustedChatGPTEmail,
  verifyAccessToken,
  type OAuthAccess,
} from "./oauth";

export type OwnerAccess =
  | ({ kind: "chatgpt" } & OAuthAccess)
  | ({ kind: "oauth" } & OAuthAccess);

export async function getOwnerAccess(request: Request): Promise<OwnerAccess | null> {
  const owner = configuredOwnerEmail();
  const chatGPTEmail = trustedChatGPTEmail(request);
  if (chatGPTEmail) {
    if (!owner || chatGPTEmail !== owner) return null;
    return {
      kind: "chatgpt",
      email: chatGPTEmail,
      clientId: "sites-siwc",
      scope: AUTO_OPS_SCOPE,
    };
  }
  const token = bearerToken(request);
  if (!token) return null;
  try {
    return { kind: "oauth", ...(await verifyAccessToken(token, request)) };
  } catch {
    return null;
  }
}

export async function requireOwnerAccess(request: Request) {
  const owner = configuredOwnerEmail();
  if (!owner) {
    return Response.json(
      { error: "站点所有者白名单尚未配置" },
      { status: 503, headers: { "cache-control": "no-store" } },
    );
  }
  const chatGPTEmail = trustedChatGPTEmail(request);
  if (chatGPTEmail && chatGPTEmail !== owner) {
    return Response.json(
      { error: "当前 ChatGPT 账号没有访问此 Auto Ops 的权限" },
      { status: 403, headers: { "cache-control": "no-store" } },
    );
  }
  if (await getOwnerAccess(request)) return null;
  return Response.json(
    { error: "请先使用站点所有者账号登录" },
    {
      status: 401,
      headers: {
        "cache-control": "no-store",
        "www-authenticate": `Bearer scope="${AUTO_OPS_SCOPE}"`,
      },
    },
  );
}

export async function requireMcpAccess(request: Request) {
  const token = bearerToken(request);
  if (!token) return null;
  try {
    return await verifyAccessToken(token, request);
  } catch {
    return null;
  }
}

export function mcpUnauthorized(request: Request) {
  const metadata = `${new URL(request.url).origin}/.well-known/oauth-protected-resource/api/mcp`;
  return Response.json(
    { error: "unauthorized", error_description: "需要 Auto Ops OAuth 授权" },
    {
      status: 401,
      headers: {
        "cache-control": "no-store",
        "www-authenticate": `Bearer resource_metadata="${metadata}", scope="${AUTO_OPS_SCOPE}"`,
        "access-control-allow-origin": "*",
        "access-control-expose-headers": "www-authenticate",
      },
    },
  );
}

export function oauthProtectedResourceMetadata(request: Request) {
  const origin = new URL(request.url).origin;
  return {
    resource: oauthResource(request),
    authorization_servers: [origin],
    scopes_supported: [AUTO_OPS_SCOPE],
    bearer_methods_supported: ["header"],
    resource_documentation: `${origin}/api/agent`,
  };
}

function bearerToken(request: Request) {
  const match = request.headers.get("authorization")?.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() || null;
}
