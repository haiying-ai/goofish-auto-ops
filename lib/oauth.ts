import { env } from "cloudflare:workers";
import { and, eq, isNull } from "drizzle-orm";
import { getDb } from "../db";
import {
  oauthAuthorizationCodes,
  oauthClients,
  oauthRefreshTokens,
} from "../db/schema";

type RuntimeEnv = {
  AUTO_OPS_OWNER_EMAIL?: string;
  DATA_ENCRYPTION_KEY?: string;
};

type AccessTokenPayload = {
  typ: "access";
  iss: string;
  aud: string;
  sub: string;
  client_id: string;
  scope: string;
  iat: number;
  exp: number;
  jti: string;
};

export type OAuthAccess = {
  email: string;
  clientId: string;
  scope: string;
};

export type AuthorizationRequest = {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  scope: string;
  resource: string;
  state: string;
};

export const AUTO_OPS_SCOPE = "auto_ops.manage";
export const ACCESS_TOKEN_TTL_SECONDS = 60 * 60;
const AUTHORIZATION_CODE_TTL_SECONDS = 5 * 60;
const REFRESH_TOKEN_TTL_SECONDS = 90 * 24 * 60 * 60;
const CLIENT_TTL_SECONDS = 365 * 24 * 60 * 60;
const TOKEN_PREFIX = "aops1";

export function configuredOwnerEmail() {
  const value = (env as unknown as RuntimeEnv).AUTO_OPS_OWNER_EMAIL?.trim();
  return value ? value.toLocaleLowerCase() : null;
}

export function trustedChatGPTEmail(request: Request) {
  const value = request.headers.get("oai-authenticated-user-email")?.trim();
  return value ? value.toLocaleLowerCase() : null;
}

export function oauthResource(request: Request) {
  return `${new URL(request.url).origin}/api/mcp`;
}

export function oauthIssuer(request: Request) {
  return new URL(request.url).origin;
}

export async function registerOAuthClient(input: {
  clientName?: unknown;
  redirectUris?: unknown;
  tokenEndpointAuthMethod?: unknown;
}) {
  if (
    input.tokenEndpointAuthMethod !== undefined &&
    input.tokenEndpointAuthMethod !== "none"
  ) {
    throw new OAuthError(
      "invalid_client_metadata",
      "仅支持不带客户端密钥的 PKCE 公共客户端",
    );
  }
  if (!Array.isArray(input.redirectUris) || input.redirectUris.length < 1) {
    throw new OAuthError("invalid_redirect_uri", "至少需要一个回调地址");
  }
  const redirectUris = [
    ...new Set(input.redirectUris.map((value) => validateRedirectUri(String(value)))),
  ];
  if (redirectUris.length > 10) {
    throw new OAuthError("invalid_client_metadata", "回调地址不能超过 10 个");
  }
  const issuedAt = epochSeconds();
  const expiresAt = issuedAt + CLIENT_TTL_SECONDS;
  const redirectUrisJson = JSON.stringify(redirectUris);
  const [existing] = await getDb()
    .select()
    .from(oauthClients)
    .where(eq(oauthClients.redirectUrisJson, redirectUrisJson))
    .limit(1);
  if (existing && existing.expiresAt > new Date().toISOString()) {
    return {
      client_id: existing.id,
      client_id_issued_at: issuedAt,
      client_secret_expires_at: 0,
      redirect_uris: redirectUris,
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      scope: AUTO_OPS_SCOPE,
    };
  }
  const clientId = `autoops_${randomToken(24)}`;
  await getDb().insert(oauthClients).values({
    id: clientId,
    name: String(input.clientName || "ChatGPT").trim().slice(0, 120) || "ChatGPT",
    redirectUrisJson,
    expiresAt: isoFromEpoch(expiresAt),
  });
  return {
    client_id: clientId,
    client_id_issued_at: issuedAt,
    client_secret_expires_at: 0,
    redirect_uris: redirectUris,
    token_endpoint_auth_method: "none",
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    scope: AUTO_OPS_SCOPE,
  };
}

