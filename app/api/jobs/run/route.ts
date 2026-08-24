import { env } from "cloudflare:workers";
import { and, asc, eq, sql } from "drizzle-orm";
import { getDb } from "../../../../db";
import {
  inventory,
  jobRuns,
  orders,
  products,
  settings,
} from "../../../../db/schema";
import { emailStatus, sendConfigurationAlert } from "../../../../lib/email";
import {
  parseListingImages,
  publishListing,
  type ListingInput,
  type ListingProperty,
  type ListingSku,
  type ShippingMode,
  type XianyuSession,
} from "../../../../lib/xianyu-items";
import { XianyuImClient } from "../../../../lib/xianyu-im";
import {
  confirmVirtualShipment,
  fetchPendingSellerOrders,
  type PendingSellerOrder,
} from "../../../../lib/xianyu-orders";
import { createXianyuSession } from "../../../../lib/xianyu-session";

export const dynamic = "force-dynamic";

type RuntimeEnv = { CRON_SECRET?: string; XIANYU_COOKIE?: string };
type ProductRow = typeof products.$inferSelect;
type OrderRow = typeof orders.$inferSelect;

type RunSummary = {
  published: number;
  pendingOrders: number;
  delivered: number;
  plannedDeliveries: number;
  configurationAlerts: number;
  emailsSent: number;
  emailConfigurationRequired: boolean;
  skippedRefunds: number;
  failed: number;
  dryRun: boolean;
  configurationRequired: boolean;
  errors: string[];
};

async function authorized(request: Request) {
  const secret = (env as unknown as RuntimeEnv).CRON_SECRET;
  if (request.headers.get("oai-authenticated-user-email")) return true;
  if (!secret) return false;
  const auth = request.headers.get("authorization");
  return auth === `Bearer ${secret}`;
}

export async function POST(request: Request) {
  if (!(await authorized(request))) {
    return Response.json({ error: "任务密钥无效" }, { status: 401 });
  }

  let requestedProductId = 0;
  let dryRun = false;
  try {
    const body = (await request.json()) as {
      productId?: number;
      dryRun?: boolean;
    };
    requestedProductId = Number(body.productId) || 0;
    dryRun = body.dryRun === true;
  } catch {
    // cron-job.org can send an empty POST body.
  }

  const db = getDb();
  const startedAt = new Date().toISOString();
  const leaseCutoff = new Date(Date.now() - 4 * 60_000).toISOString();
  const [lock] = await db
    .select()
    .from(settings)
    .where(eq(settings.key, "cron_lease"))
    .limit(1);
  if (lock && lock.value > leaseCutoff) {
    return Response.json({ error: "上一轮任务仍在执行" }, { status: 409 });
  }

  await db
    .insert(settings)
    .values({ key: "cron_lease", value: startedAt, updatedAt: startedAt })
    .onConflictDoUpdate({
      target: settings.key,
      set: { value: startedAt, updatedAt: startedAt },
    });
  const [run] = await db
    .insert(jobRuns)
    .values({ job: dryRun ? "all_dry_run" : "all", status: "running" })
    .returning();

  const runtime = env as unknown as RuntimeEnv;
  const summary: RunSummary = {
    published: 0,
    pendingOrders: 0,
    delivered: 0,
    plannedDeliveries: 0,
    configurationAlerts: 0,
    emailsSent: 0,
    emailConfigurationRequired: !emailStatus().configured,
    skippedRefunds: 0,
    failed: 0,
    dryRun,
    configurationRequired: !runtime.XIANYU_COOKIE,
    errors: [],
  };
  let imClient: XianyuImClient | null = null;

  try {
    const session = runtime.XIANYU_COOKIE
      ? await createXianyuSession(runtime.XIANYU_COOKIE)
      : null;
    await publishNextQueuedProduct(
      session,
      requestedProductId,
      dryRun,
      summary,
    );

    if (session) {
      const pending = await fetchPendingSellerOrders(session, {
        maxPages: 2,
        pageSize: 50,
      });
      summary.pendingOrders = pending.length;
      for (const remoteOrder of pending.slice(0, 25)) {
        try {
          imClient = await processPendingOrder(
            session,
            imClient,
            remoteOrder,
            dryRun,
            summary,
          );
        } catch (error) {
          imClient?.close();
          imClient = null;
          summary.failed += 1;
          const message = errorMessage(error);
          summary.errors.push(`${remoteOrder.orderId}: ${message}`);
          await markOrderFailed(remoteOrder.orderId, message);
        }
      }
    }

    const status = summary.failed ? "partial" : "success";
    await db
      .update(jobRuns)
      .set({
        status,
        summary: JSON.stringify(summary),
        finishedAt: new Date().toISOString(),
      })
      .where(eq(jobRuns.id, run.id));
    return Response.json({ success: summary.failed === 0, ...summary });
  } catch (error) {
    const message = errorMessage(error);
    summary.failed += 1;
    summary.errors.push(message);
    await db
      .update(jobRuns)
      .set({
        status: "failed",
        summary: JSON.stringify(summary),
        finishedAt: new Date().toISOString(),
      })
      .where(eq(jobRuns.id, run.id));
    return Response.json({ error: message, ...summary }, { status: 500 });
  } finally {
    imClient?.close();
    await db
      .update(settings)
      .set({ value: "", updatedAt: new Date().toISOString() })
      .where(
        and(
          eq(settings.key, "cron_lease"),
          eq(settings.value, startedAt),
        ),
      );
  }
}

