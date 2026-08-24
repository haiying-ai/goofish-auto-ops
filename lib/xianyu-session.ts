import { eq } from "drizzle-orm";
import { getDb } from "../db";
import { settings } from "../db/schema";
import {
  cookieValue,
  mergeMtopTokens,
  mtop,
  type MtopCallOptions,
} from "./xianyu";

const TOKEN_SETTING_KEY = "xianyu_mtop_tokens";

type StoredTokens = {
  mH5Tk?: string;
  mH5TkEnc?: string;
  refreshedAt?: string;
  expiresAt?: string | null;
};

export async function createXianyuSession(seedCookie: string) {
  const db = getDb();
  const stored = await db
    .select({ value: settings.value })
    .from(settings)
    .where(eq(settings.key, TOKEN_SETTING_KEY))
    .limit(1);
  const storedTokens = parseStoredTokens(stored[0]?.value);
  let cookie = mergeMtopTokens(seedCookie, storedTokens);
  let refreshedAt = storedTokens.refreshedAt || null;

  return {
    cookieValue(name: string) {
      return cookieValue(cookie, name);
    },
    tokenStatus() {
      return {
        autoRenewal: true,
        tokenExpiresAt: tokenExpiry(cookie),
        tokenRefreshedAt: refreshedAt,
      };
    },
    async call(
      api: string,
      data: unknown,
      options: Omit<MtopCallOptions, "onTokenRefresh"> = {},
    ) {
      return mtop(cookie, api, data, {
        ...options,
        onTokenRefresh: async (nextCookie) => {
          cookie = nextCookie;
          refreshedAt = new Date().toISOString();
          const value = JSON.stringify({
            mH5Tk: cookieValue(cookie, "_m_h5_tk"),
            mH5TkEnc: cookieValue(cookie, "_m_h5_tk_enc"),
            refreshedAt,
            expiresAt: tokenExpiry(cookie),
          } satisfies StoredTokens);
          await db
            .insert(settings)
            .values({ key: TOKEN_SETTING_KEY, value, updatedAt: refreshedAt })
            .onConflictDoUpdate({
              target: settings.key,
              set: { value, updatedAt: refreshedAt },
            });
        },
      });
    },
  };
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

function tokenExpiry(cookie: string): string | null {
  const raw = cookieValue(cookie, "_m_h5_tk");
  const expiresMs = Number(raw.slice(raw.lastIndexOf("_") + 1));
  if (!Number.isFinite(expiresMs) || expiresMs < 1) return null;
  return new Date(expiresMs).toISOString();
}
