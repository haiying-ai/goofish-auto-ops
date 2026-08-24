import { eq } from "drizzle-orm";
import { getDb } from "../db";
import { settings } from "../db/schema";
import { createXianyuSession } from "./xianyu-session";

const WRITE_INTERVAL_MS = 60_000;
const WRITE_SETTING_KEY = "xianyu_last_write_at";
const UPLOAD_URL =
  "https://stream-upload.goofish.com/api/upload.api?floderId=0&appkey=fleamarket&_input_charset=utf-8";
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/151.0 Safari/537.36";

export type XianyuSession = Awaited<ReturnType<typeof createXianyuSession>>;

export type ListingImage = {
  url: string;
  width?: number;
  height?: number;
};

type UploadedImage = Required<ListingImage>;

export type ListingSku = {
  properties: Array<{ name: string; value: string }>;
  priceCents: number;
  quantity: number;
};

export type ListingProperty = { name: string; value: string };

export type ShippingMode = "free" | "distance" | "fixed" | "none";

export type ListingInput = {
  title: string;
  description: string;
  priceCents: number;
  originalPriceCents?: number | null;
  quantity: number;
  shippingMode: ShippingMode;
  shippingFeeCents: number;
  selfPickup: boolean;
  categoryMode: "auto" | "manual";
  categoryId?: string;
  categoryName?: string;
  skus: ListingSku[];
  properties: ListingProperty[];
  images: ListingImage[];
};

type MtopData = Record<string, unknown>;

export function normalizeListingImageUrl(value: unknown) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  try {
    const url = new URL(raw.startsWith("//") ? `https:${raw}` : raw);
    if (url.protocol !== "http:" && url.protocol !== "https:") return "";
    url.protocol = "https:";
    return url.toString();
  } catch {
    return "";
  }
}

export function normalizeListingImages(value: unknown): ListingImage[] {
  if (!Array.isArray(value)) return [];
  const result: ListingImage[] = [];
  for (const entry of value) {
    if (typeof entry === "string" && entry.trim()) {
      const url = normalizeListingImageUrl(entry);
      if (url) result.push({ url });
      continue;
    }
    if (!entry || typeof entry !== "object") continue;
    const image = entry as Record<string, unknown>;
    const url = normalizeListingImageUrl(image.url);
    if (!url) continue;
    const width = Number(image.width || image.widthSize || 0);
    const height = Number(image.height || image.heightSize || 0);
    result.push({
      url,
      ...(width > 0 ? { width } : {}),
      ...(height > 0 ? { height } : {}),
    });
  }
  return result.slice(0, 9);
}

export function parseListingImages(value?: string | null): ListingImage[] {
  if (!value) return [];
  try {
    return normalizeListingImages(JSON.parse(value));
  } catch {
    return [];
  }
}

export async function uploadListingImage(
  session: XianyuSession,
  file: Blob,
  filename = "listing.png",
): Promise<UploadedImage> {
  const form = new FormData();
  form.append("file", file, filename);
  const response = await fetch(UPLOAD_URL, {
    method: "POST",
    headers: {
      accept: "*/*",
      origin: "https://www.goofish.com",
      referer: "https://www.goofish.com/",
      cookie: session.cookieHeader(),
      "user-agent": USER_AGENT,
    },
    body: form,
  });
  if (!response.ok) throw new Error(`闲鱼图片上传 HTTP ${response.status}`);
  const raw = (await response.json()) as {
    success?: boolean;
    message?: string;
    object?: {
      url?: string;
      pix?: string;
      width?: number | string;
      height?: number | string;
    };
  };
  const object = raw.object || {};
  const [pixWidth, pixHeight] = String(object.pix || "0x0")
    .split("x")
    .map(Number);
  const url = normalizeListingImageUrl(object.url);
  const width = Number(object.width || pixWidth || 0);
  const height = Number(object.height || pixHeight || 0);
  if (!url || width < 1 || height < 1) {
    throw new Error(raw.message || "闲鱼图片上传未返回有效地址或尺寸");
  }
  return { url, width, height };
}

