import { emailStatus } from "../../../../lib/email";
import {
  configuredXianyuCookie,
  createXianyuSession,
  xianyuUploadAuthState,
} from "../../../../lib/xianyu-session";
import { encryptionStatus } from "../../../../lib/secrets";
import { requireOwnerAccess } from "../../../../lib/access";

export const dynamic = "force-dynamic";
export async function GET(request: Request) {
  const denied = await requireOwnerAccess(request);
  if (denied) return denied;
  const configured = await configuredXianyuCookie();
  const uploadAuth = await xianyuUploadAuthState();
  if (!configured.cookie) {
    return Response.json(
      {
        valid: false,
        autoRenewal: true,
        cookieSource: configured.source,
        uploadReady: uploadAuth.ready,
        uploadCheckedAt: uploadAuth.checkedAt,
        requiresRenewal: true,
        email: emailStatus(),
        encryptionConfigured: encryptionStatus(),
        error: "尚未配置闲鱼 Cookie",
      },
      { status: 503 },
    );
  }

  const session = await createXianyuSession(configured.cookie);
  try {
    const raw = await session.call(
      "mtop.taobao.idlemessage.pc.loginuser.get",
      {},
      { spm: "a21ybx.im.0.0" },
    );
    const user = raw.data || {};
    return Response.json({
      valid: true,
      nick: String(user.nick || ""),
      accountConfigured: Boolean(session.cookieValue("unb")),
      cookieSource: configured.source,
      uploadReady: uploadAuth.ready,
      uploadCheckedAt: uploadAuth.checkedAt,
      requiresRenewal: uploadAuth.ready === false,
      email: emailStatus(),
      encryptionConfigured: encryptionStatus(),
      ...session.tokenStatus(),
    });
  } catch (error) {
    return Response.json(
      {
        valid: false,
        cookieSource: configured.source,
        uploadReady: uploadAuth.ready,
        uploadCheckedAt: uploadAuth.checkedAt,
        requiresRenewal: true,
        email: emailStatus(),
        encryptionConfigured: encryptionStatus(),
        error: error instanceof Error ? error.message : "登录验证失败",
        ...session.tokenStatus(),
      },
      { status: 401 },
    );
  }
}
