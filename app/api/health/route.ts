import { env } from "cloudflare:workers";
import { emailStatus } from "../../../lib/email";
import { encryptionStatus } from "../../../lib/secrets";
import { requireOwnerAccess } from "../../../lib/access";
import { configuredXianyuCookie } from "../../../lib/xianyu-session";
import { desc, eq } from "drizzle-orm";
import { getDb } from "../../../db";
import { jobRuns, settings } from "../../../db/schema";
import { deriveAutomationHealth } from "../../../lib/automation-health";

export const dynamic = "force-dynamic";

type RuntimeEnv = { CRON_SECRET?: string };

export async function GET(request: Request) {
  const denied = await requireOwnerAccess(request);
  if (denied) return denied;
  const runtime = env as unknown as RuntimeEnv;
  const xianyu = await configuredXianyuCookie();
  const db = getDb();
  const [recentRuns, alertState] = await Promise.all([
    db
      .select()
      .from(jobRuns)
      .where(eq(jobRuns.job, "all"))
      .orderBy(desc(jobRuns.startedAt))
      .limit(20),
    db
      .select({ value: settings.value })
      .from(settings)
      .where(eq(settings.key, "xianyu_keepalive_failure_alert"))
      .limit(1),
  ]);
  const automationHealth = deriveAutomationHealth(recentRuns, {
    recoveryNoticePending: Boolean(alertState[0]?.value),
  });
  return Response.json({
    ok: automationHealth.state !== "critical",
    cronConfigured: Boolean(runtime.CRON_SECRET),
    xianyuConfigured: Boolean(xianyu.cookie),
    xianyuCookieSource: xianyu.source,
    email: emailStatus(),
    encryptionConfigured: encryptionStatus(),
    automationHealth,
    checkedAt: new Date().toISOString(),
  });
}
