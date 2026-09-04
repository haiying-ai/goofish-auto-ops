import { requireOwnerAccess } from "../../../../lib/access";
import { uploadListingImage } from "../../../../lib/xianyu-items";
import {
  createXianyuSession,
  normalizeXianyuCookie,
  saveConfiguredXianyuCookie,
  XianyuAuthenticationError,
} from "../../../../lib/xianyu-session";

export const dynamic = "force-dynamic";

// A valid 256 × 256 solid-color PNG used only to verify that the renewed session can reach
// the media upload service. The returned orphaned CDN object contains no user
// content and is never exposed to the client.
const UPLOAD_PROBE =
  "iVBORw0KGgoAAAANSUhEUgAAAQAAAAEAAQMAAABmvDolAAAAA1BMVEXu9P9Z1AtEAAAAH0lEQVRo3u3BAQ0AAADCoPdPbQ43oAAAAAAAAAAAvg0hAAABfxmcpwAAAABJRU5ErkJggg==";

export async function POST(request: Request) {
  const denied = await requireOwnerAccess(request);
  if (denied) return denied;

  try {
    const input = (await request.json()) as { cookie?: unknown };
    const cookie = normalizeXianyuCookie(String(input.cookie || ""));
    const session = await createXianyuSession(cookie, {
      mergeStoredTokens: false,
      persistTokens: false,
    });
    const account = await session.call(
      "mtop.taobao.idlemessage.pc.loginuser.get",
      {},
      { spm: "a21ybx.im.0.0" },
    );
    const user = account.data || {};
    if (!session.cookieValue("unb")) {
      throw new XianyuAuthenticationError("闲鱼会话未返回账号标识，请重新登录后再复制完整 Cookie");
    }

    const probeBytes = Uint8Array.from(atob(UPLOAD_PROBE), (character) =>
      character.charCodeAt(0),
    );
    await uploadListingImage(
      session,
      new Blob([probeBytes], { type: "image/png" }),
      "auth-probe.png",
    );
    const saved = await saveConfiguredXianyuCookie(session.cookieHeader());

    return Response.json(
      {
        success: true,
        source: saved.source,
        updatedAt: saved.updatedAt,
        uploadReady: true,
        nick: String(user.nick || ""),
      },
      { headers: { "cache-control": "no-store" } },
    );
  } catch (error) {
    const authRequired = error instanceof XianyuAuthenticationError;
    return Response.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "闲鱼会话更新失败，请重新登录后再试",
        code: authRequired ? "AUTH_REQUIRED" : "SESSION_UPDATE_FAILED",
      },
      {
        status: authRequired ? 401 : 502,
        headers: { "cache-control": "no-store" },
      },
    );
  }
}
