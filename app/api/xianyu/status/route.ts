import { env } from "cloudflare:workers";
import { emailStatus } from "../../../../lib/email";
import { createXianyuSession } from "../../../../lib/xianyu-session";
import { encryptionStatus } from "../../../../lib/secrets";

export const dynamic = "force-dynamic";
type RuntimeEnv = { XIANYU_COOKIE?: string };

export async function GET() {
  const cookie = (env as unknown as RuntimeEnv).XIANYU_COOKIE;
  if (!cookie) {
    return Response.json(
      {
        valid: false,
        autoRenewal: true,
        email: emailStatus(),
        encryptionConfigured: encryptionStatus(),
        error: "尚未配置闲鱼 Cookie",
      },
      { status: 503 },
    );
  }

  const session = await createXianyuSession(cookie);
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
      email: emailStatus(),
      encryptionConfigured: encryptionStatus(),
      ...session.tokenStatus(),
    });
  } catch (error) {
    return Response.json(
      {
        valid: false,
        email: emailStatus(),
        encryptionConfigured: encryptionStatus(),
        error: error instanceof Error ? error.message : "登录验证失败",
        ...session.tokenStatus(),
      },
      { status: 401 },
    );
  }
}
