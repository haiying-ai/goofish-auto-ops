import { and, asc, eq, lt } from "drizzle-orm";
import { getDb } from "../db";
import { imageUploadChunks, imageUploads } from "../db/schema";
import { uploadListingImage, type XianyuSession } from "./xianyu-items";

export const MAX_PRODUCT_IMAGE_BYTES = 5 * 1024 * 1024;
export const MAX_IMAGE_CHUNK_BYTES = 192 * 1024;
export const MAX_INLINE_IMAGE_BYTES = 160 * 1024;
export const MAX_IMAGE_CHUNK_BASE64_CHARS =
  Math.ceil(MAX_IMAGE_CHUNK_BYTES / 3) * 4 + 8;
export const MAX_INLINE_IMAGE_BASE64_CHARS =
  Math.ceil(MAX_INLINE_IMAGE_BYTES / 3) * 4 + 64;

const UPLOAD_LIFETIME_MS = 24 * 60 * 60 * 1000;
const ALLOWED_MIME_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);

export async function beginProductImageUpload(input: {
  filename: string;
  mimeType: string;
  sizeBytes: number;
  sha256?: string;
}) {
  if (!ALLOWED_MIME_TYPES.has(input.mimeType)) {
    throw new Error("仅支持 PNG、JPEG 或 WebP 图片");
  }
  if (
    !Number.isInteger(input.sizeBytes) ||
    input.sizeBytes < 1 ||
    input.sizeBytes > MAX_PRODUCT_IMAGE_BYTES
  ) {
    throw new Error("图片大小必须在 5MB 以内");
  }
  const expectedSha256 = normalizeSha256(input.sha256);
  const db = getDb();
  await cleanupExpiredUploads(db);
  const id = crypto.randomUUID();
  const now = new Date();
  const expiresAt = new Date(
    now.getTime() + UPLOAD_LIFETIME_MS,
  ).toISOString();
  await db.insert(imageUploads).values({
    id,
    filename: input.filename.slice(0, 120),
    mimeType: input.mimeType,
    expectedBytes: input.sizeBytes,
    expectedSha256,
    expiresAt,
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
  });
  return {
    uploadId: id,
    nextPart: 0,
    maxChunkBytes: MAX_IMAGE_CHUNK_BYTES,
    receivedBytes: 0,
    expectedBytes: input.sizeBytes,
    expiresAt,
  };
}

export async function appendProductImageChunk(input: {
  uploadId: string;
  partNumber: number;
  chunkBase64: string;
}) {
  const db = getDb();
  const [upload] = await db
    .select()
    .from(imageUploads)
    .where(eq(imageUploads.id, input.uploadId))
    .limit(1);
  if (!upload) {
    throw new Error("图片上传会话不存在或已过期，请重新开始");
  }
  if (upload.status === "completed") return uploadProgress(upload);
  if (new Date(upload.expiresAt).getTime() <= Date.now()) {
    throw new Error("图片上传会话已过期，请重新开始");
  }
  const normalizedChunk = normalizedBase64(input.chunkBase64);
  const bytes = decodeBase64Chunk(normalizedChunk);
  if (!bytes.length || bytes.length > MAX_IMAGE_CHUNK_BYTES) {
    throw new Error(
      `每个图片分片必须在 1 到 ${MAX_IMAGE_CHUNK_BYTES} 字节之间`,
    );
  }
  if (input.partNumber < upload.nextPart) {
    const [existing] = await db
      .select()
      .from(imageUploadChunks)
      .where(
        and(
          eq(imageUploadChunks.uploadId, input.uploadId),
          eq(imageUploadChunks.partNumber, input.partNumber),
        ),
      )
      .limit(1);
    if (existing?.dataBase64 === normalizedChunk) {
      return uploadProgress(upload);
    }
    throw new Error("该分片编号已经写入，内容不一致");
  }
  if (input.partNumber !== upload.nextPart) {
    throw new Error(`分片顺序错误，下一片必须是 ${upload.nextPart}`);
  }
  if (upload.receivedBytes + bytes.length > upload.expectedBytes) {
    throw new Error("分片总大小超过开始上传时声明的图片大小");
  }
  const now = new Date().toISOString();
  const nextReceivedBytes = upload.receivedBytes + bytes.length;
  const nextPart = upload.nextPart + 1;
  await db.batch([
    db.insert(imageUploadChunks).values({
      uploadId: input.uploadId,
      partNumber: input.partNumber,
      dataBase64: normalizedChunk,
      sizeBytes: bytes.length,
      createdAt: now,
    }),
    db
      .update(imageUploads)
      .set({
        receivedBytes: nextReceivedBytes,
        nextPart,
        status:
          nextReceivedBytes === upload.expectedBytes ? "ready" : "receiving",
        lastError: null,
        updatedAt: now,
      })
      .where(eq(imageUploads.id, input.uploadId)),
  ]);
  return {
    uploadId: input.uploadId,
    nextPart,
    receivedBytes: nextReceivedBytes,
    expectedBytes: upload.expectedBytes,
    complete: nextReceivedBytes === upload.expectedBytes,
  };
}

