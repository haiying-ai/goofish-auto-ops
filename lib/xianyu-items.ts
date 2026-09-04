import { eq } from "drizzle-orm";
import { getDb } from "../db";
import { settings } from "../db/schema";
import {
  createXianyuSession,
  recordXianyuUploadAuthState,
  XianyuAuthenticationError,
} from "./xianyu-session";

const WRITE_INTERVAL_MS = 60_000;
const WRITE_SETTING_KEY = "xianyu_last_write_at";
const UPLOAD_ENDPOINT = "https://stream-upload.goofish.com/api/upload.api";
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/151.0 Safari/537.36";
const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;
const UPLOAD_PROFILES = [
  {
    appKey: "xy_chat",
    origin: "https://www.goofish.com",
    referer: "https://www.goofish.com/",
  },
  {
    appKey: "fleamarket",
    origin: "https://seller.goofish.com",
    referer: "https://seller.goofish.com/?site=COMMONPRO",
  },
] as const;

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
  recoveryAttempted = false,
): Promise<UploadedImage> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (!bytes.length || bytes.length > MAX_UPLOAD_BYTES) {
    throw new Error("图片大小必须在 5MB 以内");
  }
  const imageType = detectImageType(bytes);
  if (!imageType) {
    throw new Error("图片内容不是有效的 PNG、JPEG、WebP 或 HEIC");
  }
  const safeFilename = safeUploadFilename(filename, imageType.extension);
  const failures: string[] = [];
  let authenticationFailures = 0;
  const cookieNames = new Set(
    session
      .cookieHeader()
      .split(";")
      .map((part) => {
        const index = part.indexOf("=");
        return index > 0 ? part.slice(0, index).trim() : "";
      })
      .filter(Boolean),
  );
  const missingUploadCookies = [
    "unb",
    "_m_h5_tk",
    "_m_h5_tk_enc",
    "cookie2",
    "sgcookie",
    "cna",
    "t",
    "_tb_token_",
  ].filter((name) => !cookieNames.has(name));

  for (const profile of UPLOAD_PROFILES) {
    const url = new URL(UPLOAD_ENDPOINT);
    url.searchParams.set("floderId", "0");
    url.searchParams.set("appkey", profile.appKey);
    url.searchParams.set("_input_charset", "utf-8");
    const multipart = createMultipartBody(
      bytes,
      safeFilename,
      imageType.mimeType,
    );
    const response = await fetch(url, {
      method: "POST",
      headers: {
        accept: "application/json, text/javascript, */*; q=0.01",
        origin: profile.origin,
        referer: profile.referer,
        cookie: session.cookieHeader(),
        "content-type": multipart.contentType,
        "user-agent": USER_AGENT,
        "x-requested-with": "XMLHttpRequest",
      },
      body: multipart.body,
    });
    await session.absorbResponseCookies(response.headers);
    const responseText = await response.text();
    const raw = parseUploadResponse(responseText);
    const object = raw?.object || raw?.data || {};
    const [pixWidth, pixHeight] = String(object.pix || "0x0")
      .toLowerCase()
      .split("x")
      .map(Number);
    const uploadedUrl = normalizeListingImageUrl(object.url || raw?.url);
    const width = Number(object.width || pixWidth || 0);
    const height = Number(object.height || pixHeight || 0);
    if (
      response.ok &&
      raw?.success !== false &&
      uploadedUrl &&
      width > 0 &&
      height > 0
    ) {
      await recordXianyuUploadAuthState(true).catch(() => undefined);
      return { url: uploadedUrl, width, height };
    }

    if (
      uploadResponseRequiresAuthentication(
        responseText,
        response.url,
        response.redirected,
      )
    ) {
      authenticationFailures += 1;
    }

    const upstreamMessage = uploadFailureMessage(
      response.status,
      raw?.message,
      responseText,
      response.url,
      response.redirected,
    );
    failures.push(`${profile.appKey}: ${upstreamMessage}`);
  }

  const cookieHint = missingUploadCookies.length
    ? `；当前 Cookie 缺少 ${missingUploadCookies.join("、")}`
    : "";
  const message = `闲鱼图片上传失败（${failures.join("；")}）${cookieHint}`;
  if (authenticationFailures === UPLOAD_PROFILES.length) {
    if (!recoveryAttempted) {
      try {
        await session.scheduledKeepAlive();
        return uploadListingImage(
          session,
          new Blob([bytes], { type: imageType.mimeType }),
          safeFilename,
          true,
        );
      } catch {
        // The final AUTH_REQUIRED below is clearer and preserves the original
        // upload diagnostics without exposing any session material.
      }
    }
    await recordXianyuUploadAuthState(false, "AUTH_REQUIRED").catch(
      () => undefined,
    );
    throw new XianyuAuthenticationError(
      `${message}。系统已自动续期并重试，长期登录仍不可用；请仅在此时到 Auto Ops「系统设置」重新登录一次，无需转换图片格式。`,
    );
  }
  throw new Error(message);
}

