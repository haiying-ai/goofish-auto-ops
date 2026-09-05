import { env } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { getDb } from "../db";
import { settings } from "../db/schema";
import { decryptSecret, encryptSecret } from "./secrets";
import {
  cookieValue,
  mergeCookieUpdates,
  mergeMtopTokens,
  mtop,
  readXianyuResponseCookies,
  xianyuFetch,
  type MtopCallOptions,
  type XianyuCookieUpdates,
} from "./xianyu";

const TOKEN_SETTING_KEY = "xianyu_mtop_tokens";
const COOKIE_SETTING_KEY = "xianyu_cookie";
const UPLOAD_AUTH_SETTING_KEY = "xianyu_upload_auth_state";
const COOKIE_REFRESH_SETTING_KEY = "xianyu_cookie_refresh_state";
const COOKIE_SECRET_SCOPE = "xianyu-cookie";
const COOKIE_SECRET_OWNER = "primary";
const STRONG_KEEPALIVE_INTERVAL_MS = 2 * 60 * 60_000;
const PASSPORT_HAS_LOGIN_URL =
  "https://passport.goofish.com/newlogin/hasLogin.do";
const PASSPORT_SILENT_LOGIN_URL =
  "https://passport.goofish.com/newlogin/silentHasLogin.do";
const PASSPORT_LOGIN_SETTINGS_URL =
  "https://passport.goofish.com/ac/account/setLoginSettings.do";
const SESSION_PAGE_URLS = [
  "https://www.goofish.com/",
  "https://www.goofish.com/bought",
] as const;
const SESSION_PAGE_HOSTS = new Set(["www.goofish.com"]);
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/151.0 Safari/537.36";

type RuntimeEnv = { XIANYU_COOKIE?: string };

type StoredTokens = {
  mH5Tk?: string;
  mH5TkEnc?: string;
  refreshedAt?: string;
  expiresAt?: string | null;
};

type CookieRefreshState = {
  lastAttemptAt?: string;
  lastSuccessAt?: string;
  lastStrongAttemptAt?: string;
  lastStrongSuccessAt?: string;
  lastPassportSuccessAt?: string;
  consecutiveFailures?: number;
  lastError?: string;
  updatedCookieNames?: string[];
  automatic?: boolean;
};

export type XianyuCookieSource = "encrypted_database" | "environment" | "none";

export class XianyuAuthenticationError extends Error {
  readonly code = "AUTH_REQUIRED";

  constructor(message = "闲鱼登录状态已失效，请在 Auto Ops 系统设置中更新闲鱼会话") {
    super(message);
    this.name = "XianyuAuthenticationError";
  }
}

export async function configuredXianyuCookie(): Promise<{
  cookie: string;
  source: XianyuCookieSource;
}> {
  const [stored] = await getDb()
    .select({ value: settings.value })
    .from(settings)
    .where(eq(settings.key, COOKIE_SETTING_KEY))
    .limit(1);
  if (stored?.value) {
    const cookie = await decryptSecret(
      COOKIE_SECRET_SCOPE,
      COOKIE_SECRET_OWNER,
      stored.value,
    );
    if (cookie.trim()) return { cookie, source: "encrypted_database" };
  }
  const fallback = (env as unknown as RuntimeEnv).XIANYU_COOKIE?.trim() || "";
  return {
    cookie: fallback,
    source: fallback ? "environment" : "none",
  };
}

export async function createConfiguredXianyuSession() {
  const configured = await configuredXianyuCookie();
  if (!configured.cookie) throw new XianyuAuthenticationError("尚未配置闲鱼 Cookie");
  const session = await createXianyuSession(configured.cookie);
  await session.renewIfNeeded();
  return session;
}