export async function publishListing(
  session: XianyuSession,
  input: ListingInput,
  categoryReferenceItemId = "",
) {
  const images = await prepareImages(session, input.images);
  if (!images.length) throw new Error("至少需要一张有效商品图片");
  const [category, location] = await Promise.all([
    input.categoryMode === "manual" && input.categoryId
      ? categoryReferenceItemId
        ? categoryFromReference(
            session,
            categoryReferenceItemId,
            input.categoryId,
          )
        : Promise.resolve(manualCategory(input))
      : recommendCategory(session, input.title, images, input.skus.length > 0),
    getDefaultLocation(session),
  ]);
  await reserveWriteSlot();
  const raw = await session.call(
    "mtop.idle.pc.idleitem.publish",
    buildListingPayload(input, images, category, location),
    { spm: "a21ybx.publish.0.0" },
  );
  const itemId = String(raw.data?.itemId || "");
  if (!itemId) throw new Error("闲鱼发布成功响应中缺少商品编号");
  return { itemId, images, raw };
}

async function categoryFromReference(
  session: XianyuSession,
  itemId: string,
  expectedCategoryId: string,
) {
  const raw = await session.call(
    "mtop.idle.pc.idleitem.editDetail",
    { itemId },
    { spm: "a21ybx.publish.0.0" },
  );
  const category = objectValue(raw.data?.itemCatDTO);
  const categoryId = String(category.catId || "");
  if (!categoryId) throw new Error("参考商品未返回有效闲鱼类目");
  if (expectedCategoryId && categoryId !== expectedCategoryId) {
    throw new Error("参考商品类目与草稿指定类目不一致");
  }
  return category;
}

export async function editListing(
  session: XianyuSession,
  itemId: string,
  input: ListingInput,
) {
  const detailsRaw = await session.call(
    "mtop.idle.pc.idleitem.editDetail",
    { itemId },
    { spm: "a21ybx.publish.0.0" },
  );
  const details = (detailsRaw.data || {}) as MtopData;
  const images = await prepareImages(session, input.images);
  if (!images.length) throw new Error("至少需要一张有效商品图片");
  let category =
    input.categoryMode === "manual" && input.categoryId
      ? manualCategory(input, objectValue(details.itemCatDTO))
      : objectValue(details.itemCatDTO);
  if (!String(category.catId || "")) {
    category = await recommendCategory(
      session,
      input.title,
      images,
      input.skus.length > 0,
    );
  }
  let location = objectValue(details.itemAddrDTO);
  if (!Object.keys(location).length)
    location = await getDefaultLocation(session);
  const payload = buildListingPayload(
    input,
    images,
    category,
    location,
    details,
  );
  await reserveWriteSlot();
  const raw = await session.call(
    "mtop.idle.pc.idleitem.edit",
    { ...payload, itemId },
    { spm: "a21ybx.publish.0.0" },
  );
  const returnedId = String(raw.data?.itemId || itemId);
  return { itemId: returnedId, images, raw };
}

export async function takeListingOffline(
  session: XianyuSession,
  itemId: string,
) {
  await reserveWriteSlot();
  const raw = await session.call(
    "mtop.taobao.idle.item.downshelf",
    { itemId },
    { version: "2.0", spm: "a21ybx.item.0.0" },
  );
  return { itemId, raw };
}

