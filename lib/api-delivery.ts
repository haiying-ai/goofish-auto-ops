import { secretHash } from "./secrets";

const MAX_RESPONSE_BYTES = 1024 * 1024;
const MAX_PREVIEW_CHARS = 2048;
const RETRY_DELAYS = [250, 750];

export type ApiDeliveryConfig = {
  url: string;
  method: "GET" | "POST";
  headers: Record<string, string>;
  params: Record<string, string>;
  responsePath: string;
  timeoutSeconds: number;
  retryEnabled: boolean;
};

export type ApiDeliveryVariables = {
  orderId: string;
  itemId: string;
  buyerId: string;
  productId: string;
  specKey: string;
  specText: string;
  quantity: string;
  idempotencyKey: string;
};

export function normalizeApiDeliveryConfig(value: unknown): ApiDeliveryConfig {
  const input = objectValue(value);
  const method = String(input.method || "POST").toUpperCase();
  const config: ApiDeliveryConfig = {
    url: String(input.url || "").trim(),
    method: method === "GET" ? "GET" : "POST",
    headers: stringRecord(input.headers),
    params: stringRecord(input.params),
    responsePath: String(input.responsePath || "data.key").trim(),
    timeoutSeconds: clamp(Number(input.timeoutSeconds || 10), 3, 20),
    retryEnabled: input.retryEnabled === true,
  };
  validateApiConfig(config);
  return config;
}

export async function createApiIdempotencyKey(
  orderId: string,
  ruleId: number | null,
) {
  return secretHash(`xianyu-api:${orderId}:${ruleId || "legacy"}`);
}

export async function fetchApiDeliveryContent(
  config: ApiDeliveryConfig,
  variables: ApiDeliveryVariables,
) {
  const canRetry =
    config.retryEnabled && JSON.stringify(config).includes("{idempotency_key}");
  const attempts = canRetry ? 3 : 1;
  let lastError: Error | null = null;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (attempt) await wait(RETRY_DELAYS[attempt - 1]);
    try {
      const result = await executeApiRequest(config, variables);
      if (!result.content.trim()) throw new Error("API 发卡响应未提取到内容");
      return result;
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      if (!isRetryable(lastError) || attempt + 1 >= attempts) throw lastError;
    }
  }
  throw lastError || new Error("API 发卡失败");
}

export async function testApiDeliveryConfig(config: ApiDeliveryConfig) {
  const variables: ApiDeliveryVariables = {
    orderId: "test-order",
    itemId: "test-item",
    buyerId: "test-buyer",
    productId: "test-product",
    specKey: "test-spec",
    specText: "测试规格",
    quantity: "1",
    idempotencyKey: "test-idempotency-key",
  };
  const result = await executeApiRequest(config, variables);
  return {
    status: result.status,
    contentType: result.contentType,
    extractedValue: result.content.slice(0, MAX_PREVIEW_CHARS),
    preview: result.preview,
  };
}

function validateApiConfig(config: ApiDeliveryConfig) {
  if (!config.url) throw new Error("请填写 API 发卡地址");
  const url = new URL(config.url);
  if (url.protocol !== "https:") throw new Error("API 发卡地址必须使用 HTTPS");
  if (!isPublicHostname(url.hostname)) {
    throw new Error("API 发卡地址不能使用本机、内网或云元数据地址");
  }
  if (Object.keys(config.headers).length > 20 || Object.keys(config.params).length > 50) {
    throw new Error("API 请求头或参数数量过多");
  }
  for (const [name, value] of Object.entries(config.headers)) {
    if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name)) {
      throw new Error(`API 请求头名称无效：${name}`);
    }
    if (/^(host|content-length|connection|transfer-encoding|cookie|oai-sites-authorization)$/i.test(name)) {
      throw new Error(`不允许设置请求头：${name}`);
    }
    if (value.length > 4096) throw new Error(`API 请求头内容过长：${name}`);
  }
}

