import { env } from "cloudflare:workers";
import { emailStatus } from "../../../lib/email";
import { encryptionStatus } from "../../../lib/secrets";

export const dynamic = "force-dynamic";

type RuntimeEnv = { CRON_SECRET?: string; XIANYU_COOKIE?: string };

export async function GET() {
  const runtime = env as unknown as RuntimeEnv;
  return Response.json({
    ok: true,
    cronConfigured: Boolean(runtime.CRON_SECRET),
    xianyuConfigured: Boolean(runtime.XIANYU_COOKIE),
    email: emailStatus(),
    encryptionConfigured: encryptionStatus(),
    checkedAt: new Date().toISOString(),
  });
}
