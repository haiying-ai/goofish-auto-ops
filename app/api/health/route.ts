import { env } from "cloudflare:workers";
import { emailStatus } from "../../../lib/email";
import { encryptionStatus } from "../../../lib/secrets";
import { requireOwnerAccess } from "../../../lib/access";
import { configuredXianyuCookie } from "../../../lib/xianyu-session";

export const dynamic = "force-dynamic";

type RuntimeEnv = { CRON_SECRET?: string };

export async function GET(request: Request) {
  const denied = await requireOwnerAccess(request);
  if (denied) return denied;
  const runtime = env as unknown as RuntimeEnv;
  const xianyu = await configuredXianyuCookie();
  return Response.json({
    ok: true,
    cronConfigured: Boolean(runtime.CRON_SECRET),
    xianyuConfigured: Boolean(xianyu.cookie),
    xianyuCookieSource: xianyu.source,
    email: emailStatus(),
    encryptionConfigured: encryptionStatus(),
    checkedAt: new Date().toISOString(),
  });
}
