import { and, asc, eq } from "drizzle-orm";
import { getDb } from "../db";
import { deliveryRules, products } from "../db/schema";
import {
  decryptSecret,
  deliveryRuleOwner,
  encryptSecret,
  isEncryptedSecret,
} from "./secrets";

export type DeliveryType = "text" | "inventory" | "api";
export type DeliveryRuleRow = typeof deliveryRules.$inferSelect;
export type ProductRow = typeof products.$inferSelect;

export type ResolvedDeliveryRule = {
  id: number | null;
  productId: number;
  specKey: string;
  specLabel: string;
  deliveryType: DeliveryType;
  deliveryContent: string;
  apiConfig: string;
  lowStockThreshold: number;
  enabled: boolean;
  legacy: boolean;
};

export async function resolveDeliveryRule(
  product: ProductRow,
  orderSpecKey: string,
  orderSpecText = "",
): Promise<ResolvedDeliveryRule> {
  const rules = await getDb()
    .select()
    .from(deliveryRules)
    .where(
      and(
        eq(deliveryRules.productId, product.id),
        eq(deliveryRules.enabled, true),
      ),
    )
    .orderBy(asc(deliveryRules.id));
  const normalizedOrder = normalizeSpecKey(orderSpecKey || orderSpecText);
  const exact = rules.find(
    (rule) => rule.specKey && normalizeSpecKey(rule.specKey) === normalizedOrder,
  );
  const compatible = rules.find(
    (rule) =>
      rule.specKey && specMatches(rule.specKey, normalizedOrder || orderSpecText),
  );
  const selected = exact || compatible || rules.find((rule) => !rule.specKey);
  if (selected) {
    const exposed = await exposeDeliveryRule(selected);
    if (
      (exposed.deliveryContent && !isEncryptedSecret(selected.deliveryContent)) ||
      (exposed.apiConfig && !isEncryptedSecret(selected.apiConfig))
    ) {
      const protectedValues = await protectDeliveryRule({
        productId: selected.productId,
        specKey: selected.specKey,
        deliveryContent: exposed.deliveryContent,
        apiConfig: exposed.apiConfig,
      });
      await getDb()
        .update(deliveryRules)
        .set({ ...protectedValues, updatedAt: new Date().toISOString() })
        .where(eq(deliveryRules.id, selected.id));
    }
    return exposed;
  }

  const legacyType = normalizeDeliveryType(product.deliveryType);
  const legacyContent = await decryptSecret(
    "product-delivery",
    product.id,
    product.deliveryContent,
  );
  if (legacyContent && !isEncryptedSecret(product.deliveryContent)) {
    await getDb()
      .update(products)
      .set({
        deliveryContent: await encryptSecret(
          "product-delivery",
          product.id,
          legacyContent,
        ),
        updatedAt: new Date().toISOString(),
      })
      .where(eq(products.id, product.id));
  }
  return {
    id: null,
    productId: product.id,
    specKey: "",
    specLabel: "默认规则",
    deliveryType: legacyType,
    deliveryContent: legacyContent,
    apiConfig: "",
    lowStockThreshold: 3,
    enabled: true,
    legacy: true,
  };
}

export async function exposeDeliveryRule(
  rule: DeliveryRuleRow,
): Promise<ResolvedDeliveryRule> {
  const owner = deliveryRuleOwner(rule.productId, rule.specKey);
  return {
    id: rule.id,
    productId: rule.productId,
    specKey: rule.specKey,
    specLabel: rule.specLabel || rule.specKey || "默认规则",
    deliveryType: normalizeDeliveryType(rule.deliveryType),
    deliveryContent: await decryptSecret(
      "delivery-content",
      owner,
      rule.deliveryContent,
    ),
    apiConfig: await decryptSecret("api-config", owner, rule.apiConfig),
    lowStockThreshold: Math.max(0, rule.lowStockThreshold),
    enabled: rule.enabled,
    legacy: false,
  };
}

export async function protectDeliveryRule(input: {
  productId: number;
  specKey: string;
  deliveryContent: string;
  apiConfig: string;
}) {
  const owner = deliveryRuleOwner(input.productId, input.specKey);
  return {
    deliveryContent: await encryptSecret(
      "delivery-content",
      owner,
      input.deliveryContent,
    ),
    apiConfig: await encryptSecret("api-config", owner, input.apiConfig),
  };
}

export function normalizeSpecKey(value: string) {
  return String(value || "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[：:]/g, "=")
    .split(/[;,，；|/、]+/)
    .map((part) => part.replace(/\s+/g, "").trim())
    .filter(Boolean)
    .sort((left, right) => left.localeCompare(right, "zh-CN"))
    .join(";");
}

export function specMatches(configured: string, actual: string) {
  const expected = normalizeSpecKey(configured);
  const received = normalizeSpecKey(actual);
  if (!expected || !received) return false;
  if (expected === received) return true;
  const receivedParts = new Set(received.split(";"));
  return expected
    .split(";")
    .every((part) => receivedParts.has(part) || received.includes(part));
}

export function normalizeDeliveryType(value: string): DeliveryType {
  return value === "inventory" || value === "api" ? value : "text";
}
