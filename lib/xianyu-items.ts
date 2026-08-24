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

type ListingInput = {
  title: string;
  description: string;
  priceCents: number;
  images: ListingImage[];
};

type MtopData = Record<string, unknown>;

export function normalizeListingImages(value: unknown): ListingImage[] {
  if (!Array.isArray(value)) return [];
  const result: ListingImage[] = [];
  for (const entry of value) {
    if (typeof entry === "string" && entry.trim()) {
      result.push({ url: entry.trim() });
      continue;
    }
    if (!entry || typeof entry !== "object") continue;
    const image = entry as Record<string, unknown>;
    const url = String(image.url || "").trim();
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
  const url = String(object.url || "");
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
) {
  const images = await prepareImages(session, input.images);
  if (!images.length) throw new Error("至少需要一张有效商品图片");
  const [category, location] = await Promise.all([
    recommendCategory(session, input.title, images),
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
  let category = objectValue(details.itemCatDTO);
  if (!String(category.catId || "")) {
    category = await recommendCategory(session, input.title, images);
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
    "com.taobao.idle.item.delete",
    { itemId },
    { version: "1.1", spm: "a21ybx.item.0.0" },
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
) {
  const raw = await session.call(
    "mtop.taobao.idle.kgraph.property.recommend",
    {
      title,
      lockCpv: false,
      multiSKU: false,
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
  return {
    freebies: false,
    itemTypeStr: String(existing.itemTypeStr || "b"),
    quantity: String(existing.quantity || "1"),
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
    },
    userRightsProtocols: Array.isArray(existing.userRightsProtocols)
      ? existing.userRightsProtocols
      : [{ enable: false, serviceCode: "SKILL_PLAY_NO_MIND" }],
    itemPostFeeDTO: Object.keys(objectValue(existing.itemPostFeeDTO)).length
      ? objectValue(existing.itemPostFeeDTO)
      : {
          canFreeShipping: false,
          supportFreight: false,
          onlyTakeSelf: false,
          templateId: "0",
        },
    itemAddrDTO: location,
    defaultPrice: false,
    itemCatDTO: {
      catId: String(category.catId || ""),
      catName: String(category.catName || ""),
      channelCatId: String(category.channelCatId || ""),
      ...(category.leafId ? { leafId: String(category.leafId) } : {}),
      tbCatId: String(category.tbCatId || ""),
    },
    ...(Array.isArray(existing.itemSkuList)
      ? { itemSkuList: existing.itemSkuList }
      : {}),
    ...(Array.isArray(existing.propertyImageList)
      ? { propertyImageList: existing.propertyImageList }
      : {}),
    onlyTakeSelf: Boolean(existing.onlyTakeSelf ?? true),
    uniqueCode: uniqueCode(),
    sourceId: "pcMainPublish",
    bizcode: "pcMainPublish",
    publishScene: "pcMainPublish",
  };
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
