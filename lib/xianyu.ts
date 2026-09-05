import SparkMD5 from "spark-md5";

const APP_KEY = "34839810";
const HOST = "https://h5api.m.goofish.com";
const XIANYU_FETCH_TIMEOUT_MS = 7_000;
const RENEWABLE_COOKIE_NAMES = [
  "_m_h5_tk",
  "_m_h5_tk_enc",
  "cookie2",
  "sgcookie",
  "t",
  "_tb_token_",
  "cna",
  "unb",
  "uc1",
  "cookie17",
  "lgc",
  "tracknick",
  "havana_lgc",
  "havana_lgc2_77",
  "havana_login",
  "csg",
  "last_u_xianyu_web",
  "last_cc",
  "_uab_collina",
  "isg",
  "l",
  "tfstk",
  "xlly_s",
  "thw",
] as const;

export type XianyuCookieUpdates = Record<string, string | null>;

export type MtopCallOptions = {
  version?: string;
  spm?: string;
  origin?: string;
  referer?: string;
  valueType?: string | null;
  headers?: Record<string, string>;
  onCookieRefresh?: (
    cookie: string,
    updates: XianyuCookieUpdates,
  ) => Promise<void> | void;
};

export async function xianyuFetch(
  input: RequestInfo | URL,
  init: RequestInit,
  operation = "闲鱼接口",
) {
  const signal = AbortSignal.timeout(XIANYU_FETCH_TIMEOUT_MS);
  try {
    return await fetch(input, { ...init, signal });
  } catch (error) {
    if (signal.aborted) {
      throw new Error(`${operation}请求超时（${XIANYU_FETCH_TIMEOUT_MS / 1_000}秒）`);
    }
    throw error;
  }
}

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
    if (options.valueType) query.set("valueType", options.valueType);
    const origin = options.origin || "https://www.goofish.com";
    const referer = options.referer || `${origin}/`;
    const response = await xianyuFetch(`${HOST}/h5/${api}/${version}/?${query}`, {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/x-www-form-urlencoded",
        origin,
        referer,
        cookie: currentCookie,
        "user-agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/151.0 Safari/537.36",
        ...options.headers,
      },
      body: new URLSearchParams({ data: body }),
    }, `闲鱼接口 ${api}`);
    if (!response.ok) throw new Error(`闲鱼接口 HTTP ${response.status}`);

    const raw = (await response.json()) as {
      ret?: string[];
      data?: Record<string, unknown>;
    };
    const ret = (raw.ret || []).join(" | ");
    const refreshedCookies = readXianyuResponseCookies(response.headers);
    const previousCookie = currentCookie;
    currentCookie = mergeCookieUpdates(currentCookie, refreshedCookies);
    const hasNewToken = Boolean(
      refreshedCookies._m_h5_tk || refreshedCookies._m_h5_tk_enc,
    );
    if (currentCookie !== previousCookie) {
      await options.onCookieRefresh?.(currentCookie, refreshedCookies);
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

export function readXianyuResponseCookies(headers: Headers) {
  const getSetCookie = (
    headers as Headers & { getSetCookie?: () => string[] }
  ).getSetCookie;
  const values =
    typeof getSetCookie === "function"
      ? getSetCookie.call(headers)
      : [headers.get("set-cookie") || ""];
  const result: XianyuCookieUpdates = {};
  for (const name of RENEWABLE_COOKIE_NAMES) {
    const pattern = new RegExp(`(?:^|[,]\\s*)${escapePattern(name)}=([^;]*)`, "i");
    for (const value of values) {
      const match = value.match(pattern);
      if (match) {
        const nextValue = String(match[1] || "").trim();
        result[name] =
          !nextValue || /^(?:deleted|null)$/i.test(nextValue)
            ? null
            : nextValue;
        break;
      }
    }
  }
  return result;
}

export function mergeXianyuResponseCookies(cookie: string, headers: Headers) {
  const updates = readXianyuResponseCookies(headers);
  return {
    cookie: mergeCookieUpdates(cookie, updates),
    updates,
  };
}

export function mergeCookieUpdates(
  cookie: string,
  updates: XianyuCookieUpdates,
) {
  const values = cookieMap(cookie);
  for (const [name, value] of Object.entries(updates)) {
    if (value === null) values.delete(name);
    else if (value) values.set(name, value);
  }
  return serializeCookieMap(values);
}

function mergeCookieValues(cookie: string, updates: Record<string, string>) {
  const values = cookieMap(cookie);
  for (const [name, value] of Object.entries(updates)) {
    if (value) values.set(name, value);
  }
  return serializeCookieMap(values);
}

function cookieMap(cookie: string) {
  const values = new Map<string, string>();
  for (const part of cookie.split(";")) {
    const trimmed = part.trim();
    const index = trimmed.indexOf("=");
    if (index < 1) continue;
    values.set(trimmed.slice(0, index), trimmed.slice(index + 1));
  }
  return values;
}

function serializeCookieMap(values: Map<string, string>) {
  return [...values.entries()]
    .map(([name, value]) => `${name}=${value}`)
    .join("; ");
}

function escapePattern(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
