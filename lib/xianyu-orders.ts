import type { XianyuSession } from "./xianyu-items";

const SELLER_ORIGIN = "https://seller.goofish.com";

export type PendingSellerOrder = {
  orderId: string;
  itemId: string;
  itemTitle: string;
  specText: string;
  buyerId: string;
  buyerNick: string;
  quantity: number;
  statusText: string;
  inRefund: boolean;
};

export async function fetchPendingSellerOrders(
  session: XianyuSession,
  options: { maxPages?: number; pageSize?: number } = {},
) {
  const maxPages = Math.max(1, Math.min(options.maxPages || 1, 5));
  const pageSize = Math.max(1, Math.min(options.pageSize || 50, 50));
  const result: PendingSellerOrder[] = [];
  const seen = new Set<string>();

  for (let page = 1; page <= maxPages; page += 1) {
    const raw = await session.call(
      "mtop.taobao.idle.trade.merchant.sold.get",
      {
        pageNumber: page,
        rowsPerPage: pageSize,
        orderIds: "",
        queryCode: "NOT_SHIP",
        orderSearchParam: "{}",
      },
      {
        origin: SELLER_ORIGIN,
        referer: `${SELLER_ORIGIN}/`,
        spm: "a21107h.42826273.0.0",
        valueType: "string",
        headers: { idle_site_biz_code: "COMMONPRO" },
      },
    );
    const resultModule = objectValue(raw.data?.module);
    const items = Array.isArray(resultModule.items) ? resultModule.items : [];
    for (const item of items) {
      const order = parseSellerOrder(item);
      if (!order.orderId || seen.has(order.orderId)) continue;
      seen.add(order.orderId);
      result.push(order);
    }
    if (!booleanValue(resultModule.nextPage)) break;
  }
  return result;
}

export function parseSellerOrder(value: unknown): PendingSellerOrder {
  const item = objectValue(value);
  const common = objectValue(item.commonData);
  const buyer = objectValue(item.buyerInfoVO);
  const price = objectValue(item.priceVO);
  const itemInfo = objectValue(item.itemVO);
  const sku = objectValue(item.skuVO);
  const specText = firstText(
    sku.skuText,
    sku.skuName,
    sku.properties,
    itemInfo.skuText,
    itemInfo.skuName,
    itemInfo.skuDesc,
    itemInfo.specName,
    common.skuText,
    price.skuText,
  );
  return {
    orderId: String(common.orderId || ""),
    itemId: String(common.itemId || ""),
    itemTitle: String(itemInfo.title || itemInfo.itemTitle || ""),
    specText,
    buyerId: String(buyer.buyerId || ""),
    buyerNick: String(buyer.userNick || ""),
    quantity: Math.max(1, Number(price.buyNum || 1)),
    statusText: String(common.orderStatus || ""),
    inRefund: booleanValue(common.inRefund),
  };
}

function firstText(...values: unknown[]) {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
    if (Array.isArray(value) && value.length) {
      const text = value
        .map((entry) => {
          const row = objectValue(entry);
          const name = String(row.name || row.propertyName || "").trim();
          const selected = String(
            row.value || row.valueName || row.propertyValue || "",
          ).trim();
          return [name, selected].filter(Boolean).join("=");
        })
        .filter(Boolean)
        .join(";");
      if (text) return text;
    }
  }
  return "";
}

export async function confirmVirtualShipment(
  session: XianyuSession,
  orderId: string,
) {
  try {
    await session.call(
      "mtop.taobao.idle.logistic.consign.dummy",
      {
        orderId,
        tradeText: "",
        picList: [],
        newUnconsign: true,
      },
      { spm: "a21ybx.order-detail.0.0" },
    );
    return { success: true, alreadyDelivered: false };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/ORDER_ALREADY_DELIVERY|已发货成功|已经发货/i.test(message)) {
      return { success: true, alreadyDelivered: true };
    }
    throw error;
  }
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function booleanValue(value: unknown) {
  return value === true || value === 1 || value === "1" || value === "true";
}