async function executeApiRequest(
  config: ApiDeliveryConfig,
  variables: ApiDeliveryVariables,
) {
  validateApiConfig(config);
  const replacements = variableMap(variables);
  const headers = replaceRecord(config.headers, replacements);
  const params = replaceRecord(config.params, replacements);
  const url = new URL(config.url);
  let body: string | undefined;
  if (config.method === "GET") {
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  } else {
    body = JSON.stringify(params);
    if (!Object.keys(headers).some((key) => key.toLowerCase() === "content-type")) {
      headers["content-type"] = "application/json";
    }
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeoutSeconds * 1000);
  try {
    const response = await fetch(url.toString(), {
      method: config.method,
      headers,
      body,
      redirect: "manual",
      signal: controller.signal,
    });
    if (response.status >= 300 && response.status < 400) {
      throw new Error("API 发卡地址发生重定向，已按安全策略阻止");
    }
    const raw = await readLimitedBody(response);
    if (!response.ok) {
      const error = new Error(`API 发卡返回 HTTP ${response.status}`);
      (error as Error & { status?: number }).status = response.status;
      throw error;
    }
    const contentType = response.headers.get("content-type") || "";
    const parsed = parseResponse(raw, contentType);
    const extracted = config.responsePath
      ? lookupPath(parsed, config.responsePath)
      : parsed;
    return {
      status: response.status,
      contentType,
      content: scalar(extracted),
      preview: raw.slice(0, MAX_PREVIEW_CHARS),
    };
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      throw new Error("API 发卡请求超时");
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function readLimitedBody(response: Response) {
  const declared = Number(response.headers.get("content-length") || 0);
  if (declared > MAX_RESPONSE_BYTES) throw new Error("API 发卡响应超过 1MB 限制");
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > MAX_RESPONSE_BYTES) {
      await reader.cancel();
      throw new Error("API 发卡响应超过 1MB 限制");
    }
    chunks.push(value);
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.length;
  }
  return new TextDecoder().decode(merged);
}

function parseResponse(raw: string, contentType: string) {
  if (/json/i.test(contentType) || /^[\s]*[\[{]/.test(raw)) {
    try {
      return JSON.parse(raw) as unknown;
    } catch {
      throw new Error("API 发卡响应不是有效 JSON");
    }
  }
  return raw;
}

function lookupPath(value: unknown, path: string) {
  const parts = path
    .replace(/\[(\d+)\]/g, ".$1")
    .split(".")
    .map((part) => part.trim())
    .filter(Boolean);
  let current: unknown = value;
  for (const part of parts) {
    if (Array.isArray(current)) current = current[Number(part)];
    else if (current && typeof current === "object") {
      current = (current as Record<string, unknown>)[part];
    } else current = undefined;
    if (current === undefined) throw new Error(`API 响应路径不存在：${path}`);
  }
  return current;
}

function scalar(value: unknown) {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value);
}

function variableMap(input: ApiDeliveryVariables) {
  return {
    "{order_id}": input.orderId,
    "{item_id}": input.itemId,
    "{buyer_id}": input.buyerId,
    "{product_id}": input.productId,
    "{spec_key}": input.specKey,
    "{spec_text}": input.specText,
    "{quantity}": input.quantity,
    "{order_quantity}": input.quantity,
    "{idempotency_key}": input.idempotencyKey,
    "{timestamp}": new Date().toISOString(),
  };
}

function replaceRecord(
  source: Record<string, string>,
  replacements: Record<string, string>,
) {
  return Object.fromEntries(
    Object.entries(source).map(([key, value]) => [
      key,
      Object.entries(replacements).reduce(
        (current, [pattern, replacement]) => current.split(pattern).join(replacement),
        value,
      ),
    ]),
  );
}

function stringRecord(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, entry]) => [
      String(key).trim(),
      typeof entry === "string" ? entry : JSON.stringify(entry),
    ]),
  );
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, Math.round(value) || min));
}

function isRetryable(error: Error & { status?: number }) {
  return (
    /超时|network|fetch failed/i.test(error.message) ||
    error.status === 408 ||
    error.status === 429 ||
    Number(error.status || 0) >= 500
  );
}

function isPublicHostname(hostname: string) {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    host.endsWith(".internal") ||
    host === "metadata.google.internal" ||
    host === "169.254.169.254"
  ) return false;
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) {
    const [a, b] = host.split(".").map(Number);
    return !(
      a === 0 || a === 10 || a === 127 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      a >= 224
    );
  }
  if (host.includes(":")) {
    return !(
      host === "::1" ||
      host.startsWith("fe80:") ||
      host.startsWith("fc") ||
      host.startsWith("fd")
    );
  }
  return Boolean(host && host.includes("."));
}

function wait(milliseconds: number) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
