import { env } from "cloudflare:workers";

const PREFIX = "enc:v1:";
const encoder = new TextEncoder();
const decoder = new TextDecoder();

type RuntimeEnv = { DATA_ENCRYPTION_KEY?: string };

export function encryptionStatus() {
  return Boolean((env as unknown as RuntimeEnv).DATA_ENCRYPTION_KEY?.trim());
}

export function isEncryptedSecret(value: string | null | undefined) {
  return Boolean(value?.startsWith(PREFIX));
}

export async function encryptSecret(
  scope: string,
  owner: string | number,
  value: string,
) {
  if (!value) return "";
  if (value.startsWith(PREFIX)) {
    await decryptSecret(scope, owner, value);
    return value;
  }
  const key = await encryptionKey();
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt(
    {
      name: "AES-GCM",
      iv,
      additionalData: encoder.encode(`${scope}\0${owner}`),
    },
    key,
    encoder.encode(value),
  );
  return PREFIX + bytesToBase64(joinBytes(iv, new Uint8Array(encrypted)));
}

export async function decryptSecret(
  scope: string,
  owner: string | number,
  value: string | null | undefined,
) {
  if (!value || !value.startsWith(PREFIX)) return value || "";
  const raw = base64ToBytes(value.slice(PREFIX.length));
  if (raw.length < 29) throw new Error("敏感数据密文格式无效");
  const plain = await crypto.subtle
    .decrypt(
      {
        name: "AES-GCM",
        iv: raw.slice(0, 12),
        additionalData: encoder.encode(`${scope}\0${owner}`),
      },
      await encryptionKey(),
      raw.slice(12),
    )
    .catch(() => {
      throw new Error("敏感数据解密失败，请检查 DATA_ENCRYPTION_KEY");
    });
  return decoder.decode(plain);
}

export async function secretHash(value: string) {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(value));
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export function deliveryRuleOwner(productId: number, specKey: string) {
  return `${productId}:${specKey || "default"}`;
}

export function inventoryOwner(productId: number, ruleId?: number | null) {
  return `${productId}:${ruleId || "default"}`;
}

async function encryptionKey() {
  const value = (env as unknown as RuntimeEnv).DATA_ENCRYPTION_KEY?.trim();
  if (!value) {
    throw new Error("尚未配置 DATA_ENCRYPTION_KEY，无法安全保存发货资料");
  }
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(value));
  return crypto.subtle.importKey("raw", digest, "AES-GCM", false, [
    "encrypt",
    "decrypt",
  ]);
}

function joinBytes(first: Uint8Array, second: Uint8Array) {
  const value = new Uint8Array(first.length + second.length);
  value.set(first);
  value.set(second, first.length);
  return value;
}

function bytesToBase64(value: Uint8Array) {
  let binary = "";
  for (let index = 0; index < value.length; index += 8192) {
    binary += String.fromCharCode(...value.subarray(index, index + 8192));
  }
  return btoa(binary);
}

function base64ToBytes(value: string) {
  const binary = atob(value);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}