type UploadResponse = {
  success?: boolean;
  message?: string;
  url?: string;
  object?: {
    url?: string;
    pix?: string;
    width?: number | string;
    height?: number | string;
  };
  data?: {
    url?: string;
    pix?: string;
    width?: number | string;
    height?: number | string;
  };
};

function parseUploadResponse(value: string): UploadResponse | null {
  try {
    const parsed = JSON.parse(value) as UploadResponse;
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

function uploadFailureMessage(
  status: number,
  message?: string,
  body = "",
  responseUrl = "",
  redirected = false,
) {
  const normalized = String(message || "").trim();
  if (/INVALID_ARGUMENT|ILLEGAL_ARGUMENT/i.test(`${normalized} ${body}`)) {
    return `HTTP ${status} 闲鱼拒绝当前上传场景参数`;
  }
  if (normalized) return `HTTP ${status} ${normalized.slice(0, 160)}`;
  if (/<!doctype html|<html/i.test(body)) {
    const title = body.match(/<title[^>]*>([^<]{1,120})<\/title>/i)?.[1]
      ?.replace(/\s+/g, " ")
      .trim();
    const destination = safeResponseDestination(responseUrl);
    const details = [
      title ? `页面“${title}”` : "HTML 页面",
      redirected && destination ? `跳转至 ${destination}` : "",
    ].filter(Boolean);
    return `HTTP ${status} 登录状态无效或被风控拦截（${details.join("，")}）`;
  }
  return `HTTP ${status} 未返回有效图片地址`;
}

function uploadResponseRequiresAuthentication(
  body: string,
  responseUrl: string,
  redirected: boolean,
) {
  const destination = safeResponseDestination(responseUrl);
  return Boolean(
    (redirected && /(?:^|\/)login(?:\.html)?(?:$|[/?])/i.test(destination)) ||
      /passport\.goofish\.com|闲鱼[^<]{0,30}登录|使用淘宝登录/i.test(body),
  );
}

function safeResponseDestination(value: string) {
  try {
    const url = new URL(value);
    return `${url.hostname}${url.pathname}`.slice(0, 160);
  } catch {
    return "";
  }
}

function safeUploadFilename(_filename: string, extension: string) {
  return `publish_${crypto.randomUUID().replaceAll("-", "").slice(0, 16)}.${extension}`;
}

function createMultipartBody(
  bytes: Uint8Array,
  filename: string,
  mimeType: string,
) {
  const boundary = `----AutoOps${crypto.randomUUID().replaceAll("-", "")}`;
  const encoder = new TextEncoder();
  const prefix = encoder.encode(
    `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="file"; filename="${filename}"\r\n` +
      `Content-Type: ${mimeType}\r\n\r\n`,
  );
  const suffix = encoder.encode(`\r\n--${boundary}--\r\n`);
  const body = new Uint8Array(prefix.length + bytes.length + suffix.length);
  body.set(prefix, 0);
  body.set(bytes, prefix.length);
  body.set(suffix, prefix.length + bytes.length);
  return {
    body,
    contentType: `multipart/form-data; boundary=${boundary}`,
  };
}

function detectImageType(bytes: Uint8Array) {
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    return { mimeType: "image/png", extension: "png" };
  }
  if (
    bytes.length >= 3 &&
    bytes[0] === 0xff &&
    bytes[1] === 0xd8 &&
    bytes[2] === 0xff
  ) {
    return { mimeType: "image/jpeg", extension: "jpg" };
  }
  if (
    bytes.length >= 12 &&
    String.fromCharCode(...bytes.slice(0, 4)) === "RIFF" &&
    String.fromCharCode(...bytes.slice(8, 12)) === "WEBP"
  ) {
    return { mimeType: "image/webp", extension: "webp" };
  }
  if (
    bytes.length >= 12 &&
    String.fromCharCode(...bytes.slice(4, 8)) === "ftyp" &&
    /^(heic|heix|hevc|hevx|mif1|msf1)$/.test(
      String.fromCharCode(...bytes.slice(8, 12)),
    )
  ) {
    return { mimeType: "image/heic", extension: "heic" };
  }
  return null;
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
  const item = objectValue(detail.data?.itemDO);
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
    engagement: {
      views: firstMetric(
        item.browseCount,
        item.browseCnt,
        item.viewCount,
        track.browseCount,
        track.browseCnt,
        track.viewCount,
      ),
      wants: firstMetric(
        item.wantCount,
        item.wantCnt,
        item.collectCount,
        track.wantCount,
        track.wantCnt,
        track.collectCount,
      ),
      inquiries: firstMetric(
        item.inquiryCount,
        item.consultCount,
        item.chatCount,
        track.inquiryCount,
        track.consultCount,
      ),
      sold: firstMetric(
        item.soldCount,
        item.tradeCount,
        track.soldCount,
        track.tradeCount,
      ),
    },
  };
}

function firstMetric(...values: unknown[]) {
  for (const value of values) {
    const number = Number(value);
    if (Number.isFinite(number) && number >= 0) return number;
  }
  return null;
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