export async function validateAuthorizationRequest(
  params: URLSearchParams,
  request: Request,
): Promise<AuthorizationRequest> {
  const clientId = requiredParameter(params, "client_id", 512);
  const redirectUri = validateRedirectUri(
    requiredParameter(params, "redirect_uri", 2048),
  );
  const responseType = requiredParameter(params, "response_type", 32);
  const codeChallenge = requiredParameter(params, "code_challenge", 256);
  const codeChallengeMethod = requiredParameter(
    params,
    "code_challenge_method",
    32,
  );
  const resource = requiredParameter(params, "resource", 2048);
  const state = String(params.get("state") || "");
  const requestedScope = String(params.get("scope") || AUTO_OPS_SCOPE).trim();

  if (responseType !== "code") {
    throw new OAuthError("unsupported_response_type", "仅支持授权码模式");
  }
  if (codeChallengeMethod !== "S256" || !/^[A-Za-z0-9_-]{43,128}$/.test(codeChallenge)) {
    throw new OAuthError("invalid_request", "必须使用 PKCE S256");
  }
  if (state.length > 2048) {
    throw new OAuthError("invalid_request", "state 参数过长");
  }
  if (requestedScope !== AUTO_OPS_SCOPE) {
    throw new OAuthError("invalid_scope", "请求了不支持的权限范围");
  }
  if (resource !== oauthResource(request)) {
    throw new OAuthError("invalid_target", "OAuth resource 与 MCP 地址不匹配");
  }

  const [client] = await getDb()
    .select()
    .from(oauthClients)
    .where(eq(oauthClients.id, clientId))
    .limit(1);
  if (!client || client.expiresAt <= new Date().toISOString()) {
    throw new OAuthError("unauthorized_client", "OAuth 客户端不存在或已过期");
  }
  const registered = parseStringArray(client.redirectUrisJson);
  if (!registered.includes(redirectUri)) {
    throw new OAuthError("invalid_request", "回调地址与已注册地址不一致");
  }
  return {
    clientId,
    redirectUri,
    codeChallenge,
    scope: AUTO_OPS_SCOPE,
    resource,
    state,
  };
}

export async function issueAuthorizationCode(
  authorization: AuthorizationRequest,
  userEmail: string,
) {
  const code = randomToken(32);
  await getDb().insert(oauthAuthorizationCodes).values({
    codeHash: await sha256Hex(code),
    clientId: authorization.clientId,
    redirectUri: authorization.redirectUri,
    codeChallenge: authorization.codeChallenge,
    scope: authorization.scope,
    resource: authorization.resource,
    userEmail: userEmail.toLocaleLowerCase(),
    expiresAt: isoFromEpoch(epochSeconds() + AUTHORIZATION_CODE_TTL_SECONDS),
  });
  return code;
}

export async function exchangeAuthorizationCode(
  form: URLSearchParams,
  request: Request,
) {
  const clientId = requiredParameter(form, "client_id", 512);
  const code = requiredParameter(form, "code", 2048);
  const redirectUri = requiredParameter(form, "redirect_uri", 2048);
  const codeVerifier = requiredParameter(form, "code_verifier", 256);
  const resource = requiredParameter(form, "resource", 2048);
  if (!/^[A-Za-z0-9._~-]{43,128}$/.test(codeVerifier)) {
    throw new OAuthError("invalid_grant", "PKCE code_verifier 格式无效");
  }
  if (resource !== oauthResource(request)) {
    throw new OAuthError("invalid_target", "OAuth resource 与 MCP 地址不匹配");
  }
  const codeHash = await sha256Hex(code);
  const [stored] = await getDb()
    .select()
    .from(oauthAuthorizationCodes)
    .where(eq(oauthAuthorizationCodes.codeHash, codeHash))
    .limit(1);
  if (
    !stored ||
    stored.clientId !== clientId ||
    stored.redirectUri !== redirectUri ||
    stored.resource !== resource ||
    stored.expiresAt <= new Date().toISOString() ||
    stored.usedAt
  ) {
    throw new OAuthError("invalid_grant", "授权码无效、已使用或已过期");
  }
  if ((await sha256Base64Url(codeVerifier)) !== stored.codeChallenge) {
    throw new OAuthError("invalid_grant", "PKCE 校验失败");
  }
  const now = new Date().toISOString();
  const claimed = await getDb()
    .update(oauthAuthorizationCodes)
    .set({ usedAt: now })
    .where(
      and(
        eq(oauthAuthorizationCodes.codeHash, codeHash),
        isNull(oauthAuthorizationCodes.usedAt),
      ),
    )
    .returning({ codeHash: oauthAuthorizationCodes.codeHash });
  if (claimed.length !== 1) {
    throw new OAuthError("invalid_grant", "授权码已经被使用");
  }
  return issueTokenPair({
    request,
    clientId,
    email: stored.userEmail,
    scope: stored.scope,
    resource: stored.resource,
  });
}