async function publishNextQueuedProduct(
  session: XianyuSession | null,
  requestedProductId: number,
  dryRun: boolean,
  summary: RunSummary,
) {
  const db = getDb();
  const [queuedProduct] = await db
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
  if (!queuedProduct || dryRun) return;
  if (!session) {
    if (requestedProductId) throw new Error("等待配置闲鱼 Cookie");
    return;
  }

  try {
    const remote = await publishListing(session, productListing(queuedProduct));
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
    summary.published += 1;
  } catch (error) {
    const message = errorMessage(error);
    const throttled = /秒后|频繁|限流|too many/i.test(message);
    await db
      .update(products)
      .set({
        status: throttled ? "queued" : "failed",
        lastError: message,
        updatedAt: new Date().toISOString(),
      })
      .where(eq(products.id, queuedProduct.id));
    if (requestedProductId) throw error;
    summary.failed += 1;
    summary.errors.push(`商品 ${queuedProduct.id}: ${message}`);
  }
}

async function processPendingOrder(
  session: XianyuSession,
  imClient: XianyuImClient | null,
  remote: PendingSellerOrder,
  dryRun: boolean,
  summary: RunSummary,
) {
  const db = getDb();
  const now = new Date().toISOString();
  await db
    .insert(orders)
    .values({
      xianyuOrderId: remote.orderId,
      xianyuItemId: remote.itemId,
      buyerId: remote.buyerId || null,
      buyerNick: remote.buyerNick || null,
      quantity: remote.quantity,
      rawStatus: remote.statusText || null,
      status: remote.inRefund ? "refund" : "pending",
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: orders.xianyuOrderId,
      set: {
        xianyuItemId: remote.itemId,
        buyerId: remote.buyerId || null,
        buyerNick: remote.buyerNick || null,
        quantity: remote.quantity,
        rawStatus: remote.statusText || null,
        updatedAt: now,
      },
    });
  let [order] = await db
    .select()
    .from(orders)
    .where(eq(orders.xianyuOrderId, remote.orderId))
    .limit(1);
  if (!order || order.shipmentConfirmedAt || order.status === "delivered") {
    return imClient;
  }
  if (remote.inRefund) {
    summary.skippedRefunds += 1;
    await db
      .update(orders)
      .set({ status: "refund", updatedAt: now })
      .where(eq(orders.id, order.id));
    return imClient;
  }

  const [product] = await db
    .select()
    .from(products)
    .where(eq(products.xianyuItemId, remote.itemId))
    .limit(1);
  if (!product) {
    await alertUnconfigured(
      order,
      remote,
      null,
      "该订单商品尚未同步到后台，无法找到发货配置",
      dryRun,
      summary,
    );
    return imClient;
  }

  await db
    .update(orders)
    .set({ productId: product.id, updatedAt: now })
    .where(eq(orders.id, order.id));
  order = { ...order, productId: product.id };

  const plan = await buildDeliveryPlan(order, product, dryRun);
  if (!plan.configured) {
    await alertUnconfigured(
      order,
      remote,
      product,
      plan.reason,
      dryRun,
      summary,
    );
    return imClient;
  }

  summary.plannedDeliveries += 1;
  if (dryRun) return imClient;

  if (!order.messageSentAt) {
    imClient ||= await XianyuImClient.connect(session);
    await imClient.sendDeliveryMessage({
      buyerId: remote.buyerId,
      itemId: remote.itemId,
      orderId: remote.orderId,
      text: plan.content,
    });
    const messageSentAt = new Date().toISOString();
    await db
      .update(orders)
      .set({
        status: "message_sent",
        deliveryContent: plan.content,
        messageSentAt,
        lastError: null,
        updatedAt: messageSentAt,
      })
      .where(eq(orders.id, order.id));
    order = { ...order, messageSentAt, deliveryContent: plan.content };
  }

  await confirmVirtualShipment(session, remote.orderId);
  const deliveredAt = new Date().toISOString();
  await db
    .update(orders)
    .set({
      status: "delivered",
      deliveredAt,
      shipmentConfirmedAt: deliveredAt,
      alertReason: null,
      lastError: null,
      updatedAt: deliveredAt,
    })
    .where(eq(orders.id, order.id));
  if (product.deliveryType === "inventory") {
    await db
      .update(inventory)
      .set({ status: "used", deliveredAt })
      .where(
        and(
          eq(inventory.productId, product.id),
          eq(inventory.orderId, remote.orderId),
          eq(inventory.status, "reserved"),
        ),
      );
  }
  summary.delivered += 1;
  return imClient;
}