export async function getListingDetails(
  session: XianyuSession,
  itemId: string,
) {
  const [detail, editDetail] = await Promise.all([
    session.call(
      "mtop.taobao.idle.pc.detail",
      { itemId },
      { spm: "a21ybx.item.0.0" },
    ),
    session
      .call(
        "mtop.idle.pc.idleitem.editDetail",
        { itemId },
        { spm: "a21ybx.publish.0.0" },
      )
      .catch(() => null),
  ]);
  const track = objectValue(detail.data?.trackParams);
  const editable = objectValue(editDetail?.data);
  const text = objectValue(editable.itemTextDTO);
  const price = objectValue(editable.itemPriceDTO);
  const postFee = objectValue(editable.itemPostFeeDTO);
  const imageRows = Array.isArray(editable.imageInfoDOList)
    ? editable.imageInfoDOList
    : [];
  return {
    itemId: String(track.id || itemId),
    title: String(text.title || track.title || ""),
    description: String(text.desc || ""),
    priceCents: Number(
      price.priceInCent || track.soldPrice || track.price || 0,
    ),
    originalPriceCents: Number(price.origPriceInCent || 0) || null,
    quantity: Number(editable.quantity || 1),
    shippingMode: shippingModeFromPayload(postFee),
    shippingFeeCents: Number(postFee.postPriceInCent || 0),
    selfPickup: Boolean(
      postFee.onlyTakeSelf === true || postFee.onlyTakeSelf === "true",
    ),
    categoryMode: "manual" as const,
    categoryId: String(objectValue(editable.itemCatDTO).catId || ""),
    categoryName: String(objectValue(editable.itemCatDTO).catName || ""),
    skus: normalizeRemoteSkus(editable.itemSkuList),
    properties: normalizeRemoteProperties(editable.itemProperties),
    itemStatus: String(editable.itemStatus ?? track.itemStatus ?? ""),
    images: normalizeListingImages(imageRows),
  };
}

async function prepareImages(
  session: XianyuSession,
  images: ListingImage[],
): Promise<UploadedImage[]> {
  const result: UploadedImage[] = [];
  for (const image of images.slice(0, 9)) {
    if (
      image.width &&
      image.height &&
      /(?:alicdn|goofish)\.com$/i.test(new URL(image.url).hostname)
    ) {
      result.push({
        url: image.url,
        width: Math.round(image.width),
        height: Math.round(image.height),
      });
      continue;
    }
    const response = await fetch(image.url, {
      headers: { accept: "image/*", "user-agent": USER_AGENT },
    });
    if (!response.ok)
      throw new Error(`读取商品图片失败：HTTP ${response.status}`);
    const contentType = response.headers.get("content-type") || "image/png";
    const file = new Blob([await response.arrayBuffer()], {
      type: contentType,
    });
    result.push(
      await uploadListingImage(
        session,
        file,
        filenameFromUrl(image.url, contentType),
      ),
    );
  }
  return result;
}

async function recommendCategory(
  session: XianyuSession,
  title: string,
  images: UploadedImage[],
  multiSku: boolean,
) {
  const raw = await session.call(
    "mtop.taobao.idle.kgraph.property.recommend",
    {
      title,
      lockCpv: false,
      multiSKU: multiSku,
      publishScene: "mainPublish",
      scene: "newPublishChoice",
      description: title,
      imageInfos: imageInfoList(images),
      uniqueCode: uniqueCode(),
    },
    { version: "2.0", spm: "a21ybx.publish.0.0" },
  );
  const category = objectValue(raw.data?.categoryPredictResult);
  if (!String(category.catId || "")) throw new Error("闲鱼未能识别商品类目");
  return category;
}

async function getDefaultLocation(session: XianyuSession) {
  const raw = await session.call(
    "mtop.taobao.idle.local.poi.get",
    { longitude: 121.4737, latitude: 31.2304 },
    { spm: "a21ybx.publish.0.0" },
  );
  const data = raw.data || {};
  const common = Array.isArray(data.commonAddresses)
    ? data.commonAddresses
    : [];
  const selected = objectValue(data.selectedPoi || common[0]);
  if (!Object.keys(selected).length) return {};
  return {
    area: String(selected.area || ""),
    city: String(selected.city || ""),
    divisionId: String(selected.divisionId || ""),
    gps: `${selected.latitude || ""},${selected.longitude || ""}`,
    poiId: String(selected.poiId || ""),
    poiName: String(selected.poi || selected.poiName || ""),
    prov: String(selected.prov || ""),
  };
}

