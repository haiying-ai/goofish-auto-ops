import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { registerHooks } from "node:module";
import test from "node:test";

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "cloudflare:workers") {
      return {
        shortCircuit: true,
        url: "data:text/javascript,export const env = {};",
      };
    }
    return nextResolve(specifier, context);
  },
});

const developmentPreviewMeta =
  /<meta(?=[^>]*\bname=["']codex-preview["'])(?=[^>]*\bcontent=["']development["'])[^>]*>/i;

let workerPromise;
function loadWorker() {
  if (!workerPromise) {
    const workerUrl = new URL("../dist/server/index.js", import.meta.url);
    workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
    workerPromise = import(workerUrl.href).then((module) => module.default);
  }
  return workerPromise;
}

const runtimeEnv = {
  ASSETS: {
    fetch: async () => new Response("Not found", { status: 404 }),
  },
};

const executionContext = {
  waitUntil() {},
  passThroughOnException() {},
};

test("renders development preview metadata", async () => {
  const worker = await loadWorker();

  const response = await worker.fetch(
    new Request("http://localhost/", {
      headers: { accept: "text/html" },
    }),
    runtimeEnv,
    executionContext,
  );

  assert.equal(response.status, 200);
  assert.match(
    response.headers.get("content-type") ?? "",
    /^text\/html\b/i,
  );
  assert.match(await response.text(), developmentPreviewMeta);
});

test("protects the stateless MCP server with OAuth discovery", async () => {
  const worker = await loadWorker();
  const initialized = await worker.fetch(new Request("http://localhost/api/mcp", {
    method: "POST",
    headers: {
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
    },
    body: JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "auto-ops-test", version: "1.0.0" },
    },
    }),
  }), runtimeEnv, executionContext);
  assert.equal(initialized.status, 401);
  assert.match(initialized.headers.get("www-authenticate") || "", /oauth-protected-resource\/api\/mcp/);

  const protectedResource = await worker.fetch(
    new Request("http://localhost/.well-known/oauth-protected-resource/api/mcp"),
    runtimeEnv,
    executionContext,
  );
  assert.equal(protectedResource.status, 200);
  const metadata = await protectedResource.json();
  assert.equal(metadata.resource, "http://localhost/api/mcp");
  assert.deepEqual(metadata.scopes_supported, ["auto_ops.manage"]);

  const authorizationServer = await worker.fetch(
    new Request("http://localhost/.well-known/oauth-authorization-server"),
    runtimeEnv,
    executionContext,
  );
  assert.equal(authorizationServer.status, 200);
  const serverMetadata = await authorizationServer.json();
  assert.equal(serverMetadata.authorization_endpoint, "http://localhost/oauth/authorize");
  assert.deepEqual(serverMetadata.code_challenge_methods_supported, ["S256"]);

  const source = await readFile(new URL("../lib/mcp-server.ts", import.meta.url), "utf8");
  for (const name of [
    "get_product_metrics",
    "get_product_detail",
    "upload_product_image",
    "create_product_draft",
    "publish_product",
    "update_product",
    "take_product_offline",
    "configure_delivery_rule",
    "list_orders",
    "sync_xianyu_products",
  ]) {
    assert.match(source, new RegExp(`"${name}"`), `missing MCP tool ${name}`);
  }
  assert.match(source, /securitySchemes/);
});

test("blocks anonymous access to sensitive admin APIs", async () => {
  const worker = await loadWorker();
  const response = await worker.fetch(
    new Request("http://localhost/api/dashboard"),
    runtimeEnv,
    executionContext,
  );
  assert.notEqual(response.status, 200);
  assert.match(response.headers.get("cache-control") || "", /no-store/);
});

test("uses the reversible Xianyu downshelf API", async () => {
  const source = await readFile(
    new URL("../lib/xianyu-items.ts", import.meta.url),
    "utf8",
  );
  assert.match(source, /mtop\.taobao\.idle\.item\.downshelf/);
  assert.doesNotMatch(source, /com\.taobao\.idle\.item\.delete/);
});

test("maps the official Xianyu listing states without swapping sold and offline", async () => {
  const source = await readFile(
    new URL("../app/api/xianyu/items/route.ts", import.meta.url),
    "utf8",
  );
  assert.match(source, /itemStatus === "0"[\s\S]*?"published"/);
  assert.match(source, /itemStatus === "-2"[\s\S]*?"offline"/);
  assert.match(source, /itemStatus === "1"[\s\S]*?"sold"/);
});

test("Codex drafts require an explicit publish action and stay out of Cron", async () => {
  const [productsSource, cronSource, agentSource] = await Promise.all([
    readFile(new URL("../app/api/products/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/jobs/run/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/agent/route.ts", import.meta.url), "utf8"),
  ]);
  assert.match(productsSource, /publishMode === "draft" \? "draft" : "queued"/);
  assert.match(productsSource, /current\.status !== "draft"/);
  assert.match(cronSource, /eq\(products\.status, "queued"\)/);
  assert.doesNotMatch(cronSource, /eq\(products\.status, "draft"\)/);
  assert.match(agentSource, /guarantee: "draft 状态不会被 Cron 发布"/);
});