export async function exchangeRefreshToken(
  form: URLSearchParams,
  request: Request,
) {
  const clientId = requiredParameter(form, "client_id", 512);
  const refreshToken = requiredParameter(form, "refresh_token", 4096);
  const resource = requiredParameter(form, "resource", 2048);
  if (resource !== oauthResource(request)) {
    throw new OAuthError("invalid_target", "OAuth resource 与 MCP 地址不匹配");
  }
  const tokenHash = await sha256Hex(refreshToken);
  const [stored] = await getDb()
    .select()
    .from(oauthRefreshTokens)
    .where(eq(oauthRefreshTokens.tokenHash, tokenHash))
    .limit(1);
  if (
    !stored ||
    stored.clientId !== clientId ||
    stored.resource !== resource ||
    stored.expiresAt <= new Date().toISOString() ||
    stored.revokedAt
  ) {
    throw new OAuthError("invalid_grant", "刷新令牌无效、已撤销或已过期");
  }
  const now = new Date().toISOString();
  const rotated = await getDb()
    .update(oauthRefreshTokens)
    .set({ revokedAt: now })
    .where(
      and(
        eq(oauthRefreshTokens.tokenHash, tokenHash),
        isNull(oauthRefreshTokens.revokedAt),
      ),
    )
    .returning({ tokenHash: oauthRefreshTokens.tokenHash });
  if (rotated.length !== 1) {
    throw new OAuthError("invalid_grant", "刷新令牌已经被使用");
  }
  return issueTokenPair({
    request,
    clientId,
    email: stored.userEmail,
    scope: stored.scope,
    resource: stored.resource,
  });
}

export async function revokeRefreshToken(value: string) {
  if (!value) return;
  await getDb()
    .update(oauthRefreshTokens)
    .set({ revokedAt: new Date().toISOString() })
    .where(eq(oauthRefreshTokens.tokenHash, await sha256Hex(value)));
}

export async function verifyAccessToken(
  token: string,
  request: Request,
): Promise<OAuthAccess> {
  const parts = token.split(".");
  if (parts.length !== 3 || parts[0] !== TOKEN_PREFIX) {
    throw new OAuthError("invalid_token", "访问令牌格式无效");
  }
  const signed = `${parts[0]}.${parts[1]}`;
  const signature = decodeBase64Url(parts[2]);
  const valid = await crypto.subtle.verify(
    "HMAC",
    await signingKey(),
    signature,
    new TextEncoder().encode(signed),
  );
  if (!valid) throw new OAuthError("invalid_token", "访问令牌签名无效");

  let payload: AccessTokenPayload;
  try {
    payload = JSON.parse(new TextDecoder().decode(decodeBase64Url(parts[1])));
  } catch {
    throw new OAuthError("invalid_token", "访问令牌载荷无效");
  }
  const now = epochSeconds();
  if (
    payload.typ !== "access" ||
    payload.iss !== oauthIssuer(request) ||
    payload.aud !== oauthResource(request) ||
    payload.exp <= now ||
    payload.iat > now + 60 ||
    payload.scope !== AUTO_OPS_SCOPE
  ) {
    throw new OAuthError("invalid_token", "访问令牌已过期或作用域无效");
  }
  const owner = configuredOwnerEmail();
  if (!owner || payload.sub.toLocaleLowerCase() !== owner) {
    throw new OAuthError("invalid_token", "访问令牌不属于当前站点所有者");
  }
  return {
    email: payload.sub.toLocaleLowerCase(),
    clientId: payload.client_id,
    scope: payload.scope,
  };
}