export async function saveConfiguredXianyuCookie(value: string) {
  const cookie = normalizeXianyuCookie(value);
  const missing = ["unb", "_m_h5_tk", "_m_h5_tk_enc"].filter(
    (name) => !cookieValue(cookie, name),
  );
  if (missing.length) {
    throw new Error(`Cookie 缺少必要字段：${missing.join("、")}`);
  }
  const now = new Date().toISOString();
  const db = getDb();
  const encrypted = await encryptSecret(
    COOKIE_SECRET_SCOPE,
    COOKIE_SECRET_OWNER,
    cookie,
  );
  await db.batch([
    db
      .insert(settings)
      .values({ key: COOKIE_SETTING_KEY, value: encrypted, updatedAt: now })
      .onConflictDoUpdate({
        target: settings.key,
        set: { value: encrypted, updatedAt: now },
      }),
    db.delete(settings).where(eq(settings.key, TOKEN_SETTING_KEY)),
    db.delete(settings).where(eq(settings.key, COOKIE_REFRESH_SETTING_KEY)),
  ]);
  return { source: "encrypted_database" as const, updatedAt: now };
}

export function normalizeXianyuCookie(value: string) {
  const cookie = String(value || "")
    .trim()
    .replace(/^cookie\s*:\s*/i, "")
    .replace(/[\r\n]+/g, " ")
    .split(";")
    .map((part) => part.trim())
    .filter((part) => /^[^=;\s]+=[^;]*$/.test(part))
    .join("; ");
  if (!cookie || cookie.length > 32_768) {
    throw new Error("Cookie 为空或长度超过 32 KiB");
  }
  return cookie;
}

export async function recordXianyuUploadAuthState(
  ready: boolean,
  detail = "",
) {
  const now = new Date().toISOString();
  const value = JSON.stringify({
    ready,
    checkedAt: now,
    ...(detail ? { detail: detail.slice(0, 240) } : {}),
  });
  await getDb()
    .insert(settings)
    .values({ key: UPLOAD_AUTH_SETTING_KEY, value, updatedAt: now })
    .onConflictDoUpdate({
      target: settings.key,
      set: { value, updatedAt: now },
    });
}

export async function xianyuUploadAuthState(): Promise<{
  ready: boolean | null;
  checkedAt: string | null;
  detail: string;
}> {
  const [stored] = await getDb()
    .select({ value: settings.value })
    .from(settings)
    .where(eq(settings.key, UPLOAD_AUTH_SETTING_KEY))
    .limit(1);
  if (!stored?.value) return { ready: null, checkedAt: null, detail: "" };
  try {
    const parsed = JSON.parse(stored.value) as Record<string, unknown>;
    return {
      ready: typeof parsed.ready === "boolean" ? parsed.ready : null,
      checkedAt:
        typeof parsed.checkedAt === "string" ? parsed.checkedAt : null,
      detail: typeof parsed.detail === "string" ? parsed.detail : "",
    };
  } catch {
    return { ready: null, checkedAt: null, detail: "" };
  }
}

