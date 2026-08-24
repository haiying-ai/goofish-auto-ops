import { env } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { getDb } from "../../../db";
import { products } from "../../../db/schema";
import {
  editListing,
  normalizeListingImages,
  parseListingImages,
  publishListing,
  takeListingOffline,
  type ListingImage,
  type ListingInput,
  type ListingProperty,
  type ListingSku,
  type ShippingMode,
} from "../../../lib/xianyu-items";
import { createXianyuSession } from "../../../lib/xianyu-session";

type RuntimeEnv = { XIANYU_COOKIE?: string };
type ProductRow = typeof products.$inferSelect;

export async function POST(request: Request) {
  try {
    const input = (await request.json()) as Record<string, unknown>;
    const listing = readListingInput(input);
    const [row] = await getDb()
      .insert(products)
      .values({
        ...listingValues(listing),
        deliveryType: input.deliveryType === "inventory" ? "inventory" : "text",
        deliveryContent: String(input.deliveryContent || "").trim(),
        status: input.publishMode === "draft" ? "draft" : "queued",
      })
      .returning();
    return Response.json({ product: row }, { status: 201 });
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "创建失败" },
      { status: 400 },
    );
  }
}

export async function PATCH(request: Request) {
  try {
    const input = (await request.json()) as Record<string, unknown>;
    const id = Number(input.id);
    if (!id) return Response.json({ error: "商品编号无效" }, { status: 400 });

    if (input.action === "publish_listing") {
      const current = await findProduct(id);
      if (!current) return Response.json({ error: "商品不存在" }, { status: 404 });
      if (
        current.status !== "draft" &&
        current.status !== "queued" &&
        current.status !== "failed"
      ) {
        return Response.json(
          { error: "只有草稿、待发布或发布失败的商品可以立即上架" },
          { status: 409 },
        );
      }
      const remote = await publishListing(
        await requiredSession(),
        productListing(current),
        String(input.categoryReferenceItemId || "").trim(),
      );
      const [row] = await getDb()
        .update(products)
        .set({
          xianyuItemId: remote.itemId,
          imagesJson: JSON.stringify(remote.images),
          status: "published",
          lastError: null,
          updatedAt: new Date().toISOString(),
        })
        .where(eq(products.id, id))
        .returning();
      return Response.json({ product: row, remoteUpdated: true });
    }

    if (input.action === "edit_listing") {
      const current = await findProduct(id);
      if (!current) return Response.json({ error: "商品不存在" }, { status: 404 });
      const listing = readListingInput(
        input,
        parseListingImages(current.imagesJson),
        productListing(current),
      );
      let images = listing.images;
      if (current.status === "published" && current.xianyuItemId) {
        const remote = await editListing(
          await requiredSession(),
          current.xianyuItemId,
          listing,
        );
        images = remote.images;
      }
      const [row] = await getDb()
        .update(products)
        .set({
          ...listingValues({ ...listing, images }),
          deliveryType:
            input.deliveryType === undefined
              ? current.deliveryType
              : input.deliveryType === "inventory"
                ? "inventory"
                : "text",
          deliveryContent:
            input.deliveryContent === undefined
              ? current.deliveryContent
              : String(input.deliveryContent || "").trim(),
          status: current.status === "failed" ? "queued" : current.status,
          lastError: null,
          updatedAt: new Date().toISOString(),
        })
        .where(eq(products.id, id))
        .returning();
      return Response.json({
        product: row,
        remoteUpdated: current.status === "published",
      });
    }

    const [row] = await getDb()
      .update(products)
      .set({
        deliveryType: input.deliveryType === "inventory" ? "inventory" : "text",
        deliveryContent: String(input.deliveryContent || "").trim(),
        updatedAt: new Date().toISOString(),
      })
      .where(eq(products.id, id))
      .returning();
    return Response.json({ product: row });
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "保存失败" },
      { status: 500 },
    );
  }
}

export async function DELETE(request: Request) {
  try {
    const input = (await request.json()) as { id?: number };
    const id = Number(input.id);
    if (!id) return Response.json({ error: "商品编号无效" }, { status: 400 });
    const current = await findProduct(id);
    if (!current) return Response.json({ error: "商品不存在" }, { status: 404 });
    if (current.status === "published" && current.xianyuItemId) {
      await takeListingOffline(await requiredSession(), current.xianyuItemId);
    }
    const [row] = await getDb()
      .update(products)
      .set({
        status: "offline",
        lastError: null,
        updatedAt: new Date().toISOString(),
      })
      .where(eq(products.id, id))
      .returning();
    return Response.json({
      product: row,
      remoteUpdated: current.status === "published",
    });
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "下架失败" },
      { status: 500 },
    );
  }
}

