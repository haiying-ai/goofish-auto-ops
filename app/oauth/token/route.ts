import {
  OAuthError,
  exchangeAuthorizationCode,
  exchangeRefreshToken,
} from "../../../lib/oauth";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const contentType = request.headers.get("content-type") || "";
    if (!contentType.includes("application/x-www-form-urlencoded")) {
      throw new OAuthError("invalid_request", "令牌请求必须使用表单编码");
    }
    const form = new URLSearchParams(await request.text());
    const grantType = String(form.get("grant_type") || "");
    const tokens =
      grantType === "authorization_code"
        ? await exchangeAuthorizationCode(form, request)
        : grantType === "refresh_token"
          ? await exchangeRefreshToken(form, request)
          : (() => {
              throw new OAuthError("unsupported_grant_type", "不支持此授权类型");
            })();
    return Response.json(tokens, { headers: tokenHeaders() });
  } catch (error) {
    const known = error instanceof OAuthError;
    return Response.json(
      {
        error: known ? error.code : "invalid_request",
        error_description: error instanceof Error ? error.message : "令牌请求失败",
      },
      {
        status: known ? error.status : 400,
        headers: tokenHeaders(),
      },
    );
  }
}

function tokenHeaders() {
  return {
    "cache-control": "no-store",
    pragma: "no-cache",
    "access-control-allow-origin": "*",
  };
}