export async function createXianyuSession(
  seedCookie: string,
  sessionOptions: { mergeStoredTokens?: boolean; persistTokens?: boolean } = {},
) {
  const db = getDb();
  const [storedTokensRows, storedRefreshRows] =
    sessionOptions.mergeStoredTokens === false
      ? [[], []]
      : await Promise.all([
          db
            .select({ value: settings.value })
            .from(settings)
            .where(eq(settings.key, TOKEN_SETTING_KEY))
            .limit(1),
          db
            .select({ value: settings.value })
            .from(settings)
            .where(eq(settings.key, COOKIE_REFRESH_SETTING_KEY))
            .limit(1),
        ]);
  const storedTokens = parseStoredTokens(storedTokensRows[0]?.value);
  let refreshState = parseRefreshState(storedRefreshRows[0]?.value);
  let cookie = mergeMtopTokens(seedCookie, storedTokens);
  let refreshedAt = storedTokens.refreshedAt || null;

  async function persistRefreshState(patch: Partial<CookieRefreshState>) {
    refreshState = { ...refreshState, ...patch, automatic: true };
    if (sessionOptions.persistTokens === false) return;
    const now = new Date().toISOString();
    await db
      .insert(settings)
      .values({
        key: COOKIE_REFRESH_SETTING_KEY,
        value: JSON.stringify(refreshState),
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: settings.key,
        set: { value: JSON.stringify(refreshState), updatedAt: now },
      });
  }

  async function persistCookieRefresh(updates: XianyuCookieUpdates) {
    if (sessionOptions.persistTokens === false || !Object.keys(updates).length) {
      return;
    }
    const refreshTime = new Date().toISOString();
    const [latest] = await db
      .select({ value: settings.value })
      .from(settings)
      .where(eq(settings.key, COOKIE_SETTING_KEY))
      .limit(1);
    let latestCookie = seedCookie;
    if (latest?.value) {
      latestCookie = await decryptSecret(
        COOKIE_SECRET_SCOPE,
        COOKIE_SECRET_OWNER,
        latest.value,
      );
    }
    const mergedCookie = mergeCookieUpdates(latestCookie, updates);
    const encrypted = await encryptSecret(
      COOKIE_SECRET_SCOPE,
      COOKIE_SECRET_OWNER,
      mergedCookie,
    );
    const tokenValue = JSON.stringify({
      mH5Tk: cookieValue(cookie, "_m_h5_tk"),
      mH5TkEnc: cookieValue(cookie, "_m_h5_tk_enc"),
      refreshedAt: refreshTime,
      expiresAt: tokenExpiry(cookie),
    } satisfies StoredTokens);
    refreshState = {
      ...refreshState,
      lastSuccessAt: refreshTime,
      consecutiveFailures: 0,
      lastError: "",
      updatedCookieNames: Object.keys(updates).sort(),
      automatic: true,
    };
    await db.batch([
      db
        .insert(settings)
        .values({ key: COOKIE_SETTING_KEY, value: encrypted, updatedAt: refreshTime })
        .onConflictDoUpdate({
          target: settings.key,
          set: { value: encrypted, updatedAt: refreshTime },
        }),
      db
        .insert(settings)
        .values({ key: TOKEN_SETTING_KEY, value: tokenValue, updatedAt: refreshTime })
        .onConflictDoUpdate({
          target: settings.key,
          set: { value: tokenValue, updatedAt: refreshTime },
        }),
      db
        .insert(settings)
        .values({ key: COOKIE_REFRESH_SETTING_KEY, value: JSON.stringify(refreshState), updatedAt: refreshTime })
        .onConflictDoUpdate({
          target: settings.key,
          set: { value: JSON.stringify(refreshState), updatedAt: refreshTime },
        }),
    ]);
    refreshedAt = refreshTime;
  }

  async function absorbResponseCookies(headers: Headers) {
    const updates = readXianyuResponseCookies(headers);
    const nextCookie = mergeCookieUpdates(cookie, updates);
    if (nextCookie === cookie) return false;
    cookie = nextCookie;
    await persistCookieRefresh(updates);
    return true;
  }

  async function executeMtop(
    api: string,
    data: unknown,
    callOptions: Omit<MtopCallOptions, "onCookieRefresh"> = {},
  ) {
    return mtop(cookie, api, data, {
      ...callOptions,
      onCookieRefresh: async (nextCookie, updates) => {
        cookie = nextCookie;
        await persistCookieRefresh(updates);
      },
    });
  }

  async function call(
    api: string,
    data: unknown,
    callOptions: Omit<MtopCallOptions, "onCookieRefresh"> = {},
  ) {
    try {
      return await executeMtop(api, data, callOptions);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (isRecoverableSessionError(message)) {
        try {
          await refreshPassportSession();
          await refreshSessionPages();
          const result = await executeMtop(api, data, callOptions);
          await markKeepaliveSuccess(true);
          return result;
        } catch (recoveryError) {
          const recoveryMessage =
            recoveryError instanceof Error
              ? recoveryError.message
              : String(recoveryError);
          await markKeepaliveFailure(recoveryMessage);
          throw new XianyuAuthenticationError(
            `闲鱼已执行强鉴权页续期和接口重试，但长期登录状态仍失效：${message}`,
          );
        }
      }
      throw error;
    }
  }

  async function refreshSessionPages() {
    for (const initialUrl of SESSION_PAGE_URLS) {
      let url = new URL(initialUrl);
      for (let redirects = 0; redirects < 3; redirects += 1) {
        const response = await xianyuFetch(url, {
          method: "GET",
          redirect: "manual",
          headers: {
            accept:
              "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
            "accept-language": "zh-CN,zh;q=0.9",
            cookie,
            referer: "https://www.goofish.com/",
            "user-agent": USER_AGENT,
          },
        }, "闲鱼强鉴权页");
        await absorbResponseCookies(response.headers);
        const location = response.headers.get("location");
        await response.body?.cancel();
        if (response.status >= 300 && response.status < 400 && location) {
          const next = new URL(location, url);
          if (!SESSION_PAGE_HOSTS.has(next.hostname)) {
            throw new Error(`强鉴权页跳转到登录域：${next.hostname}`);
          }
          url = next;
          continue;
        }
        if (!response.ok) {
          throw new Error(`强鉴权页返回 HTTP ${response.status}`);
        }
        break;
      }
    }
  }

  async function passportPost(
    url: string,
    query: Record<string, string>,
    body?: URLSearchParams,
  ) {
    const response = await xianyuFetch(`${url}?${new URLSearchParams(query)}`, {
      method: "POST",
      redirect: "manual",
      headers: {
        accept: "application/json, text/plain, */*",
        "accept-language": "zh-CN,zh;q=0.9,en;q=0.8",
        ...(body
          ? { "content-type": "application/x-www-form-urlencoded" }
          : {}),
        origin: "https://www.goofish.com",
        referer: "https://www.goofish.com/",
        cookie,
        "user-agent": USER_AGENT,
      },
      ...(body ? { body } : {}),
    }, "闲鱼登录续期接口");
    await absorbResponseCookies(response.headers);
    const text = await response.text();
    if (![200, 302, 303].includes(response.status)) {
      throw new Error(`登录续期接口返回 HTTP ${response.status}`);
    }
    return text;
  }

  async function refreshPassportSession() {
    const unb = cookieValue(cookie, "unb");
    if (!unb) throw new Error("Cookie 缺少账号字段 unb，无法续期");
    const pageTraceId = `21504${Date.now()}${Math.floor(100000 + Math.random() * 900000)}`;
    const hasLoginBody = new URLSearchParams({
      hid: unb,
      ltl: "true",
      appName: "xianyu",
      appEntrance: "web",
      _csrf_token: cookieValue(cookie, "_tb_token_"),
      umidToken:
        cookieValue(cookie, "_uab_collina") || cookieValue(cookie, "cna"),
      hsiz: cookieValue(cookie, "cookie2"),
      bizParams:
        "taobaoBizLoginFrom=web&renderRefer=https://www.goofish.com/",
      mainPage: "false",
      isMobile: "false",
      lang: "zh_CN",
      returnUrl: "",
      fromSite: "77",
      isIframe: "true",
      documentReferer: "https://www.goofish.com/",
      defaultView: "hasLogin",
      umidTag: "SERVER",
      deviceId: "",
      pageTraceId,
    });
    const hasLoginText = await passportPost(
      PASSPORT_HAS_LOGIN_URL,
      { appName: "xianyu", fromSite: "77" },
      hasLoginBody,
    );
    assertPassportSuccess(hasLoginText, "hasLogin");

    const silentText = await passportPost(PASSPORT_SILENT_LOGIN_URL, {
      documentReferer: "https://www.goofish.com/",
      appName: "xianyu",
      appEntrance: "xianyu_sdkSilent",
      fromSite: "0",
      ltl: "true",
    });
    assertPassportSuccess(silentText, "silentHasLogin");

    await passportPost(
      PASSPORT_LOGIN_SETTINGS_URL,
      { fromSite: "77", appName: "xianyu", bizEntrance: "web" },
      new URLSearchParams({ status: "0" }),
    );
    const now = new Date().toISOString();
    await persistRefreshState({ lastPassportSuccessAt: now });
  }

  async function markKeepaliveSuccess(strong: boolean) {
    const now = new Date().toISOString();
    await persistRefreshState({
      lastAttemptAt: now,
      lastSuccessAt: now,
      ...(strong
        ? { lastStrongAttemptAt: now, lastStrongSuccessAt: now }
        : {}),
      consecutiveFailures: 0,
      lastError: "",
    });
  }

  async function markKeepaliveFailure(message: string) {
    const now = new Date().toISOString();
    await persistRefreshState({
      lastAttemptAt: now,
      lastStrongAttemptAt: now,
      consecutiveFailures: (refreshState.consecutiveFailures || 0) + 1,
      lastError: message.slice(0, 240),
    });
  }

  async function renew() {
    await call(
      "mtop.taobao.idlemessage.pc.loginuser.get",
      {},
      { spm: "a21ybx.im.0.0" },
    );
    return tokenStatus();
  }

  async function renewIfNeeded(force = false) {
    const expiresAt = tokenExpiry(cookie);
    const expiresSoon =
      !expiresAt || Date.parse(expiresAt) <= Date.now() + 6 * 60 * 60_000;
    if (force || expiresSoon) await renew();
    return tokenStatus();
  }

  async function scheduledKeepAlive() {
    const lastStrong = Date.parse(refreshState.lastStrongSuccessAt || "");
    const strongDue =
      !Number.isFinite(lastStrong) ||
      lastStrong <= Date.now() - STRONG_KEEPALIVE_INTERVAL_MS;
    try {
      if (strongDue) await refreshSessionPages();
      if (strongDue) await refreshPassportSession();
      await executeMtop(
        "mtop.taobao.idlemessage.pc.loginuser.get",
        {},
        { spm: "a21ybx.im.0.0" },
      );
      await markKeepaliveSuccess(strongDue);
      return tokenStatus();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!strongDue) {
        try {
          await refreshPassportSession();
          await refreshSessionPages();
          await executeMtop(
            "mtop.taobao.idlemessage.pc.loginuser.get",
            {},
            { spm: "a21ybx.im.0.0" },
          );
          await markKeepaliveSuccess(true);
          return tokenStatus();
        } catch (recoveryError) {
          const recoveryMessage =
            recoveryError instanceof Error
              ? recoveryError.message
              : String(recoveryError);
          await markKeepaliveFailure(recoveryMessage);
        }
      } else {
        await markKeepaliveFailure(message);
      }
      throw new XianyuAuthenticationError(
        `闲鱼定时保活已执行首页、强鉴权页和账号接口续期，但长期登录仍失效：${message}`,
      );
    }
  }

  function tokenStatus() {
    return {
      autoRenewal: true,
      tokenExpiresAt: tokenExpiry(cookie),
      tokenRefreshedAt: refreshedAt,
      fullCookieAutoRefresh: true,
      scheduledKeepAlive: true,
      keepAliveIntervalHours: STRONG_KEEPALIVE_INTERVAL_MS / 60 / 60_000,
      keepAliveLastSuccessAt: refreshState.lastSuccessAt || null,
      strongKeepAliveLastSuccessAt: refreshState.lastStrongSuccessAt || null,
      passportKeepAliveLastSuccessAt:
        refreshState.lastPassportSuccessAt || null,
      keepAliveFailures: refreshState.consecutiveFailures || 0,
    };
  }

  return {
    cookieHeader() {
      return cookie;
    },
    cookieValue(name: string) {
      return cookieValue(cookie, name);
    },
    tokenStatus,
    absorbResponseCookies,
    call,
    renew,
    renewIfNeeded,
    scheduledKeepAlive,
  };
}

function assertPassportSuccess(text: string, operation: string) {
  try {
    const parsed = JSON.parse(text) as {
      content?: { success?: boolean; titleMsg?: string; retMsg?: string };
    };
    if (parsed.content?.success === true) return;
    throw new Error(
      parsed.content?.titleMsg ||
        parsed.content?.retMsg ||
        `${operation} 返回登录失效`,
    );
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error(`${operation} 返回无法识别的登录响应`);
    }
    throw error;
  }
}

function parseStoredTokens(value?: string): StoredTokens {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value) as StoredTokens;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function parseRefreshState(value?: string): CookieRefreshState {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value) as CookieRefreshState;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function isRecoverableSessionError(message: string) {
  return /长期登录已失效|SESSION_EXPIRED|登录失效|会话过期/i.test(message);
}

function tokenExpiry(cookie: string): string | null {
  const raw = cookieValue(cookie, "_m_h5_tk");
  const expiresMs = Number(raw.slice(raw.lastIndexOf("_") + 1));
  if (!Number.isFinite(expiresMs) || expiresMs < 1) return null;
  return new Date(expiresMs).toISOString();
}
