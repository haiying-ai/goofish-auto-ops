import SparkMD5 from "spark-md5";

const APP_KEY = "34839810";
const HOST = "https://h5api.m.goofish.com";
const TOKEN_NAMES = ["_m_h5_tk", "_m_h5_tk_enc"] as const;

export type MtopCallOptions = {
  version?: string;
  spm?: string;
  onTokenRefresh?: (cookie: string) => Promise<void> | void;
};

export function cookieValue(cookie: string, name: string) {
  const part = cookie
    .split(";")
    .map((value) => value.trim())
    .find((value) => value.startsWith(`${name}=`));
  return part?.slice(name.length + 1) || "";
}

export function mergeMtopTokens(
  cookie: string,
  tokens: { mH5Tk?: string; mH5TkEnc?: string },
) {
  return mergeCookieValues(cookie, {
    _m_h5_tk: tokens.mH5Tk || "",
    _m_h5_tk_enc: tokens.mH5TkEnc || "",
  });
}

export async function mtop(
  cookie: string,
  api: string,
  data: unknown,
  options: MtopCallOptions = {},
) {
  let currentCookie = cookie;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const token = cookieValue(currentCookie, "_m_h5_tk").split("_")[0];
    const t = Date.now().toString();
    const body = JSON.stringify(data);
    const sign = SparkMD5.hash(`${token}&${t}&${APP_KEY}&${body}`);
    const version = options.version || "1.0";
    const query = new URLSearchParams({
      jsv: "2.7.2",
      appKey: APP_KEY,
      t,
      sign,
      v: version,
      type: "originaljson",
      accountSite: "xianyu",
      dataType: "json",
      timeout: "20000",
      api,
      sessionOption: "AutoLoginOnly",
      spm_cnt: options.spm || "a21ybx.home.0.0",
    });
    const response = await fetch(`${HOST}/h5/${api}/${version}/?${query}`, {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/x-www-form-urlencoded",
        origin: "https://www.goofish.com",
        referer: "https://www.goofish.com/",
        cookie: currentCookie,
        "user-agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/151.0 Safari/537.36",
      },
      body: new URLSearchParams({ data: body }),
    });
    if (!response.ok) throw new Error(`闲鱼接口 HTTP ${response.status}`);

    const raw = (await response.json()) as {
      ret?: string[];
      data?: Record<string, unknown>;
    };
    const ret = (raw.ret || []).join(" | ");
    const refreshedTokens = readMtopTokens(response.headers);
    const hasNewToken = Boolean(
      refreshedTokens._m_h5_tk || refreshedTokens._m_h5_tk_enc,
    );
    if (hasNewToken) {
      currentCookie = mergeCookieValues(currentCookie, refreshedTokens);
      await options.onTokenRefresh?.(currentCookie);
    }

    if (!ret || ret.includes("SUCCESS")) return raw;
    if (attempt === 0 && isRefreshableTokenError(ret) && hasNewToken) continue;
    throw new Error(normalizeMtopError(ret));
  }
  throw new Error("闲鱼令牌续期后仍无法完成请求");
}

function isRefreshableTokenError(ret: string) {
  return /TOKEN_(?:EXOIRED|EXPIRED|EMPTY)|令牌过期|令牌为空/i.test(ret);
}

function normalizeMtopError(ret: string) {
  if (/SESSION_EXPIRED|ILLEGAL_ACCESS|登录失效|会话过期/i.test(ret)) {
    return `闲鱼长期登录已失效，需要重新采集一次 Cookie：${ret}`;
  }
  if (isRefreshableTokenError(ret)) {
    return `闲鱼临时令牌自动续期失败，请稍后重试：${ret}`;
  }
  return ret;
}

function readMtopTokens(headers: Headers) {
  const getSetCookie = (
    headers as Headers & { getSetCookie?: () => string[] }
  ).getSetCookie;
  const values =
    typeof getSetCookie === "function"
      ? getSetCookie.call(headers)
      : [headers.get("set-cookie") || ""];
  const result: Record<string, string> = {};
  for (const name of TOKEN_NAMES) {
    const pattern = new RegExp(`(?:^|[,;]\\s*)${name}=([^;,\\s]+)`, "i");
    for (const value of values) {
      const match = value.match(pattern);
      if (match?.[1]) {
        result[name] = match[1];
        break;
      }
    }
  }
  return result;
}

function mergeCookieValues(cookie: string, updates: Record<string, string>) {
  const values = new Map<string, string>();
  for (const part of cookie.split(";")) {
    const trimmed = part.trim();
    const index = trimmed.indexOf("=");
    if (index < 1) continue;
    values.set(trimmed.slice(0, index), trimmed.slice(index + 1));
  }
  for (const [name, value] of Object.entries(updates)) {
    if (value) values.set(name, value);
  }
  return [...values.entries()].map(([name, value]) => `${name}=${value}`).join("; ");
}
