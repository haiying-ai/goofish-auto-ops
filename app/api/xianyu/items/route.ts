import { env } from "cloudflare:workers";
import { desc, eq } from "drizzle-orm";
import { getDb } from "../../../../db";
import { products } from "../../../../db/schema";
import {
  normalizeListingImageUrl,
  type XianyuSession,
} from "../../../../lib/xianyu-items";
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
type ItemGroup = {
  groupId?: string | number;
  groupName?: string;
  defaultGroup?: boolean;
  groupType?: number;
  groupSortList?: Array<{
    groupSortId?: string | number;
    groupSortName?: string;
  }>;
};
type GroupParams = {
  groupId?: string | number;
  groupName?: string;
  defaultGroup?: boolean;
  groupSortId?: string | number;
  filterPanelGroupId?: string | number;
};
type ListData = {
  topItem?: ({ cardData?: Card } & Card) | null;
  cardList?: Array<{ cardData?: Card } & Card>;
  itemGroupList?: ItemGroup[];
  nextPage?: boolean;
  nextPageModel?: unknown;
  nextPageNum?: string | number;
};

function extract(card: Card) {
  const itemStatus = String(card.itemStatus ?? "");
  return {
    itemId: String(card.id || ""),
    title: String(card.title || "未命名商品"),
    priceCents: Math.round(Number(card.priceInfo?.price || 0) * 100),
    // 闲鱼个人主页官方前端定义：0=在售、1=已售出、-2=已下架。
    status:
      itemStatus === "0"
        ? "published"
        : itemStatus === "-2"
          ? "offline"
          : itemStatus === "1"
            ? "sold"
            : "unknown",
    image: normalizeListingImageUrl(card.picInfo?.picUrl),
  };
}

async function readGroup(
  session: XianyuSession,
  userId: string,
  params: GroupParams = {},
  needGroupInfo = false,
) {
  const cards: Card[] = [];
  let groups: ItemGroup[] = [];
  let page = 1;
  let nextPageModel: unknown;
  let nextPageNum: string | number | undefined;
  let complete = false;

  while (page <= 10) {
    const raw = await session.call(
      "mtop.idle.web.xyh.item.list",
      {
        needGroupInfo: needGroupInfo && page === 1,
        pageNumber: page,
        userId,
        pageSize: 20,
        ...params,
        ...(page > 1 ? { nextPageModel, nextPageNum } : {}),
      },
      { spm: "a21ybx.item.0.0" },
    );
    const data = (raw.data || {}) as ListData;
    if (page === 1) {
      groups = Array.isArray(data.itemGroupList) ? data.itemGroupList : [];
      if (data.topItem) cards.push(data.topItem.cardData || data.topItem);
    }
    for (const wrap of data.cardList || []) cards.push(wrap.cardData || wrap);
    if (!data.nextPage) {
      complete = true;
      break;
    }
    nextPageModel = data.nextPageModel;
    nextPageNum = data.nextPageNum;
    page += 1;
  }
  return { cards, groups, complete };
}

function groupRequests(groups: ItemGroup[]) {
  const requests: GroupParams[] = [];
  const keys = new Set<string>();
  const add = (params: GroupParams) => {
    const key = JSON.stringify(params);
    if (!keys.has(key)) {
      keys.add(key);
      requests.push(params);
    }
  };

  for (const group of groups.slice(0, 12)) {
    if (!group.defaultGroup && group.groupId != null) {
      add(
        group.groupType === 2
          ? { filterPanelGroupId: group.groupId }
          : {
              groupId: group.groupId,
              groupName: group.groupName,
              defaultGroup: group.defaultGroup,
            },
      );
    }
    for (const sort of (group.groupSortList || []).slice(0, 12)) {
      if (sort.groupSortId == null) continue;
      add({
        groupId: group.groupId,
        groupName: sort.groupSortName,
        defaultGroup: group.defaultGroup,
        groupSortId: sort.groupSortId,
      });
    }
  }
  return requests;
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
    const items = new Map<string, ReturnType<typeof extract>>();
    let published = 0;
    let offline = 0;
    let sold = 0;
    let unknown = 0;
    const initial = await readGroup(session, userId, {}, true);
    for (const card of initial.cards) {
      const item = extract(card);
      if (item.itemId) items.set(item.itemId, item);
    }
    let complete = initial.complete;
    for (const params of groupRequests(initial.groups)) {
      const result = await readGroup(session, userId, params);
      complete = complete && result.complete;
      for (const card of result.cards) {
        const item = extract(card);
        if (item.itemId) items.set(item.itemId, item);
      }
    }

    for (const item of items.values()) {
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
            ...(item.image
              ? { imagesJson: JSON.stringify([item.image]) }
              : {}),
            status: item.status,
            lastError: null,
            updatedAt: now,
          },
        });
      if (item.status === "published") published += 1;
      else if (item.status === "offline") offline += 1;
      else if (item.status === "sold") sold += 1;
      else unknown += 1;
    }

    let markedOffline = 0;
    if (complete) {
      const localPublished = await db
        .select({ id: products.id, xianyuItemId: products.xianyuItemId })
        .from(products)
        .where(eq(products.status, "published"));
      const now = new Date().toISOString();
      for (const local of localPublished) {
        if (!local.xianyuItemId || items.has(local.xianyuItemId)) continue;
        await db
          .update(products)
          .set({ status: "offline", lastError: null, updatedAt: now })
          .where(eq(products.id, local.id));
        markedOffline += 1;
      }
    }

    return Response.json({
      success: true,
      synced: items.size,
      published,
      offline,
      sold,
      unknown,
      markedOffline,
      reconciled: complete,
      groups: initial.groups.map((group) => ({
        id: group.groupId,
        name: group.groupName,
        type: group.groupType,
      })),
      warning: complete ? null : "某个商品分组超过 200 件，未执行缺失商品下架对账",
    });
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "同步失败" },
      { status: 502 },
    );
  }
}