async function buildDeliveryPlan(
  order: OrderRow,
  product: ProductRow,
  dryRun: boolean,
): Promise<
  { configured: true; content: string } | { configured: false; reason: string }
> {
  if (order.messageSentAt && order.deliveryContent) {
    return { configured: true, content: order.deliveryContent };
  }
  if (product.deliveryType !== "inventory") {
    const content = product.deliveryContent.trim();
    return content
      ? { configured: true, content }
      : { configured: false, reason: "该商品尚未配置固定发货文本" };
  }

  const db = getDb();
  const required = Math.max(1, order.quantity);
  let reserved = await db
    .select()
    .from(inventory)
    .where(
      and(
        eq(inventory.productId, product.id),
        eq(inventory.orderId, order.xianyuOrderId),
        eq(inventory.status, "reserved"),
      ),
    )
    .orderBy(asc(inventory.id));

  if (dryRun) {
    const available = await db
      .select()
      .from(inventory)
      .where(
        and(
          eq(inventory.productId, product.id),
          eq(inventory.status, "available"),
        ),
      )
      .orderBy(asc(inventory.id))
      .limit(Math.max(0, required - reserved.length));
    reserved = [...reserved, ...available];
  } else {
    while (reserved.length < required) {
      const [candidate] = await db
        .select()
        .from(inventory)
        .where(
          and(
            eq(inventory.productId, product.id),
            eq(inventory.status, "available"),
          ),
        )
        .orderBy(asc(inventory.id))
        .limit(1);
      if (!candidate) break;
      const [claimed] = await db
        .update(inventory)
        .set({ status: "reserved", orderId: order.xianyuOrderId })
        .where(
          and(
            eq(inventory.id, candidate.id),
            eq(inventory.status, "available"),
          ),
        )
        .returning();
      if (claimed) reserved.push(claimed);
    }
  }

  if (reserved.length < required) {
    return {
      configured: false,
      reason: `卡密库存不足：本单需要 ${required} 个，已预留或可用 ${reserved.length} 个`,
    };
  }
  const content = [
    product.deliveryContent.trim(),
    ...reserved.slice(0, required).map((row) => row.secret),
  ]
    .filter(Boolean)
    .join("\n");
  return content
    ? { configured: true, content }
    : { configured: false, reason: "该商品尚未导入可用卡密" };
}

async function alertUnconfigured(
  order: OrderRow,
  remote: PendingSellerOrder,
  product: ProductRow | null,
  reason: string,
  dryRun: boolean,
  summary: RunSummary,
) {
  summary.configurationAlerts += 1;
  if (dryRun) return;
  const db = getDb();
  const now = new Date().toISOString();
  await db
    .update(orders)
    .set({
      status: "needs_configuration",
      alertReason: reason,
      lastError: reason,
      updatedAt: now,
    })
    .where(eq(orders.id, order.id));
  if (order.alertedAt) return;

  const result = await sendConfigurationAlert({
    orderId: remote.orderId,
    itemId: remote.itemId,
    productTitle: product?.title || remote.itemTitle,
    reason,
  });
  if (result.configurationRequired) {
    summary.emailConfigurationRequired = true;
    return;
  }
  if (result.sent) {
    summary.emailsSent += 1;
    await db
      .update(orders)
      .set({ alertedAt: new Date().toISOString() })
      .where(eq(orders.id, order.id));
  }
}

async function markOrderFailed(orderId: string, message: string) {
  await getDb()
    .update(orders)
    .set({
      status: "failed",
      attempts: sql`${orders.attempts} + 1`,
      lastError: message,
      updatedAt: new Date().toISOString(),
    })
    .where(eq(orders.xianyuOrderId, orderId));
}

function productListing(row: ProductRow): ListingInput {
  return {
    title: row.title,
    description: row.description,
    priceCents: row.priceCents,
    originalPriceCents: row.originalPriceCents,
    quantity: row.quantity,
    shippingMode: normalizeShippingMode(row.shippingMode),
    shippingFeeCents: row.shippingFeeCents,
    selfPickup: row.selfPickup,
    categoryMode: row.categoryMode === "manual" ? "manual" : "auto",
    categoryId: row.categoryId || undefined,
    categoryName: row.categoryName || undefined,
    skus: parseJsonArray<ListingSku>(row.skuJson),
    properties: parseJsonArray<ListingProperty>(row.propertiesJson),
    images: parseListingImages(row.imagesJson),
  };
}

function normalizeShippingMode(value: string): ShippingMode {
  return value === "free" || value === "distance" || value === "fixed"
    ? value
    : "none";
}

function parseJsonArray<T>(value: string) {
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  } catch {
    return [];
  }
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error || "任务失败");
}
