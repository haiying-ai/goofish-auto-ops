import { env } from "cloudflare:workers";
import {
  AUTO_OPS_SCOPE,
  configuredOwnerEmail,
  oauthResource,
  trustedChatGPTEmail,
  verifyAccessToken,
  type OAuthAccess,
} from "./oauth";

type RuntimeEnv = {
  MCP_SHARED_SECRET?: string;
};

export type OwnerAccess =
  | ({ kind: "chatgpt" } & OAuthAccess)
  | ({ kind: "shared_secret" } & OAuthAccess)
  | ({ kind: "oauth" } & OAuthAccess);

export type McpAccess = OAuthAccess & {
  kind: "shared_secret" | "oauth";
  authorizationHeader: string;
};

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
  const sharedSecret = await matchingSharedSecret(request, false);
  if (sharedSecret) {
    return {
      kind: "shared_secret",
      email: owner || "mcp-shared-secret@auto-ops.local",
      clientId: "shared-secret",
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

export async function requireMcpAccess(request: Request): Promise<McpAccess | null> {
  const sharedSecret = await matchingSharedSecret(request, true);
  if (sharedSecret) {
    return {
      kind: "shared_secret",
      email: configuredOwnerEmail() || "mcp-shared-secret@auto-ops.local",
      clientId: "shared-secret",
      scope: AUTO_OPS_SCOPE,
      authorizationHeader: `Bearer ${sharedSecret}`,
    };
  }
  const token = bearerToken(request);
  if (!token) return null;
  try {
    return {
      kind: "oauth",
      ...(await verifyAccessToken(token, request)),
      authorizationHeader: `Bearer ${token}`,
    };
  } catch {
    return null;
  }
}

export function mcpUnauthorized(request: Request) {
  if (configuredSharedSecret()) {
    return Response.json(
      { error: "unauthorized", error_description: "MCP 访问密钥缺失或不匹配" },
      {
        status: 401,
        headers: {
          "cache-control": "no-store",
          "access-control-allow-origin": "*",
        },
      },
    );
  }
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

function configuredSharedSecret() {
  const value = (env as unknown as RuntimeEnv).MCP_SHARED_SECRET?.trim();
  return value || null;
}

async function matchingSharedSecret(request: Request, allowQuery: boolean) {
  const configured = configuredSharedSecret();
  if (!configured) return null;
  const supplied =
    request.headers.get("x-auto-ops-key")?.trim() ||
    bearerToken(request) ||
    (allowQuery ? new URL(request.url).searchParams.get("key")?.trim() : null);
  if (!supplied) return null;
  return (await constantTimeEqual(supplied, configured)) ? configured : null;
}

async function constantTimeEqual(left: string, right: string) {
  const encoder = new TextEncoder();
  const [leftHash, rightHash] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(left)),
    crypto.subtle.digest("SHA-256", encoder.encode(right)),
  ]);
  const leftBytes = new Uint8Array(leftHash);
  const rightBytes = new Uint8Array(rightHash);
  let difference = leftBytes.length ^ rightBytes.length;
  for (let index = 0; index < leftBytes.length; index += 1) {
    difference |= leftBytes[index] ^ rightBytes[index];
  }
  return difference === 0;
}
