import {
  OAuthError,
  configuredOwnerEmail,
  issueAuthorizationCode,
  trustedChatGPTEmail,
  validateAuthorizationRequest,
  type AuthorizationRequest,
} from "../../../lib/oauth";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const authorization = await validateAuthorizationRequest(url.searchParams, request);
    const identity = ownerIdentity(request);
    if (identity === "signed-out") {
      const returnTo = `${url.pathname}${url.search}`;
      return Response.redirect(
        new URL(`/signin-with-chatgpt?return_to=${encodeURIComponent(returnTo)}`, url.origin),
        302,
      );
    }
    if (identity === "forbidden") {
      return htmlPage(
        "无权访问",
        "当前 ChatGPT 账号不是此 Auto Ops 的所有者。请退出后改用站点所有者账号登录。",
        403,
      );
    }
    if (identity === "unconfigured") {
      return htmlPage("尚未配置", "站点所有者白名单尚未配置，OAuth 授权已暂停。", 503);
    }
    return consentPage(authorization);
  } catch (error) {
    return oauthHtmlError(error);
  }
}

export async function POST(request: Request) {
  try {
    const origin = new URL(request.url).origin;
    if (request.headers.get("origin") !== origin) {
      throw new OAuthError("access_denied", "授权确认来源无效", 403);
    }
    const identity = ownerIdentity(request);
    if (identity !== "allowed") {
      throw new OAuthError("access_denied", "当前账号没有授权权限", 403);
    }
    const formData = await request.formData();
    const params = new URLSearchParams();
    for (const key of [
      "client_id",
      "redirect_uri",
      "response_type",
      "code_challenge",
      "code_challenge_method",
      "resource",
      "scope",
      "state",
    ]) {
      const value = formData.get(key);
      if (typeof value === "string") params.set(key, value);
    }
    const authorization = await validateAuthorizationRequest(params, request);
    if (formData.get("decision") !== "approve") {
      return oauthRedirect(authorization, { error: "access_denied" });
    }
    const email = trustedChatGPTEmail(request);
    if (!email) throw new OAuthError("access_denied", "无法确认当前账号", 403);
    const code = await issueAuthorizationCode(authorization, email);
    return oauthRedirect(authorization, { code });
  } catch (error) {
    return oauthHtmlError(error);
  }
}

function ownerIdentity(request: Request) {
  const owner = configuredOwnerEmail();
  if (!owner) return "unconfigured" as const;
  const email = trustedChatGPTEmail(request);
  if (!email) return "signed-out" as const;
  return email === owner ? ("allowed" as const) : ("forbidden" as const);
}

function consentPage(authorization: AuthorizationRequest) {
  const fields = [
    ["client_id", authorization.clientId],
    ["redirect_uri", authorization.redirectUri],
    ["response_type", "code"],
    ["code_challenge", authorization.codeChallenge],
    ["code_challenge_method", "S256"],
    ["resource", authorization.resource],
    ["scope", authorization.scope],
    ["state", authorization.state],
  ]
    .map(
      ([name, value]) =>
        `<input type="hidden" name="${escapeHtml(name)}" value="${escapeHtml(value)}">`,
    )
    .join("");
  return new Response(
    documentHtml(
      "授权 Auto Ops",
      `<div class="card">
        <div class="logo">鱼</div>
        <p class="eyebrow">闲鱼自动运营 · 安全连接</p>
        <h1>允许 ChatGPT 管理 Auto Ops？</h1>
        <p>授权后，当前及其他 ChatGPT 会话可通过受保护工具查看商品、创建草稿，并在获得明确确认后执行上架、修改、下架和发货维护。</p>
        <div class="scope"><strong>权限范围</strong><span>管理商品、订单与自动发货</span></div>
        <p class="fine">不会向 ChatGPT 返回闲鱼 Cookie、站点密钥、完整卡密库存或 API 密钥。访问令牌有效 1 小时，刷新授权最长 90 天。</p>
        <form method="post" action="/oauth/authorize">
          ${fields}
          <button class="primary" name="decision" value="approve">允许连接</button>
          <button class="secondary" name="decision" value="deny">取消</button>
        </form>
      </div>`,
    ),
    {
      status: 200,
      headers: secureHtmlHeaders(),
    },
  );
}

function oauthRedirect(
  authorization: AuthorizationRequest,
  values: Record<string, string>,
) {
  const destination = new URL(authorization.redirectUri);
  for (const [key, value] of Object.entries(values)) {
    destination.searchParams.set(key, value);
  }
  if (authorization.state) destination.searchParams.set("state", authorization.state);
  return Response.redirect(destination, 302);
}

function oauthHtmlError(error: unknown) {
  const known = error instanceof OAuthError;
  return htmlPage(
    "授权失败",
    error instanceof Error ? error.message : "OAuth 授权请求无效",
    known ? error.status : 400,
  );
}

function htmlPage(title: string, message: string, status: number) {
  return new Response(
    documentHtml(
      title,
      `<div class="card"><div class="logo">鱼</div><h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p></div>`,
    ),
    { status, headers: secureHtmlHeaders() },
  );
}

function documentHtml(title: string, body: string) {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title><style>
  *{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;padding:24px;background:#f4f7fb;color:#172033;font-family:Inter,"PingFang SC","Microsoft YaHei",sans-serif}.card{width:min(520px,100%);background:#fff;border:1px solid #e4eaf2;border-radius:22px;padding:34px;box-shadow:0 24px 70px #29446a1a}.logo{width:48px;height:48px;display:grid;place-items:center;border-radius:15px;color:#fff;font-size:22px;font-weight:900;background:linear-gradient(135deg,#2563eb,#34b8ec);margin-bottom:20px}.eyebrow{color:#2864f0;font-size:12px;font-weight:800;letter-spacing:.08em}.card h1{font-size:25px;margin:8px 0 12px}.card p{color:#68758a;line-height:1.7;font-size:14px}.scope{display:flex;justify-content:space-between;gap:20px;padding:14px 16px;border:1px solid #e4eaf2;border-radius:12px;margin:20px 0;font-size:13px}.scope span{color:#667085}.fine{font-size:12px!important}.card form{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-top:22px}.card button{border-radius:10px;padding:12px 16px;font:inherit;font-weight:750;cursor:pointer}.primary{border:0;background:#2864f0;color:#fff}.secondary{border:1px solid #dce3ed;background:#fff;color:#596579}
  </style></head><body>${body}</body></html>`;
}

function secureHtmlHeaders() {
  return {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
    "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY",
  };
}

function escapeHtml(value: string) {
  return value.replace(/[&<>'"]/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "'": "&#39;",
    '"': "&quot;",
  })[character] || character);
}
