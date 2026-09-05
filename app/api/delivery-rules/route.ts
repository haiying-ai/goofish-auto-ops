import { eq, ne } from "drizzle-orm";
import { getDb } from "../../../db";
import { deliveryRules, inventory, products } from "../../../db/schema";
import { normalizeApiDeliveryConfig } from "../../../lib/api-delivery";
import {
  exposeDeliveryRule,
  normalizeDeliveryType,
  normalizeSpecKey,
  protectDeliveryRule,
} from "../../../lib/delivery-rules";
import { decryptSecret, encryptSecret } from "../../../lib/secrets";
import { requireOwnerAccess } from "../../../lib/access";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const denied = await requireOwnerAccess(request);
  if (denied) return denied;
  try {
    const db = getDb();
    const [productRows, ruleRows, inventoryRows] = await Promise.all([
      db.select().from(products).where(ne(products.status, "offline")),
      db.select().from(deliveryRules),
      db
        .select({
          id: inventory.id,
          productId: inventory.productId,
          ruleId: inventory.ruleId,
          status: inventory.status,
        })
        .from(inventory),
    ]);
    const rows: Array<Record<string, unknown>> = [];
    for (const product of productRows) {
      const assigned = ruleRows.filter((rule) => rule.productId === product.id);
      const hasDefault = assigned.some((rule) => !rule.specKey);
      if (!hasDefault) {
        const legacyContent = await decryptSecret(
          "product-delivery",
          product.id,
          product.deliveryContent,
        );
        rows.push({
          id: null,
          productId: product.id,
          title: product.title,
          xianyuItemId: product.xianyuItemId,
          productStatus: product.status,
          skuJson: product.skuJson,
          specKey: "",
          specLabel: "默认规则",
          deliveryType: normalizeDeliveryType(product.deliveryType),
          deliveryContent: legacyContent,
          apiConfig: null,
          lowStockThreshold: 3,
          enabled: true,
          legacy: true,
          updatedAt: product.updatedAt,
          ...inventoryCounts(
            inventoryRows.filter(
              (row) => row.productId === product.id && row.ruleId === null,
            ),
          ),
        });
      }
      for (const rule of assigned) {
        const exposed = await exposeDeliveryRule(rule);
        const pool = inventoryRows.filter(
          (row) =>
            row.productId === product.id &&
            (row.ruleId === rule.id || (!rule.specKey && row.ruleId === null)),
        );
        rows.push({
          ...exposed,
          title: product.title,
          xianyuItemId: product.xianyuItemId,
          productStatus: product.status,
          skuJson: product.skuJson,
          updatedAt: exposed.updatedAt || product.updatedAt,
          apiConfig: parseJsonObject(exposed.apiConfig),
          ...inventoryCounts(pool),
        });
      }
    }
    rows.sort((left, right) => {
      const updatedDifference =
        timestamp(right.updatedAt) - timestamp(left.updatedAt);
      if (updatedDifference !== 0) return updatedDifference;
      const productDifference = Number(right.productId) - Number(left.productId);
      if (productDifference !== 0) return productDifference;
      return String(left.specLabel || "").localeCompare(
        String(right.specLabel || ""),
        "zh-CN",
      );
    });
    return Response.json({ rules: rows });
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "读取发货规则失败" },
      { status: 500 },
    );
  }
}

export async function POST(request: Request) {
  const denied = await requireOwnerAccess(request);
  if (denied) return denied;
  try {
    const input = (await request.json()) as Record<string, unknown>;
    const productId = Number(input.productId || input.id);
    if (!productId) throw new Error("请选择商品");
    const db = getDb();
    const [product] = await db
      .select()
      .from(products)
      .where(eq(products.id, productId))
      .limit(1);
    if (!product) throw new Error("商品不存在");

    const specLabel = String(input.specLabel || input.specKey || "").trim();
    const specKey = normalizeSpecKey(specLabel);
    const deliveryType = normalizeDeliveryType(
      String(input.deliveryType || "text"),
    );
    const deliveryContent = String(input.deliveryContent || "").trim();
    const lowStockThreshold = Math.max(
      0,
      Math.min(9999, Math.floor(Number(input.lowStockThreshold ?? 3) || 0)),
    );
    let apiConfig = "";
    if (deliveryType === "api") {
      const rawConfig =
        typeof input.apiConfig === "string"
          ? parseJsonObject(input.apiConfig)
          : input.apiConfig;
      apiConfig = JSON.stringify(normalizeApiDeliveryConfig(rawConfig));
    }
    const protectedValues = await protectDeliveryRule({
      productId,
      specKey,
      deliveryContent,
      apiConfig,
    });
    const now = new Date().toISOString();
    const [row] = await db
      .insert(deliveryRules)
      .values({
        productId,
        specKey,
        specLabel,
        deliveryType,
        deliveryContent: protectedValues.deliveryContent,
        apiConfig: protectedValues.apiConfig,
        lowStockThreshold,
        enabled: input.enabled !== false,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [deliveryRules.productId, deliveryRules.specKey],
        set: {
          specLabel,
          deliveryType,
          deliveryContent: protectedValues.deliveryContent,
          apiConfig: protectedValues.apiConfig,
          lowStockThreshold,
          enabled: input.enabled !== false,
          lastLowStockLevel: null,
          updatedAt: now,
        },
      })
      .returning();

    if (!specKey) {
      await db
        .update(products)
        .set({
          deliveryType,
          deliveryContent: await encryptSecret(
            "product-delivery",
            productId,
            deliveryContent,
          ),
          updatedAt: now,
        })
        .where(eq(products.id, productId));
    }
    return Response.json({ rule: await exposeDeliveryRule(row) }, { status: 201 });
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "保存发货规则失败" },
      { status: 400 },
    );
  }
}

export async function DELETE(request: Request) {
  const denied = await requireOwnerAccess(request);
  if (denied) return denied;
  try {
    const input = (await request.json()) as { id?: number };
    const id = Number(input.id);
    if (!id) throw new Error("默认兼容规则不能删除，可直接修改");
    const db = getDb();
    const [stock] = await db
      .select({ id: inventory.id })
      .from(inventory)
      .where(eq(inventory.ruleId, id))
      .limit(1);
    if (stock) throw new Error("该规则仍有关联卡密，不能删除");
    const [deleted] = await db
      .delete(deliveryRules)
      .where(eq(deliveryRules.id, id))
      .returning();
    if (!deleted) return Response.json({ error: "规则不存在" }, { status: 404 });
    return Response.json({ deleted: true });
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "删除规则失败" },
      { status: 409 },
    );
  }
}

function inventoryCounts(rows: Array<{ status: string }>) {
  return rows.reduce(
    (counts, row) => {
      if (row.status === "available") counts.available += 1;
      else if (row.status === "reserved") counts.reserved += 1;
      else if (row.status === "used") counts.used += 1;
      return counts;
    },
    { available: 0, reserved: 0, used: 0 },
  );
}

function parseJsonObject(value: unknown) {
  if (value && typeof value === "object" && !Array.isArray(value)) return value;
  if (typeof value !== "string" || !value.trim()) return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed
      : {};
  } catch {
    throw new Error("API 配置必须是有效 JSON");
  }
}

function timestamp(value: unknown) {
  const parsed = Date.parse(String(value || ""));
  return Number.isFinite(parsed) ? parsed : 0;
}
