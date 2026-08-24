import { env } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { getDb } from "../../../db";
import { products } from "../../../db/schema";
import {
  editListing,
  normalizeListingImages,
  parseListingImages,
  takeListingOffline,
  type ListingImage,
} from "../../../lib/xianyu-items";
import { createXianyuSession } from "../../../lib/xianyu-session";

type RuntimeEnv = { XIANYU_COOKIE?: string };

export async function POST(request: Request) {
  try {
    const input = (await request.json()) as Record<string, unknown>;
    const listing = readListingInput(input);
    const [row] = await getDb()
      .insert(products)
      .values({
        title: listing.title,
        priceCents: listing.priceCents,
        description: listing.description,
        imagesJson: JSON.stringify(listing.images),
        deliveryType: input.deliveryType === "inventory" ? "inventory" : "text",
        deliveryContent: String(input.deliveryContent || "").trim(),
        status: "queued",
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

    if (input.action === "edit_listing") {
      const [current] = await getDb()
        .select()
        .from(products)
        .where(eq(products.id, id))
        .limit(1);
      if (!current)
        return Response.json({ error: "商品不存在" }, { status: 404 });
      const listing = readListingInput(
        input,
        parseListingImages(current.imagesJson),
      );
      let images = listing.images;
      if (current.status === "published" && current.xianyuItemId) {
        const cookie = (env as unknown as RuntimeEnv).XIANYU_COOKIE;
        if (!cookie) throw new Error("尚未配置闲鱼 Cookie");
        const session = await createXianyuSession(cookie);
        const remote = await editListing(
          session,
          current.xianyuItemId,
          listing,
        );
        images = remote.images;
      }
      const now = new Date().toISOString();
      const [row] = await getDb()
        .update(products)
        .set({
          title: listing.title,
          description: listing.description,
          priceCents: listing.priceCents,
          imagesJson: JSON.stringify(images),
          status: current.status === "failed" ? "queued" : current.status,
          lastError: null,
          updatedAt: now,
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
    const [current] = await getDb()
      .select()
      .from(products)
      .where(eq(products.id, id))
      .limit(1);
    if (!current)
      return Response.json({ error: "商品不存在" }, { status: 404 });
    if (current.status === "published" && current.xianyuItemId) {
      const cookie = (env as unknown as RuntimeEnv).XIANYU_COOKIE;
      if (!cookie) throw new Error("尚未配置闲鱼 Cookie");
      const session = await createXianyuSession(cookie);
      await takeListingOffline(session, current.xianyuItemId);
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

function readListingInput(
  input: Record<string, unknown>,
  fallbackImages: ListingImage[] = [],
) {
  const title = String(input.title || "").trim();
  const priceCents = Math.round(Number(input.price) * 100);
  if (!title) throw new Error("请填写商品标题");
  if (!Number.isFinite(priceCents) || priceCents < 1) {
    throw new Error("售价格式不正确");
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
  return {
    title,
    priceCents,
    description: String(input.description || "").trim(),
    images: images.slice(0, 9),
  };
}
