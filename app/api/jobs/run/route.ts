import { env } from "cloudflare:workers";
import { and, asc, eq, lt } from "drizzle-orm";
import { getDb } from "../../../../db";
import { jobRuns, products, settings } from "../../../../db/schema";
import {
  parseListingImages,
  publishListing,
} from "../../../../lib/xianyu-items";
import { createXianyuSession } from "../../../../lib/xianyu-session";

export const dynamic = "force-dynamic";
type RuntimeEnv = { CRON_SECRET?: string; XIANYU_COOKIE?: string };

async function authorized(request: Request) {
  const secret = (env as unknown as RuntimeEnv).CRON_SECRET;
  if (!secret) return true;
  const auth = request.headers.get("authorization");
  if (auth === `Bearer ${secret}`) return true;
  return Boolean(request.headers.get("oai-authenticated-user-email"));
}

export async function POST(request: Request) {
  if (!(await authorized(request))) {
    return Response.json({ error: "任务密钥无效" }, { status: 401 });
  }
  let requestedProductId = 0;
  try {
    const body = (await request.json()) as { productId?: number };
    requestedProductId = Number(body.productId) || 0;
  } catch {
    // Cron requests do not need a JSON body and keep publishing the oldest item.
  }
  const db = getDb();
  const now = new Date().toISOString();
  const leaseUntil = new Date(Date.now() - 4 * 60_000).toISOString();
  const lock = await db
    .select()
    .from(settings)
    .where(eq(settings.key, "cron_lease"))
    .limit(1);
  if (lock[0] && lock[0].value > leaseUntil) {
    return Response.json({ error: "上一轮任务仍在执行" }, { status: 409 });
  }
  await db
    .insert(settings)
    .values({ key: "cron_lease", value: now, updatedAt: now })
    .onConflictDoUpdate({
      target: settings.key,
      set: { value: now, updatedAt: now },
    });
  const [run] = await db
    .insert(jobRuns)
    .values({ job: "all", status: "running" })
    .returning();
  let published = 0;
  const delivered = 0;
  let queuedProduct: typeof products.$inferSelect | undefined;

  try {
    const cookie = (env as unknown as RuntimeEnv).XIANYU_COOKIE;
    [queuedProduct] = await db
      .select()
      .from(products)
      .where(
        requestedProductId
          ? and(
              eq(products.id, requestedProductId),
              eq(products.status, "queued"),
            )
          : eq(products.status, "queued"),
      )
      .orderBy(asc(products.createdAt))
      .limit(1);
    if (requestedProductId && !queuedProduct) {
      throw new Error("指定商品不存在或不在待发布队列");
    }
    if (queuedProduct && !cookie) throw new Error("等待配置闲鱼 Cookie");
    if (queuedProduct && cookie) {
      const session = await createXianyuSession(cookie);
      const remote = await publishListing(session, {
        title: queuedProduct.title,
        description: queuedProduct.description,
        priceCents: queuedProduct.priceCents,
        images: parseListingImages(queuedProduct.imagesJson),
      });
      await db
        .update(products)
        .set({
          xianyuItemId: remote.itemId,
          imagesJson: JSON.stringify(remote.images),
          status: "published",
          lastError: null,
          updatedAt: new Date().toISOString(),
        })
        .where(eq(products.id, queuedProduct.id));
      published = 1;
    }
    const summary = JSON.stringify({
      published,
      delivered,
      configurationRequired: !cookie,
    });
    await db
      .update(jobRuns)
      .set({ status: "success", summary, finishedAt: new Date().toISOString() })
      .where(eq(jobRuns.id, run.id));
    return Response.json({
      success: true,
      published,
      delivered,
      configurationRequired: !cookie,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "任务失败";
    if (queuedProduct) {
      await db
        .update(products)
        .set({
          status: "failed",
          lastError: message,
          updatedAt: new Date().toISOString(),
        })
        .where(eq(products.id, queuedProduct.id));
    }
    await db
      .update(jobRuns)
      .set({
        status: "failed",
        summary: JSON.stringify({ error: message }),
        finishedAt: new Date().toISOString(),
      })
      .where(eq(jobRuns.id, run.id));
    return Response.json({ error: message }, { status: 500 });
  } finally {
    await db
      .update(settings)
      .set({ value: "", updatedAt: new Date().toISOString() })
      .where(
        and(
          eq(settings.key, "cron_lease"),
          lt(settings.value, new Date(Date.now() + 60_000).toISOString()),
        ),
      );
  }
}