export async function finishProductImageUpload(
  uploadId: string,
  session: XianyuSession,
) {
  const db = getDb();
  const [upload] = await db
    .select()
    .from(imageUploads)
    .where(eq(imageUploads.id, uploadId))
    .limit(1);
  if (!upload) {
    throw new Error("图片上传会话不存在或已过期，请重新开始");
  }
  if (
    upload.status === "completed" &&
    upload.uploadedUrl &&
    upload.width &&
    upload.height
  ) {
    return {
      url: upload.uploadedUrl,
      width: upload.width,
      height: upload.height,
    };
  }
  if (upload.receivedBytes !== upload.expectedBytes) {
    throw new Error(
      `图片尚未接收完整：${upload.receivedBytes}/${upload.expectedBytes} 字节`,
    );
  }
  const chunks = await db
    .select()
    .from(imageUploadChunks)
    .where(eq(imageUploadChunks.uploadId, uploadId))
    .orderBy(asc(imageUploadChunks.partNumber));
  if (chunks.length !== upload.nextPart) {
    throw new Error("图片分片不完整，请重新开始上传");
  }
  const bytes = new Uint8Array(upload.expectedBytes);
  let offset = 0;
  for (let index = 0; index < chunks.length; index += 1) {
    const chunk = chunks[index];
    if (chunk.partNumber !== index) {
      throw new Error("图片分片顺序异常，请重新开始上传");
    }
    const decoded = decodeBase64Chunk(chunk.dataBase64);
    bytes.set(decoded, offset);
    offset += decoded.length;
  }
  if (offset !== upload.expectedBytes) {
    throw new Error("图片分片大小校验失败，请重新开始上传");
  }
  if (upload.expectedSha256) {
    const actualSha256 = await sha256Hex(bytes);
    if (actualSha256 !== upload.expectedSha256) {
      throw new Error("图片 SHA-256 校验失败，请重新开始上传");
    }
  }
  try {
    const image = await uploadListingImage(
      session,
      new Blob([bytes], { type: upload.mimeType }),
      upload.filename,
    );
    const now = new Date().toISOString();
    await db.batch([
      db
        .update(imageUploads)
        .set({
          status: "completed",
          uploadedUrl: image.url,
          width: image.width,
          height: image.height,
          lastError: null,
          updatedAt: now,
        })
        .where(eq(imageUploads.id, uploadId)),
      db
        .delete(imageUploadChunks)
        .where(eq(imageUploadChunks.uploadId, uploadId)),
    ]);
    return image;
  } catch (error) {
    const message = error instanceof Error ? error.message : "图片上传失败";
    await db
      .update(imageUploads)
      .set({
        status: "ready",
        lastError: message.slice(0, 500),
        updatedAt: new Date().toISOString(),
      })
      .where(eq(imageUploads.id, uploadId));
    throw error;
  }
}

function uploadProgress(upload: typeof imageUploads.$inferSelect) {
  return {
    uploadId: upload.id,
    nextPart: upload.nextPart,
    receivedBytes: upload.receivedBytes,
    expectedBytes: upload.expectedBytes,
    complete: upload.receivedBytes === upload.expectedBytes,
  };
}

function normalizedBase64(value: string) {
  return value.replace(/^data:[^,]+,/, "").replace(/\s+/g, "");
}

function decodeBase64Chunk(value: string) {
  const encoded = normalizedBase64(value);
  if (!encoded || encoded.length > MAX_IMAGE_CHUNK_BASE64_CHARS) {
    throw new Error("图片分片 Base64 过大或为空");
  }
  let binary: string;
  try {
    binary = atob(encoded);
  } catch {
    throw new Error("图片分片 Base64 格式不正确");
  }
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function normalizeSha256(value?: string) {
  const normalized = String(value || "").trim().toLowerCase();
  if (!normalized) return null;
  if (!/^[a-f0-9]{64}$/.test(normalized)) {
    throw new Error("SHA-256 必须是 64 位十六进制字符串");
  }
  return normalized;
}

async function sha256Hex(bytes: Uint8Array) {
  const data = bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
  const digest = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)]
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("");
}

async function cleanupExpiredUploads(db: ReturnType<typeof getDb>) {
  const now = new Date().toISOString();
  const expired = await db
    .select({ id: imageUploads.id })
    .from(imageUploads)
    .where(lt(imageUploads.expiresAt, now))
    .limit(20);
  for (const row of expired) {
    await db.batch([
      db
        .delete(imageUploadChunks)
        .where(eq(imageUploadChunks.uploadId, row.id)),
      db.delete(imageUploads).where(eq(imageUploads.id, row.id)),
    ]);
  }
}
