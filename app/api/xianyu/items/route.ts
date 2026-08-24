import { env } from "cloudflare:workers";
import { desc, eq } from "drizzle-orm";
import { getDb } from "../../../../db";
import { products } from "../../../../db/schema";
import { createXianyuSession } from "../../../../lib/xianyu-session";

export const dynamic = "force-dynamic";

type RuntimeEnv = { XIANYU_COOKIE?: string };
type Card = {
  id?: string | number;
  title?: string;
  itemStatus?: string | number;
  priceInfo?: { price?: string | number };
  picInfo?: { picUrl?: string };
};

function extract(card: Card) {
  const itemStatus = String(card.itemStatus ?? "");
  return {
    itemId: String(card.id || ""),
    title: String(card.title || "未命名商品"),
    priceCents: Math.round(Number(card.priceInfo?.price || 0) * 100),
    // xyh.item.list 是“我的商品”接口，它的 itemStatus 语义不同于
    // 通用商品详情/收藏接口：该接口返回 "1" 时表示商品已经下架。
    status: itemStatus === "1" ? "offline" : "published",
    image: String(card.picInfo?.picUrl || ""),
  };
}

export async function GET() {
  try {
    return Response.json({
      items: await getDb()
        .select()
        .from(products)
        .where(eq(products.status, "published"))
        .orderBy(desc(products.updatedAt)),
    });
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "读取失败" },
      { status: 500 },
    );
  }
}

export async function POST() {
  const cookie = (env as unknown as RuntimeEnv).XIANYU_COOKIE;
  if (!cookie) {
    return Response.json({ error: "尚未配置闲鱼 Cookie" }, { status: 503 });
  }

  try {
    const session = await createXianyuSession(cookie);
    const userId = session.cookieValue("unb");
    if (!userId) throw new Error("Cookie 缺少账号字段 unb");

    const db = getDb();
    const seen = new Set<string>();
    let page = 1;
    let synced = 0;
    let published = 0;
    let offline = 0;
    let complete = false;

    while (page <= 10) {
      const raw = await session.call(
        "mtop.idle.web.xyh.item.list",
        { needGroupInfo: true, pageNumber: page, userId, pageSize: 20 },
        { spm: "a21ybx.item.0.0" },
      );
      const data = raw.data || {};
      const cards: Card[] = [];
      const top = data.topItem as ({ cardData?: Card } & Card) | undefined;
      if (page === 1 && top) cards.push(top.cardData || top);
      for (const wrap of (data.cardList as Array<{ cardData?: Card } & Card>) || []) {
        cards.push(wrap.cardData || wrap);
      }

      for (const card of cards) {
        const item = extract(card);
        if (!item.itemId || seen.has(item.itemId)) continue;
        seen.add(item.itemId);
        const now = new Date().toISOString();
        await db
          .insert(products)
          .values({
            title: item.title,
            priceCents: item.priceCents,
            imagesJson: JSON.stringify(item.image ? [item.image] : []),
            status: item.status,
            xianyuItemId: item.itemId,
            updatedAt: now,
          })
          .onConflictDoUpdate({
            target: products.xianyuItemId,
            set: {
              title: item.title,
              priceCents: item.priceCents,
              imagesJson: JSON.stringify(item.image ? [item.image] : []),
              status: item.status,
              lastError: null,
              updatedAt: now,
            },
          });
        synced += 1;
        if (item.status === "published") published += 1;
        else offline += 1;
      }

      if (!data.nextPage) {
        complete = true;
        break;
      }
      page += 1;
    }

    let markedOffline = 0;
    if (complete) {
      const localPublished = await db
        .select({ id: products.id, xianyuItemId: products.xianyuItemId })
        .from(products)
        .where(eq(products.status, "published"));
      const now = new Date().toISOString();
      for (const local of localPublished) {
        if (!local.xianyuItemId || seen.has(local.xianyuItemId)) continue;
        await db
          .update(products)
          .set({ status: "offline", lastError: null, updatedAt: now })
          .where(eq(products.id, local.id));
        markedOffline += 1;
      }
    }

    return Response.json({
      success: true,
      synced,
      published,
      offline,
      markedOffline,
      reconciled: complete,
      warning: complete ? null : "商品超过 200 件，未执行缺失商品下架对账",
    });
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "同步失败" },
      { status: 502 },
    );
  }
}