async function findProduct(id: number) {
  const [row] = await getDb()
    .select()
    .from(products)
    .where(eq(products.id, id))
    .limit(1);
  return row;
}

async function requiredSession() {
  const cookie = (env as unknown as RuntimeEnv).XIANYU_COOKIE;
  if (!cookie) throw new Error("尚未配置闲鱼 Cookie");
  return createXianyuSession(cookie);
}

function readListingInput(
  input: Record<string, unknown>,
  fallbackImages: ListingImage[] = [],
  fallback?: ListingInput,
): ListingInput {
  const title = String(input.title ?? fallback?.title ?? "").trim();
  const priceCents = moneyInput(input.price, fallback?.priceCents || 0);
  const originalPriceCents = optionalMoneyInput(
    input.originalPrice,
    fallback?.originalPriceCents,
  );
  const quantity = integerInput(input.quantity, fallback?.quantity || 1);
  if (!title) throw new Error("请填写商品标题");
  if (!Number.isFinite(priceCents) || priceCents < 1) {
    throw new Error("售价格式不正确");
  }
  if (originalPriceCents && originalPriceCents < priceCents) {
    throw new Error("原价不能低于售价");
  }
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > 9999) {
    throw new Error("库存必须在 1 到 9999 之间");
  }

  let images = normalizeListingImages(input.images);
  if (!images.length && typeof input.images === "string") {
    images = String(input.images)
      .split(/[\n,]+/)
      .map((url) => ({ url: url.trim() }))
      .filter((image) => image.url);
  }
  if (!images.length) images = fallbackImages;
  if (!images.length) throw new Error("请至少添加一张商品图片");

  const shippingMode = normalizeShippingMode(
    input.shippingMode ?? fallback?.shippingMode,
  );
  const shippingFeeCents = moneyInput(
    input.shippingFee,
    fallback?.shippingFeeCents || 0,
  );
  if (!Number.isFinite(shippingFeeCents) || shippingFeeCents < 0) {
    throw new Error("固定邮费不能小于 0");
  }
  const categoryMode =
    input.categoryMode === "manual" ||
    (input.categoryMode === undefined && fallback?.categoryMode === "manual")
      ? "manual"
      : "auto";
  const categoryId = String(
    input.categoryId ?? fallback?.categoryId ?? "",
  ).trim();
  if (categoryMode === "manual" && !categoryId) {
    throw new Error("手动类目模式必须填写闲鱼类目 ID");
  }

  return {
    title,
    priceCents,
    originalPriceCents,
    quantity,
    description: String(
      input.description ?? fallback?.description ?? "",
    ).trim(),
    images: images.slice(0, 9),
    shippingMode,
    shippingFeeCents,
    selfPickup: booleanInput(input.selfPickup, fallback?.selfPickup || false),
    categoryMode,
    categoryId: categoryId || undefined,
    categoryName: String(
      input.categoryName ?? fallback?.categoryName ?? "",
    ).trim(),
    skus: readSkus(input, fallback?.skus || []),
    properties: readProperties(input, fallback?.properties || []),
  };
}

function listingValues(listing: ListingInput) {
  return {
    title: listing.title,
    description: listing.description,
    priceCents: listing.priceCents,
    originalPriceCents: listing.originalPriceCents || null,
    quantity: listing.quantity,
    shippingMode: listing.shippingMode,
    shippingFeeCents: listing.shippingFeeCents,
    selfPickup: listing.selfPickup,
    categoryMode: listing.categoryMode,
    categoryId: listing.categoryId || null,
    categoryName: listing.categoryName || null,
    skuJson: JSON.stringify(listing.skus),
    propertiesJson: JSON.stringify(listing.properties),
    imagesJson: JSON.stringify(listing.images),
  };
}

