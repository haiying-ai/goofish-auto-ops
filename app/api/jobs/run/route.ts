import { env } from "cloudflare:workers";
import { and, asc, eq, isNull, or, sql } from "drizzle-orm";
import { getDb } from "../../../../db";
import {
  deliveryRules,
  inventory,
  jobRuns,
  orders,
  products,
  settings,
} from "../../../../db/schema";
import {
  ensureAutomationRun,
  finishAutomationRun,
  markAutomationNeedsAttention,
  runAutomationStep,
} from "../../../../lib/automation";
import {
  createApiIdempotencyKey,
  fetchApiDeliveryContent,
  normalizeApiDeliveryConfig,
} from "../../../../lib/api-delivery";
import {
  normalizeSpecKey,
  resolveDeliveryRule,
  type ResolvedDeliveryRule,
} from "../../../../lib/delivery-rules";
import {
  emailStatus,
  sendConfigurationAlert,
  sendOperationalAlert,
} from "../../../../lib/email";
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
import {
  decryptSecret,
  encryptSecret,
  inventoryOwner,
  isEncryptedSecret,
} from "../../../../lib/secrets";

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
  failureAlerts: number;
  lowStockAlerts: number;
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
    failureAlerts: 0,
    lowStockAlerts: 0,
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
          await markOrderFailed(remoteOrder.orderId, message, summary);
        }
      }
    }
    if (!dryRun) await scanLowStockAlerts(summary);

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
    await sendTaskFailureAlert(
      `cron-run-${run.id}`,
      "闲鱼定时任务执行失败",
      ["闲鱼自动运营定时任务未能完成。", "", `错误：${message}`],
      summary,
    );
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
    await sendTaskFailureAlert(
      `publish-product-${queuedProduct.id}`,
      `闲鱼商品上架失败：${queuedProduct.title}`,
      [
        "闲鱼自动运营发布商品时发生错误。",
        "",
        `商品：${queuedProduct.title}`,
        `任务编号：${queuedProduct.id}`,
        `错误：${message}`,
      ],
      summary,
    );
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
  const specKey = normalizeSpecKey(remote.specText);
  await db
    .insert(orders)
    .values({
      xianyuOrderId: remote.orderId,
      xianyuItemId: remote.itemId,
      itemTitle: remote.itemTitle || null,
      specKey,
      specText: remote.specText,
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
        itemTitle: remote.itemTitle || null,
        specKey,
        specText: remote.specText,
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
  if (
    !order ||
    order.shipmentConfirmedAt ||
    order.status === "delivered" ||
    order.status === "resolved"
  ) {
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
    const run = dryRun
      ? null
      : await ensureAutomationRun({
          xianyuOrderId: remote.orderId,
          orderId: order.id,
          productId: null,
          ruleId: null,
        });
    await alertUnconfigured(
      order,
      remote,
      null,
      "该订单商品尚未同步到后台，无法找到发货配置",
      dryRun,
      summary,
      run?.id,
    );
    return imClient;
  }

  const rule = await resolveDeliveryRule(product, specKey, remote.specText);
  await db
    .update(orders)
    .set({
      productId: product.id,
      ruleId: rule.id,
      deliveryType: rule.deliveryType,
      updatedAt: now,
    })
    .where(eq(orders.id, order.id));
  order = {
    ...order,
    productId: product.id,
    ruleId: rule.id,
    deliveryType: rule.deliveryType,
    specKey,
    specText: remote.specText,
    itemTitle: remote.itemTitle || null,
  };

  const issue = await deliveryConfigurationIssue(order, rule);
  const run = dryRun
    ? null
    : await ensureAutomationRun({
        xianyuOrderId: remote.orderId,
        orderId: order.id,
        productId: product.id,
        ruleId: rule.id,
      });
  if (issue) {
    await alertUnconfigured(
      order,
      remote,
      product,
      issue,
      dryRun,
      summary,
      run?.id,
    );
    return imClient;
  }

  summary.plannedDeliveries += 1;
  if (dryRun) return imClient;
  if (!run) throw new Error("订单自动化记录缺失");

  await runAutomationStep({
    run,
    stepKey: "prepare_delivery",
    actionType: `prepare_${rule.deliveryType}`,
    output: (value) =>
      JSON.stringify({ type: rule.deliveryType, contentLength: value.length }),
    execute: async () => prepareDeliveryContent(order, product, rule),
  });
  [order] = await db
    .select()
    .from(orders)
    .where(eq(orders.id, order.id))
    .limit(1);
  if (!order?.deliveryContent) throw new Error("发货内容生成后未能持久化");
  const deliveryContent = await revealOrderDelivery(order);

  await runAutomationStep({
    run,
    stepKey: "send_message",
    actionType: "xianyu_im_text",
    output: () => JSON.stringify({ channel: "xianyu_im" }),
    execute: async () => {
      if (!order.messageSentAt) {
        imClient ||= await XianyuImClient.connect(session);
        await imClient.sendDeliveryMessage({
          buyerId: remote.buyerId,
          itemId: remote.itemId,
          orderId: remote.orderId,
          text: deliveryContent,
        });
        const messageSentAt = new Date().toISOString();
        await db
          .update(orders)
          .set({
            status: "message_sent",
            messageSentAt,
            lastError: null,
            updatedAt: messageSentAt,
          })
          .where(eq(orders.id, order.id));
        order = { ...order, messageSentAt };
      }
      return true;
    },
  });

  await runAutomationStep({
    run,
    stepKey: "confirm_shipment",
    actionType: "xianyu_virtual_shipment",
    output: (value) => JSON.stringify(value),
    execute: async () => {
      if (order.shipmentConfirmedAt || order.status === "delivered") {
        return { alreadyDelivered: true };
      }
      const confirmed = await confirmVirtualShipment(session, remote.orderId);
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
      if (rule.deliveryType === "inventory") {
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
      return confirmed;
    },
  });
  await finishAutomationRun(run.id);
  await maybeSendLowStockAlert(product, rule, summary);
  summary.delivered += 1;
  return imClient;
}

async function deliveryConfigurationIssue(
  order: OrderRow,
  rule: ResolvedDeliveryRule,
) {
  if (order.deliveryContent) return "";
  if (rule.deliveryType === "text") {
    return rule.deliveryContent.trim()
      ? ""
      : `规格“${rule.specLabel}”尚未配置固定发货文本`;
  }
  if (rule.deliveryType === "api") {
    if (!rule.apiConfig.trim()) return `规格“${rule.specLabel}”尚未配置发卡 API`;
    try {
      normalizeApiDeliveryConfig(JSON.parse(rule.apiConfig));
      return "";
    } catch (error) {
      return `规格“${rule.specLabel}”的发卡 API 配置无效：${errorMessage(error)}`;
    }
  }

  const required = Math.max(1, order.quantity);
  const rows = await getDb()
    .select({ id: inventory.id })
    .from(inventory)
    .where(
      and(
        inventoryRulePool(order.productId || rule.productId, rule),
        or(
          eq(inventory.status, "available"),
          and(
            eq(inventory.status, "reserved"),
            eq(inventory.orderId, order.xianyuOrderId),
          ),
        ),
      ),
    );
  return rows.length >= required
    ? ""
    : `规格“${rule.specLabel}”卡密库存不足：本单需要 ${required} 个，可用或已预留 ${rows.length} 个`;
}

async function prepareDeliveryContent(
  order: OrderRow,
  product: ProductRow,
  rule: ResolvedDeliveryRule,
) {
  if (order.deliveryContent) return revealOrderDelivery(order);

  let content = "";
  if (rule.deliveryType === "text") {
    content = rule.deliveryContent.trim();
  } else if (rule.deliveryType === "api") {
    const config = normalizeApiDeliveryConfig(JSON.parse(rule.apiConfig));
    const idempotencyKey = await createApiIdempotencyKey(
      order.xianyuOrderId,
      rule.id,
    );
    const result = await fetchApiDeliveryContent(config, {
      orderId: order.xianyuOrderId,
      itemId: order.xianyuItemId || "",
      buyerId: order.buyerId || "",
      productId: String(product.id),
      specKey: order.specKey,
      specText: order.specText,
      quantity: String(Math.max(1, order.quantity)),
      idempotencyKey,
    });
    content = result.content.trim();
  } else {
    content = await reserveInventoryContent(order, product, rule);
  }
  if (!content.trim()) throw new Error("发货内容为空");

  const protectedContent = await encryptSecret(
    "order-delivery",
    order.xianyuOrderId,
    content,
  );
  await getDb()
    .update(orders)
    .set({
      deliveryType: rule.deliveryType,
      deliveryContent: protectedContent,
      status: "pending",
      alertReason: null,
      lastError: null,
      updatedAt: new Date().toISOString(),
    })
    .where(eq(orders.id, order.id));
  return content;
}

async function reserveInventoryContent(
  order: OrderRow,
  product: ProductRow,
  rule: ResolvedDeliveryRule,
) {
  const db = getDb();
  const required = Math.max(1, order.quantity);
  const reserved = await db
    .select()
    .from(inventory)
    .where(
      and(
        inventoryRulePool(product.id, rule),
        eq(inventory.orderId, order.xianyuOrderId),
        eq(inventory.status, "reserved"),
      ),
    )
    .orderBy(asc(inventory.id));

  while (reserved.length < required) {
    const [candidate] = await db
      .select()
      .from(inventory)
      .where(
        and(
          inventoryRulePool(product.id, rule),
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

  if (reserved.length < required) {
    throw new Error(
      `卡密库存不足：本单需要 ${required} 个，已预留 ${reserved.length} 个`,
    );
  }
  const secrets = await Promise.all(
    reserved.slice(0, required).map((row) =>
      decryptSecret(
        "inventory-secret",
        inventoryOwner(row.productId, row.ruleId),
        row.secret,
      ),
    ),
  );
  const content = [rule.deliveryContent.trim(), ...secrets]
    .filter(Boolean)
    .join("\n");
  if (!content) throw new Error("该规则尚未导入可用卡密");
  return content;
}

function inventoryRulePool(productId: number, rule: ResolvedDeliveryRule) {
  const ruleCondition = rule.id
    ? rule.specKey
      ? eq(inventory.ruleId, rule.id)
      : or(eq(inventory.ruleId, rule.id), isNull(inventory.ruleId))
    : isNull(inventory.ruleId);
  return and(eq(inventory.productId, productId), ruleCondition);
}

async function revealOrderDelivery(order: OrderRow) {
  const value = await decryptSecret(
    "order-delivery",
    order.xianyuOrderId,
    order.deliveryContent,
  );
  if (value && !isEncryptedSecret(order.deliveryContent)) {
    await getDb()
      .update(orders)
      .set({
        deliveryContent: await encryptSecret(
          "order-delivery",
          order.xianyuOrderId,
          value,
        ),
        updatedAt: new Date().toISOString(),
      })
      .where(eq(orders.id, order.id));
  }
  return value;
}

async function alertUnconfigured(
  order: OrderRow,
  remote: PendingSellerOrder,
  product: ProductRow | null,
  reason: string,
  dryRun: boolean,
  summary: RunSummary,
  runId?: number,
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
  if (runId) await markAutomationNeedsAttention(runId, "prepare_delivery", reason);
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

async function markOrderFailed(
  orderId: string,
  message: string,
  summary: RunSummary,
) {
  const db = getDb();
  const [order] = await db
    .select()
    .from(orders)
    .where(eq(orders.xianyuOrderId, orderId))
    .limit(1);
  await db
    .update(orders)
    .set({
      status: "failed",
      attempts: sql`${orders.attempts} + 1`,
      lastError: message,
      updatedAt: new Date().toISOString(),
    })
    .where(eq(orders.xianyuOrderId, orderId));
  if (!order || order.failureAlertedAt) return;
  try {
    const result = await sendOperationalAlert({
      eventKey: `failure-${orderId}`,
      subject: `闲鱼自动发货失败：${order.itemTitle || order.xianyuItemId || orderId}`,
      lines: [
        "闲鱼自动运营处理订单时发生错误，需要检查或人工补偿。",
        "",
        `订单号：${orderId}`,
        `商品：${order.itemTitle || "未知商品"}`,
        `规格：${order.specText || "默认规格"}`,
        "失败步骤：请在后台“订单管理”查看",
        `错误：${message}`,
      ],
    });
    if (result.configurationRequired) {
      summary.emailConfigurationRequired = true;
    } else if (result.sent) {
      summary.emailsSent += 1;
      summary.failureAlerts += 1;
      await db
        .update(orders)
        .set({ failureAlertedAt: new Date().toISOString() })
        .where(eq(orders.id, order.id));
    }
  } catch (error) {
    summary.errors.push(`订单 ${orderId} 失败邮件：${errorMessage(error)}`);
  }
}

async function maybeSendLowStockAlert(
  product: ProductRow,
  rule: ResolvedDeliveryRule,
  summary: RunSummary,
) {
  if (rule.deliveryType !== "inventory" || !rule.id) return;
  const db = getDb();
  const [savedRule] = await db
    .select()
    .from(deliveryRules)
    .where(eq(deliveryRules.id, rule.id))
    .limit(1);
  if (!savedRule) return;
  const availableRows = await db
    .select({ id: inventory.id })
    .from(inventory)
    .where(
      and(
        inventoryRulePool(product.id, rule),
        eq(inventory.status, "available"),
      ),
    );
  const available = availableRows.length;
  if (available > savedRule.lowStockThreshold) {
    if (savedRule.lastLowStockLevel !== null) {
      await db
        .update(deliveryRules)
        .set({ lastLowStockLevel: null, updatedAt: new Date().toISOString() })
        .where(eq(deliveryRules.id, savedRule.id));
    }
    return;
  }
  if (savedRule.lastLowStockLevel === available) return;
  try {
    const result = await sendOperationalAlert({
      eventKey: `low-stock-${savedRule.id}-${available}`,
      subject: `闲鱼卡密库存预警：${product.title} 剩余 ${available}`,
      lines: [
        "闲鱼自动运营检测到卡密库存低于预警阈值。",
        "",
        `商品：${product.title}`,
        `规格：${savedRule.specLabel || "默认规则"}`,
        `当前可用：${available}`,
        `预警阈值：${savedRule.lowStockThreshold}`,
        "",
        "请登录后台“自动发货”页面补充库存。",
      ],
    });
    if (result.configurationRequired) {
      summary.emailConfigurationRequired = true;
    } else if (result.sent) {
      summary.emailsSent += 1;
      summary.lowStockAlerts += 1;
      await db
        .update(deliveryRules)
        .set({
          lastLowStockLevel: available,
          updatedAt: new Date().toISOString(),
        })
        .where(eq(deliveryRules.id, savedRule.id));
    }
  } catch (error) {
    summary.errors.push(`库存预警邮件：${errorMessage(error)}`);
  }
}

async function scanLowStockAlerts(summary: RunSummary) {
  const db = getDb();
  const [ruleRows, productRows] = await Promise.all([
    db
      .select()
      .from(deliveryRules)
      .where(
        and(
          eq(deliveryRules.deliveryType, "inventory"),
          eq(deliveryRules.enabled, true),
        ),
      ),
    db.select().from(products),
  ]);
  const productById = new Map(productRows.map((row) => [row.id, row]));
  for (const rule of ruleRows) {
    const product = productById.get(rule.productId);
    if (!product) continue;
    await maybeSendLowStockAlert(
      product,
      {
        id: rule.id,
        productId: rule.productId,
        specKey: rule.specKey,
        specLabel: rule.specLabel || rule.specKey || "默认规则",
        deliveryType: "inventory",
        deliveryContent: "",
        apiConfig: "",
        lowStockThreshold: rule.lowStockThreshold,
        enabled: rule.enabled,
        legacy: false,
      },
      summary,
    );
  }
}

async function sendTaskFailureAlert(
  eventKey: string,
  subject: string,
  lines: string[],
  summary: RunSummary,
) {
  try {
    const result = await sendOperationalAlert({ eventKey, subject, lines });
    if (result.configurationRequired) {
      summary.emailConfigurationRequired = true;
    } else if (result.sent) {
      summary.emailsSent += 1;
      summary.failureAlerts += 1;
    }
  } catch (error) {
    summary.errors.push(`任务失败邮件：${errorMessage(error)}`);
  }
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