function buildListingPayload(
  input: ListingInput,
  images: UploadedImage[],
  category: MtopData,
  location: MtopData,
  existing: MtopData = {},
) {
  const existingPrice = objectValue(existing.itemPriceDTO);
  const skuRows = input.skus.length
    ? input.skus.map((sku) => ({
        priceInCent: String(sku.priceCents),
        quantity: String(sku.quantity),
        propertyList: sku.properties.map((property) => ({
          propertyText: property.name,
          valueText: property.value,
        })),
      }))
    : Array.isArray(existing.itemSkuList)
      ? existing.itemSkuList
      : undefined;
  const itemProperties = input.properties.length
    ? input.properties.map((property) => ({
        propertyName: property.name,
        propertyValues: [{ propertyValue: property.value }],
      }))
    : Array.isArray(existing.itemProperties)
      ? existing.itemProperties
      : undefined;
  return {
    freebies: false,
    itemTypeStr: String(existing.itemTypeStr || "b"),
    quantity: String(
      input.skus.length
        ? input.skus.reduce((total, sku) => total + sku.quantity, 0)
        : input.quantity,
    ),
    simpleItem: String(existing.simpleItem || "true"),
    imageInfoDOList: imageInfoList(images),
    itemTextDTO: {
      ...objectValue(existing.itemTextDTO),
      desc: input.description,
      title: input.title,
      titleDescSeparate: true,
    },
    itemLabelExtList: Array.isArray(existing.itemLabelExtList)
      ? existing.itemLabelExtList
      : [],
    itemPriceDTO: {
      ...existingPrice,
      priceInCent: String(input.priceCents),
      ...(input.originalPriceCents
        ? { origPriceInCent: String(input.originalPriceCents) }
        : { origPriceInCent: undefined }),
    },
    userRightsProtocols: Array.isArray(existing.userRightsProtocols)
      ? existing.userRightsProtocols
      : [{ enable: false, serviceCode: "SKILL_PLAY_NO_MIND" }],
    itemPostFeeDTO: shippingPayload(input),
    itemAddrDTO: location,
    defaultPrice: false,
    itemCatDTO: categoryPayload(category),
    ...(skuRows ? { itemSkuList: skuRows } : {}),
    ...(itemProperties ? { itemProperties } : {}),
    ...(Array.isArray(existing.propertyImageList)
      ? { propertyImageList: existing.propertyImageList }
      : {}),
    uniqueCode: uniqueCode(),
    sourceId: "pcMainPublish",
    bizcode: "pcMainPublish",
    publishScene: "pcMainPublish",
  };
}

function manualCategory(input: ListingInput, existing: MtopData = {}) {
  const sameCategory = String(existing.catId || "") === input.categoryId;
  return {
    ...(sameCategory ? existing : {}),
    catId: String(input.categoryId || ""),
    catName: String(input.categoryName || existing.catName || ""),
    channelCatId: String(sameCategory ? existing.channelCatId || "" : ""),
    tbCatId: String(sameCategory ? existing.tbCatId || "" : ""),
    ...(sameCategory && existing.leafId
      ? { leafId: String(existing.leafId) }
      : {}),
  };
}

function categoryPayload(category: MtopData) {
  return {
    catId: String(category.catId || ""),
    ...(category.catName ? { catName: String(category.catName) } : {}),
    ...(category.channelCatId
      ? { channelCatId: String(category.channelCatId) }
      : {}),
    ...(category.leafId ? { leafId: String(category.leafId) } : {}),
    ...(category.tbCatId ? { tbCatId: String(category.tbCatId) } : {}),
  };
}

