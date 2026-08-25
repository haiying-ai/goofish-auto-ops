import { env } from "cloudflare:workers";
import { and, desc, eq, or } from "drizzle-orm";
import { getDb } from "../../../db";
import {
  automationRuns,
  automationSteps,
  deliveryRules,
  inventory,
  orders,
  products,
} from "../../../db/schema";
import {
  ensureAutomationRun,
  finishAutomationRun,
  runAutomationStep,
} from "../../../lib/automation";
import { decryptSecret } from "../../../lib/secrets";
import { confirmVirtualShipment } from "../../../lib/xianyu-orders";
import { createXianyuSession } from "../../../lib/xianyu-session";

export const dynamic = "force-dynamic";

type RuntimeEnv = { XIANYU_COOKIE?: string };

export async function GET() {
  try {
    const db = getDb();
    const [orderRows, productRows, ruleRows, runRows, stepRows] =
      await Promise.all([
        db.select().from(orders).orderBy(desc(orders.updatedAt)).limit(200),
        db.select().from(products),
        db.select().from(deliveryRules),
        db
          .select()
          .from(automationRuns)
          .orderBy(desc(automationRuns.updatedAt))
          .limit(300),
        db
          .select()
          .from(automationSteps)
          .orderBy(desc(automationSteps.updatedAt))
          .limit(900),
      ]);
    const productById = new Map(productRows.map((row) => [row.id, row]));
    const ruleById = new Map(ruleRows.map((row) => [row.id, row]));
    const runByOrder = new Map<number, (typeof runRows)[number]>();
    for (const run of runRows) {
      if (!runByOrder.has(run.orderId)) runByOrder.set(run.orderId, run);
    }
    const stepsByRun = new Map<number, typeof stepRows>();
    for (const step of stepRows) {
      const current = stepsByRun.get(step.runId) || [];
      current.push(step);
      stepsByRun.set(step.runId, current);
    }
    return Response.json({
      orders: await Promise.all(
        orderRows.map(async (order) => {
          const run = runByOrder.get(order.id) || null;
          const product = order.productId
            ? productById.get(order.productId) || null
            : null;
          const rule = order.ruleId ? ruleById.get(order.ruleId) || null : null;
          return {
            ...order,
            deliveryContent: await decryptSecret(
              "order-delivery",
              order.xianyuOrderId,
              order.deliveryContent,
            ),
            productTitle: product?.title || order.itemTitle || "未同步商品",
            ruleLabel: rule?.specLabel || order.specText || "默认规则",
            automation: run
              ? { ...run, steps: stepsByRun.get(run.id) || [] }
              : null,
          };
        }),
      ),
    });
  } catch (error) {
    return Response.json(
      { error: errorMessage(error) || "读取订单失败" },
      { status: 500 },
    );
  }
}

export async function PATCH(request: Request) {
  try {
    const input = (await request.json()) as {
      id?: number;
      action?: string;
      note?: string;
    };
    const id = Number(input.id);
    if (!id) throw new Error("订单编号无效");
    const db = getDb();
    const [order] = await db
      .select()
      .from(orders)
      .where(eq(orders.id, id))
      .limit(1);
    if (!order) return Response.json({ error: "订单不存在" }, { status: 404 });
    const [run] = await db
      .select()
      .from(automationRuns)
      .where(eq(automationRuns.orderId, order.id))
      .orderBy(desc(automationRuns.updatedAt))
      .limit(1);
    const now = new Date().toISOString();

    if (input.action === "retry" || input.action === "resend") {
      if (order.status === "delivered" || order.shipmentConfirmedAt) {
        throw new Error("该订单已确认发货，不能重新发送");
      }
      if (input.action === "resend" && !order.deliveryContent) {
        throw new Error("该订单尚未生成发货内容");
      }
      await db
        .update(orders)
        .set({
          status: "pending",
          messageSentAt:
            input.action === "resend" ? null : order.messageSentAt,
          lastError: null,
          alertReason: null,
          failureAlertedAt: null,
          updatedAt: now,
        })
        .where(eq(orders.id, order.id));
      if (run) {
        await db
          .update(automationRuns)
          .set({
            status: "pending",
            currentStep: input.action === "resend" ? "send_message" : "",
            lastError: null,
            finishedAt: null,
            updatedAt: now,
          })
          .where(eq(automationRuns.id, run.id));
        await db
          .update(automationSteps)
          .set({
            status: "pending",
            lastError: null,
            finishedAt: null,
            updatedAt: now,
          })
          .where(
            and(
              eq(automationSteps.runId, run.id),
              input.action === "resend"
                ? or(
                    eq(automationSteps.stepKey, "send_message"),
                    eq(automationSteps.stepKey, "confirm_shipment"),
                  )
                : or(
                    eq(automationSteps.status, "failed"),
                    eq(automationSteps.status, "needs_attention"),
                  ),
            ),
          );
      }
      return Response.json({ success: true, queued: true });
    }

    if (input.action === "confirm_shipment") {
      if (order.shipmentConfirmedAt || order.status === "delivered") {
        return Response.json({ success: true, alreadyDelivered: true });
      }
      const cookie = (env as unknown as RuntimeEnv).XIANYU_COOKIE;
      if (!cookie) throw new Error("尚未配置闲鱼 Cookie");
      const session = await createXianyuSession(cookie);
      const automation = await ensureAutomationRun({
        xianyuOrderId: order.xianyuOrderId,
        orderId: order.id,
        productId: order.productId,
        ruleId: order.ruleId,
      });
      const result = await runAutomationStep({
        run: automation,
        stepKey: "confirm_shipment",
        actionType: "manual_virtual_shipment",
        output: (value) => JSON.stringify(value),
        execute: async () => {
          const confirmed = await confirmVirtualShipment(
            session,
            order.xianyuOrderId,
          );
          const deliveredAt = new Date().toISOString();
          await db
            .update(orders)
            .set({
              status: "delivered",
              deliveredAt,
              shipmentConfirmedAt: deliveredAt,
              lastError: null,
              updatedAt: deliveredAt,
            })
            .where(eq(orders.id, order.id));
          await db
            .update(inventory)
            .set({ status: "used", deliveredAt })
            .where(
              and(
                eq(inventory.orderId, order.xianyuOrderId),
                eq(inventory.status, "reserved"),
              ),
            );
          return confirmed;
        },
      });
      await finishAutomationRun(automation.id);
      return Response.json({ success: true, result: result.value });
    }

    if (input.action === "mark_resolved") {
      await db
        .update(orders)
        .set({
          status: "resolved",
          manualNote: String(input.note || "已人工处理").trim(),
          lastError: null,
          updatedAt: now,
        })
        .where(eq(orders.id, order.id));
      if (run) {
        await db
          .update(automationRuns)
          .set({
            status: "resolved",
            currentStep: "manual_resolution",
            lastError: null,
            finishedAt: now,
            updatedAt: now,
          })
          .where(eq(automationRuns.id, run.id));
      }
      return Response.json({ success: true, resolved: true });
    }

    throw new Error("不支持的订单操作");
  } catch (error) {
    return Response.json({ error: errorMessage(error) }, { status: 400 });
  }
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error || "操作失败");
}