async function issueTokenPair(input: {
  request: Request;
  clientId: string;
  email: string;
  scope: string;
  resource: string;
}) {
  const accessToken = await signAccessToken({
    iss: oauthIssuer(input.request),
    aud: input.resource,
    sub: input.email.toLocaleLowerCase(),
    clientId: input.clientId,
    scope: input.scope,
  });
  const refreshToken = randomToken(48);
  await getDb().insert(oauthRefreshTokens).values({
    tokenHash: await sha256Hex(refreshToken),
    clientId: input.clientId,
    scope: input.scope,
    resource: input.resource,
    userEmail: input.email.toLocaleLowerCase(),
    expiresAt: isoFromEpoch(epochSeconds() + REFRESH_TOKEN_TTL_SECONDS),
  });
  return {
    access_token: accessToken,
    token_type: "Bearer",
    expires_in: ACCESS_TOKEN_TTL_SECONDS,
    refresh_token: refreshToken,
    scope: input.scope,
    resource: input.resource,
  };
}

async function signAccessToken(input: {
  iss: string;
  aud: string;
  sub: string;
  clientId: string;
  scope: string;
}) {
  const now = epochSeconds();
  const payload: AccessTokenPayload = {
    typ: "access",
    iss: input.iss,
    aud: input.aud,
    sub: input.sub,
    client_id: input.clientId,
    scope: input.scope,
    iat: now,
    exp: now + ACCESS_TOKEN_TTL_SECONDS,
    jti: crypto.randomUUID(),
  };
  const encodedPayload = encodeBase64Url(
    new TextEncoder().encode(JSON.stringify(payload)),
  );
  const signed = `${TOKEN_PREFIX}.${encodedPayload}`;
  const signature = await crypto.subtle.sign(
    "HMAC",
    await signingKey(),
    new TextEncoder().encode(signed),
  );
  return `${signed}.${encodeBase64Url(new Uint8Array(signature))}`;
}

async function signingKey() {
  const secret = (env as unknown as RuntimeEnv).DATA_ENCRYPTION_KEY;
  if (!secret) throw new Error("DATA_ENCRYPTION_KEY 尚未配置，无法签发 OAuth 令牌");
  return crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(`xianyu-auto-ops-oauth:${secret}`),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

function validateRedirectUri(value: string) {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new OAuthError("invalid_redirect_uri", "回调地址格式无效");
  }
  if (url.hash || url.username || url.password) {
    throw new OAuthError("invalid_redirect_uri", "回调地址不能包含片段或账号信息");
  }
  const hostname = url.hostname.toLocaleLowerCase();
  const officialHttps =
    url.protocol === "https:" &&
    (hostname === "chatgpt.com" ||
      hostname.endsWith(".chatgpt.com") ||
      hostname === "openai.com" ||
      hostname.endsWith(".openai.com"));
  const loopback =
    (url.protocol === "http:" || url.protocol === "https:") &&
    (hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]");
  if (!officialHttps && !loopback) {
    throw new OAuthError(
      "invalid_redirect_uri",
      "只允许 ChatGPT/OpenAI 或本机 MCP 调试器回调地址",
    );
  }
  return url.toString();
}

function requiredParameter(params: URLSearchParams, name: string, max: number) {
  const value = String(params.get(name) || "");
  if (!value || value.length > max) {
    throw new OAuthError("invalid_request", `缺少或无效的 ${name} 参数`);
  }
  return value;
}

function parseStringArray(value: string) {
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter((entry): entry is string => typeof entry === "string")
      : [];
  } catch {
    return [];
  }
}

function randomToken(length: number) {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return encodeBase64Url(bytes);
}

async function sha256Hex(value: string) {
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)),
  );
  return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function sha256Base64Url(value: string) {
  return encodeBase64Url(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)),
    ),
  );
}

function encodeBase64Url(bytes: Uint8Array) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function decodeBase64Url(value: string) {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(
    Math.ceil(value.length / 4) * 4,
    "=",
  );
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function epochSeconds() {
  return Math.floor(Date.now() / 1000);
}

function isoFromEpoch(value: number) {
  return new Date(value * 1000).toISOString();
}

export class OAuthError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status = 400,
  ) {
    super(message);
  }
}