function shippingPayload(input: ListingInput) {
  const base = { onlyTakeSelf: input.selfPickup };
  if (input.shippingMode === "free") {
    return { ...base, canFreeShipping: true, supportFreight: true };
  }
  if (input.shippingMode === "distance") {
    return {
      ...base,
      canFreeShipping: false,
      supportFreight: true,
      templateId: "-100",
    };
  }
  if (input.shippingMode === "fixed") {
    return {
      ...base,
      canFreeShipping: false,
      supportFreight: true,
      postPriceInCent: String(input.shippingFeeCents),
      templateId: "0",
    };
  }
  return {
    ...base,
    canFreeShipping: false,
    supportFreight: false,
    templateId: "0",
  };
}

function shippingModeFromPayload(postFee: MtopData): ShippingMode {
  const canFree = postFee.canFreeShipping === true || postFee.canFreeShipping === "true";
  const support = postFee.supportFreight === true || postFee.supportFreight === "true";
  if (canFree && support) return "free";
  if (support && String(postFee.templateId || "") === "-100") return "distance";
  if (support && Number(postFee.postPriceInCent || 0) >= 0) return "fixed";
  return "none";
}

function normalizeRemoteSkus(value: unknown): ListingSku[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((row) => {
      const sku = objectValue(row);
      const properties = Array.isArray(sku.propertyList)
        ? sku.propertyList
            .map((entry) => {
              const property = objectValue(entry);
              return {
                name: String(property.propertyText || "").trim(),
                value: String(property.valueText || "").trim(),
              };
            })
            .filter((property) => property.name && property.value)
        : [];
      return {
        properties,
        priceCents: Number(sku.priceInCent || 0),
        quantity: Number(sku.quantity || 0),
      };
    })
    .filter((sku) => sku.properties.length && sku.priceCents >= 0);
}

function normalizeRemoteProperties(value: unknown): ListingProperty[] {
  if (!Array.isArray(value)) return [];
  const result: ListingProperty[] = [];
  for (const row of value) {
    const property = objectValue(row);
    const name = String(property.propertyName || "").trim();
    const values = Array.isArray(property.propertyValues)
      ? property.propertyValues
      : [];
    for (const entry of values) {
      const valueText = String(objectValue(entry).propertyValue || "").trim();
      if (name && valueText) result.push({ name, value: valueText });
    }
  }
  return result;
}

function imageInfoList(images: UploadedImage[]) {
  return images.map((image, index) => ({
    extraInfo: { isH: "false", isT: "false", raw: "false" },
    isQrCode: false,
    url: image.url,
    heightSize: image.height,
    widthSize: image.width,
    major: index === 0,
    type: 0,
    status: "done",
  }));
}

async function reserveWriteSlot() {
  const db = getDb();
  const rows = await db
    .select({ value: settings.value })
    .from(settings)
    .where(eq(settings.key, WRITE_SETTING_KEY))
    .limit(1);
  const last = Date.parse(rows[0]?.value || "");
  const remaining = Number.isFinite(last)
    ? last + WRITE_INTERVAL_MS - Date.now()
    : 0;
  if (remaining > 0) {
    throw new Error(
      `为降低闲鱼风控，请 ${Math.ceil(remaining / 1000)} 秒后再操作`,
    );
  }
  const now = new Date().toISOString();
  await db
    .insert(settings)
    .values({ key: WRITE_SETTING_KEY, value: now, updatedAt: now })
    .onConflictDoUpdate({
      target: settings.key,
      set: { value: now, updatedAt: now },
    });
}

function objectValue(value: unknown): MtopData {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as MtopData)
    : {};
}

function filenameFromUrl(url: string, contentType: string) {
  try {
    const path = new URL(url).pathname;
    const name = decodeURIComponent(path.split("/").pop() || "");
    if (name && /\.(?:png|jpe?g|webp|heic)$/i.test(name)) return name;
  } catch {
    // Fall through to a safe generated name.
  }
  const extension = contentType.includes("jpeg") ? "jpg" : "png";
  return `listing-${Date.now()}.${extension}`;
}

function uniqueCode() {
  return `${Date.now()}${Math.floor(Math.random() * 1000)}`;
}