test("prefers the canonical product image before the placeholder-prone upload alias", async () => {
  const worker = await loadWorker();
  const originalFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (input) => {
    const url = String(input);
    requests.push(url);
    return new Response(Uint8Array.from([137, 80, 78, 71]), {
      headers: { "content-type": "image/png" },
    });
  };

  try {
    const source =
      "http://img.alicdn.com/imgextra/i2/example-fleamarket.png";
    const response = await worker.fetch(
      new Request(
        `http://localhost/api/xianyu/image?url=${encodeURIComponent(source)}`,
      ),
      runtimeEnv,
      executionContext,
    );
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), "image/png");
    assert.deepEqual(requests, [
      "https://img.alicdn.com/bao/uploaded/i2/example-fleamarket.png",
    ]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("cron scans seller orders, sends delivery messages, and confirms shipment", async () => {
  const [ordersSource, cronSource] = await Promise.all([
    readFile(new URL("../lib/xianyu-orders.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/jobs/run/route.ts", import.meta.url), "utf8"),
  ]);
  assert.match(ordersSource, /mtop\.taobao\.idle\.trade\.merchant\.sold\.get/);
  assert.match(ordersSource, /mtop\.taobao\.idle\.logistic\.consign\.dummy/);
  assert.match(cronSource, /sendDeliveryMessage/);
  assert.match(cronSource, /messageSentAt/);
  assert.match(cronSource, /needs_configuration/);
});

test("listing payload includes inventory, shipping, pickup, SKU, and original price fields", async () => {
  const source = await readFile(
    new URL("../lib/xianyu-items.ts", import.meta.url),
    "utf8",
  );
  assert.match(source, /origPriceInCent/);
  assert.match(source, /itemSkuList/);
  assert.match(source, /postPriceInCent/);
  assert.match(source, /onlyTakeSelf/);
  assert.match(source, /supportFreight/);
});

test("unconfigured-order alerts default to the requested mailbox", async () => {
  const source = await readFile(
    new URL("../lib/email.ts", import.meta.url),
    "utf8",
  );
  assert.match(source, /bingsun2020@163\.com/);
  assert.match(source, /Idempotency-Key/);
});

test("delivery automation supports specification rules and API-generated content", async () => {
  const [schema, cron, apiDelivery, rules] = await Promise.all([
    readFile(new URL("../db/schema.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/jobs/run/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../lib/api-delivery.ts", import.meta.url), "utf8"),
    readFile(new URL("../lib/delivery-rules.ts", import.meta.url), "utf8"),
  ]);
  assert.match(schema, /deliveryRules/);
  assert.match(schema, /automationRuns/);
  assert.match(schema, /automationSteps/);
  assert.match(cron, /prepare_delivery/);
  assert.match(cron, /send_message/);
  assert.match(cron, /confirm_shipment/);
  assert.match(cron, /fetchApiDeliveryContent/);
  assert.match(rules, /normalizeSpecKey/);
  assert.match(apiDelivery, /idempotency_key/);
  assert.match(apiDelivery, /API 发卡地址必须使用 HTTPS/);
});

test("sensitive fulfillment data is encrypted before D1 persistence", async () => {
  const [secrets, inventorySource, rulesSource, cronSource] = await Promise.all([
    readFile(new URL("../lib/secrets.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/inventory/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/delivery-rules/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/jobs/run/route.ts", import.meta.url), "utf8"),
  ]);
  assert.match(secrets, /AES-GCM/);
  assert.match(secrets, /DATA_ENCRYPTION_KEY/);
  assert.match(inventorySource, /encryptSecret\("inventory-secret"/);
  assert.match(rulesSource, /protectDeliveryRule/);
  assert.match(cronSource, /encryptSecret\(\s*"order-delivery"/);
});

test("order console exposes compensating actions and automation step details", async () => {
  const [ordersSource, pageSource] = await Promise.all([
    readFile(new URL("../app/api/orders/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
  ]);
  for (const action of [
    "retry",
    "resend",
    "confirm_shipment",
    "mark_resolved",
  ]) {
    assert.match(ordersSource, new RegExp(action));
  }
  assert.match(pageSource, /订单管理/);
  assert.match(pageSource, /自动化步骤/);
  assert.match(pageSource, /API 动态发卡/);
});

test("low-stock and task failures use idempotent operational email alerts", async () => {
  const [cronSource, emailSource] = await Promise.all([
    readFile(new URL("../app/api/jobs/run/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../lib/email.ts", import.meta.url), "utf8"),
  ]);
  assert.match(cronSource, /maybeSendLowStockAlert/);
  assert.match(cronSource, /sendTaskFailureAlert/);
  assert.match(emailSource, /sendOperationalAlert/);
  assert.match(emailSource, /Idempotency-Key/);
});
