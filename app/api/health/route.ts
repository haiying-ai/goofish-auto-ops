import { env } from "cloudflare:workers";
import { emailStatus } from "../../../lib/email";

export const dynamic = "force-dynamic";

type RuntimeEnv = { CRON_SECRET?: string; XIANYU_COOKIE?: string };

export async function GET() {
  const runtime = env as unknown as RuntimeEnv;
  return Response.json({
    ok: true,
    cronConfigured: Boolean(runtime.CRON_SECRET),
    xianyuConfigured: Boolean(runtime.XIANYU_COOKIE),
    email: emailStatus(),
    checkedAt: new Date().toISOString(),
  });
}