export function productListing(row: ProductRow): ListingInput {
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

function readSkus(input: Record<string, unknown>, fallback: ListingSku[]) {
  if (Array.isArray(input.skus)) return normalizeSkus(input.skus);
  if (input.skuLines === undefined) return fallback;
  const lines = String(input.skuLines || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  return normalizeSkus(
    lines.map((line) => {
      const [propertyText, priceText, quantityText] = line
        .split("|")
        .map((value) => value.trim());
      const properties = propertyText
        .split(";")
        .map((part) => part.split("="))
        .map(([name, value]) => ({
          name: String(name || "").trim(),
          value: String(value || "").trim(),
        }));
      return {
        properties,
        priceCents: Math.round(Number(priceText) * 100),
        quantity: Number(quantityText),
      };
    }),
  );
}

function normalizeSkus(value: unknown[]): ListingSku[] {
  const result = value.map((entry, index) => {
    const row =
      entry && typeof entry === "object"
        ? (entry as Record<string, unknown>)
        : {};
    const properties = Array.isArray(row.properties)
      ? row.properties
          .map((property) =>
            property && typeof property === "object"
              ? {
                  name: String(
                    (property as Record<string, unknown>).name || "",
                  ).trim(),
                  value: String(
                    (property as Record<string, unknown>).value || "",
                  ).trim(),
                }
              : { name: "", value: "" },
          )
          .filter((property) => property.name && property.value)
      : [];
    const priceCents = Number(row.priceCents);
    const quantity = Math.floor(Number(row.quantity));
    if (!properties.length || properties.length > 2) {
      throw new Error(`第 ${index + 1} 行规格格式不正确`);
    }
    if (!Number.isFinite(priceCents) || priceCents < 1) {
      throw new Error(`第 ${index + 1} 行规格价格不正确`);
    }
    if (!Number.isFinite(quantity) || quantity < 0 || quantity > 9999) {
      throw new Error(`第 ${index + 1} 行规格库存必须在 0 到 9999 之间`);
    }
    return { properties, priceCents: Math.round(priceCents), quantity };
  });
  if (!result.length) return result;
  const propertyNames = result[0].properties.map((property) => property.name);
  const combinations = new Set<string>();
  let totalQuantity = 0;
  for (const [index, sku] of result.entries()) {
    const names = sku.properties.map((property) => property.name);
    if (
      names.length !== propertyNames.length ||
      names.some((name, nameIndex) => name !== propertyNames[nameIndex])
    ) {
      throw new Error(`第 ${index + 1} 行规格维度必须与第一行一致`);
    }
    const combination = sku.properties
      .map((property) => `${property.name}=${property.value}`)
      .join(";");
    if (combinations.has(combination)) {
      throw new Error(`第 ${index + 1} 行规格组合重复`);
    }
    combinations.add(combination);
    totalQuantity += sku.quantity;
  }
  if (totalQuantity < 1 || totalQuantity > 9999) {
    throw new Error("所有规格库存合计必须在 1 到 9999 之间");
  }
  return result;
}

function readProperties(
  input: Record<string, unknown>,
  fallback: ListingProperty[],
) {
  if (Array.isArray(input.properties)) {
    return normalizeProperties(input.properties);
  }
  if (input.propertyLines === undefined) return fallback;
  return normalizeProperties(
    String(input.propertyLines || "")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const [name, value] = line.split("=");
        return { name, value };
      }),
  );
}

function normalizeProperties(value: unknown[]): ListingProperty[] {
  return value
    .map((entry) =>
      entry && typeof entry === "object"
        ? {
            name: String(
              (entry as Record<string, unknown>).name || "",
            ).trim(),
            value: String(
              (entry as Record<string, unknown>).value || "",
            ).trim(),
          }
        : { name: "", value: "" },
    )
    .filter((property) => property.name && property.value);
}

function moneyInput(value: unknown, fallback: number) {
  if (value === undefined || value === "") return fallback;
  return Math.round(Number(value) * 100);
}

function optionalMoneyInput(value: unknown, fallback?: number | null) {
  if (value === undefined) return fallback || null;
  if (value === "" || value === null) return null;
  const result = Math.round(Number(value) * 100);
  if (!Number.isFinite(result) || result < 0) {
    throw new Error("原价格式不正确");
  }
  return result || null;
}

function integerInput(value: unknown, fallback: number) {
  if (value === undefined || value === "") return fallback;
  return Math.floor(Number(value));
}

function booleanInput(value: unknown, fallback: boolean) {
  if (value === undefined) return fallback;
  return (
    value === true || value === "true" || value === "on" || value === "1"
  );
}

function normalizeShippingMode(value: unknown): ShippingMode {
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
