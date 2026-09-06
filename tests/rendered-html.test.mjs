import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { registerHooks } from "node:module";
import test from "node:test";
import { deriveOperationalEvents } from "../lib/automation-health.ts";

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "cloudflare:workers") {
      return {
        shortCircuit: true,
        url: "data:text/javascript,export const env = { MCP_SHARED_SECRET: 'test-auto-ops-shared-secret' };",
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

test("protects the stateless MCP server with one shared secret", async () => {
  const worker = await loadWorker();
  const unauthorized = await worker.fetch(new Request("http://localhost/api/mcp?key=wrong", {
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
  assert.equal(unauthorized.status, 401);
  assert.doesNotMatch(unauthorized.headers.get("www-authenticate") || "", /oauth/);

  const initialized = await worker.fetch(new Request(
    "http://localhost/api/mcp?key=test-auto-ops-shared-secret",
    {
      method: "POST",
      headers: {
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "auto-ops-test", version: "1.0.0" },
        },
      }),
    },
  ), runtimeEnv, executionContext);
  assert.equal(initialized.status, 200);
  assert.match(await initialized.text(), /xianyu-auto-ops/);

  const listed = await worker.fetch(new Request(
    "http://localhost/api/mcp?key=test-auto-ops-shared-secret",
    {
      method: "POST",
      headers: {
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 3,
        method: "tools/list",
        params: {},
      }),
    },
  ), runtimeEnv, executionContext);
  assert.equal(listed.status, 200);
  const toolList = await listed.text();
  assert.match(toolList, /begin_product_image_upload/);
  assert.match(toolList, /upload_product_image_chunk/);
  assert.match(toolList, /finish_product_image_upload/);
  assert.match(toolList, /get_xianyu_account_status/);

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
    "get_xianyu_account_status",
    "upload_product_image",
    "begin_product_image_upload",
    "upload_product_image_chunk",
    "finish_product_image_upload",
    "create_product_draft",
    "delete_product_draft",
    "publish_product",
    "update_product",
    "take_product_offline",
    "configure_delivery_rule",
    "list_orders",
    "sync_xianyu_products",
  ]) {
    assert.match(source, new RegExp(`"${name}"`), `missing MCP tool ${name}`);
  }
  assert.match(source, /securitySchemes: \[\{ type: "noauth" \}\]/);
});

test("large MCP images use resumable chunks and current Xianyu upload profiles", async () => {
  const [mcpSource, uploadSource, schema] = await Promise.all([
    readFile(new URL("../lib/mcp-server.ts", import.meta.url), "utf8"),
    readFile(new URL("../lib/xianyu-items.ts", import.meta.url), "utf8"),
    readFile(new URL("../db/schema.ts", import.meta.url), "utf8"),
  ]);
  assert.match(mcpSource, /MAX_INLINE_IMAGE_BYTES/);
  assert.match(
    mcpSource,
    /begin_product_image_upload[\s\S]*upload_product_image_chunk[\s\S]*finish_product_image_upload/,
  );
  assert.match(uploadSource, /appKey: "xy_chat"/);
  assert.match(uploadSource, /publish_\$\{crypto\.randomUUID/);
  assert.match(uploadSource, /multipart\/form-data; boundary=/);
  assert.match(uploadSource, /INVALID_ARGUMENT/);
  assert.match(schema, /imageUploads/);
  assert.match(schema, /imageUploadChunks/);
});

test("Xianyu upload auth failures are explicit and full session renewal is encrypted", async () => {
  const [sessionSource, xianyuSource, uploadSource, sessionRoute, cronSource, mcpSource, pageSource] =
    await Promise.all([
      readFile(new URL("../lib/xianyu-session.ts", import.meta.url), "utf8"),
      readFile(new URL("../lib/xianyu.ts", import.meta.url), "utf8"),
      readFile(new URL("../lib/xianyu-items.ts", import.meta.url), "utf8"),
      readFile(
        new URL("../app/api/xianyu/session/route.ts", import.meta.url),
        "utf8",
      ),
      readFile(new URL("../app/api/jobs/run/route.ts", import.meta.url), "utf8"),
      readFile(new URL("../lib/mcp-server.ts", import.meta.url), "utf8"),
      readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    ]);
  assert.match(sessionSource, /encryptSecret\(\s*COOKIE_SECRET_SCOPE/);
  assert.match(sessionSource, /encrypted_database/);
  assert.match(uploadSource, /XianyuAuthenticationError/);
  assert.match(uploadSource, /recordXianyuUploadAuthState\(false/);
  assert.match(uploadSource, /scheduledKeepAlive\(\)/);
  assert.match(uploadSource, /recoveryAttempted/);
  assert.match(xianyuSource, /RENEWABLE_COOKIE_NAMES/);
  assert.match(xianyuSource, /readXianyuResponseCookies/);
  assert.match(xianyuSource, /XIANYU_FETCH_TIMEOUT_MS = 7_000/);
  assert.match(xianyuSource, /AbortSignal\.timeout\(XIANYU_FETCH_TIMEOUT_MS\)/);
  assert.match(sessionSource, /xianyuFetch/);
  assert.match(sessionSource, /fullCookieAutoRefresh: true/);
  assert.match(sessionSource, /mergeCookieUpdates/);
  assert.match(sessionSource, /https:\/\/www\.goofish\.com\/bought/);
  assert.match(sessionSource, /STRONG_KEEPALIVE_INTERVAL_MS/);
  assert.match(sessionSource, /refreshSessionPages/);
  assert.match(sessionSource, /PASSPORT_HAS_LOGIN_URL/);
  assert.match(sessionSource, /PASSPORT_SILENT_LOGIN_URL/);
  assert.match(sessionSource, /PASSPORT_LOGIN_SETTINGS_URL/);
  assert.match(sessionSource, /refreshPassportSession/);
  assert.match(sessionSource, /lastPassportSuccessAt/);
  assert.match(xianyuSource, /havana_lgc2_77/);
  assert.match(sessionSource, /lastStrongSuccessAt/);
  assert.match(sessionSource, /scheduledKeepAlive: true/);
  assert.match(cronSource, /scheduledKeepAlive\(\)/);
  assert.match(cronSource, /sessionRenewed/);
  assert.match(cronSource, /KEEPALIVE_ALERT_SETTING_KEY/);
  assert.match(cronSource, /notifyKeepaliveFailureOnce/);
  assert.match(cronSource, /if \(state\.alertSent\) return/);
  assert.match(cronSource, /clearKeepaliveFailureEpisode/);
  assert.match(cronSource, /timeZone: "Asia\/Shanghai"/);
  assert.match(cronSource, /闲鱼会话已自动恢复：无需人工处理/);
  assert.match(cronSource, /recoveryAlerts/);
  assert.match(cronSource, /keepaliveRequiresManualAction/);
  assert.match(cronSource, /xianyu-session-\$\{state\.episodeStartedAt\}/);
  assert.match(cronSource, /if \(!keepaliveFailureHandled\)/);
  assert.match(cronSource, /任务超过执行窗口，已由下一轮自动回收/);
  assert.match(cronSource, /datetime\(\$\{jobRuns\.startedAt\}\)/);
  assert.match(sessionRoute, /uploadListingImage[\s\S]*saveConfiguredXianyuCookie/);
  assert.match(sessionRoute, /cache-control/);
  assert.match(mcpSource, /errorCode: "AUTH_REQUIRED"/);
  assert.match(mcpSource, /xianyuAuthenticationErrorResult\(error, "自动化任务"\)/);
  assert.match(mcpSource, /xianyuAuthenticationErrorResult\(error, "商品同步"\)/);
  assert.match(mcpSource, /throw new XianyuAuthenticationError\(message\)/);
  assert.match(pageSource, /验证并安全保存/);
  assert.doesNotMatch(sessionRoute, /cookie:\s*session\.cookieHeader/);
});

test("permanently deletes only confirmed unpublished local drafts", async () => {
  const [productsSource, mcpSource, pageSource] = await Promise.all([
    readFile(new URL("../app/api/products/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../lib/mcp-server.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
  ]);
  assert.match(productsSource, /action === "delete_draft"/);
  assert.match(productsSource, /confirmDelete !== true/);
  assert.match(
    productsSource,
    /String\(input\.expectedTitle \|\| ""\)\.trim\(\) !== current\.title\.trim\(\)/,
  );
  assert.match(productsSource, /current\.status !== "draft"/);
  assert.match(productsSource, /current\.xianyuItemId/);
  assert.match(productsSource, /linkedOrders/);
  assert.match(productsSource, /linkedRuns/);
  assert.match(productsSource, /delete\(inventory\)/);
  assert.match(productsSource, /delete\(deliveryRules\)/);
  assert.match(productsSource, /delete\(products\)/);
  assert.match(mcpSource, /"delete_product_draft"/);
  assert.match(mcpSource, /confirm_delete_draft:\s*z[\s\S]{0,40}\.literal\(true\)/);
  assert.match(mcpSource, /destructiveHint: true/);
  assert.match(mcpSource, /expected_title/);
  assert.match(mcpSource, /草稿删除后回读验证失败/);
  assert.match(pageSource, /删除草稿/);
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

test("delivery rules hide offline products and show recent updates first", async () => {
  const [routeSource, pageSource] = await Promise.all([
    readFile(new URL("../app/api/delivery-rules/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
  ]);
  assert.match(routeSource, /timestamp\(right\.updatedAt\) - timestamp\(left\.updatedAt\)/);
  assert.match(routeSource, /ne\(products\.status, "offline"\)/);
  assert.match(routeSource, /updatedAt: product\.updatedAt/);
  assert.match(pageSource, /仅显示未下架商品，按最近修改时间倒序/);
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
  assert.match(emailSource, /EMAIL_SEND_TIMEOUT_MS = 5_000/);
  assert.match(emailSource, /AbortSignal\.timeout\(EMAIL_SEND_TIMEOUT_MS\)/);
});

test("dashboard reports real production health and safer manual execution", async () => {
  const [healthSource, dashboardSource, healthRouteSource, pageSource] =
    await Promise.all([
      readFile(new URL("../lib/automation-health.ts", import.meta.url), "utf8"),
      readFile(new URL("../app/api/dashboard/route.ts", import.meta.url), "utf8"),
      readFile(new URL("../app/api/health/route.ts", import.meta.url), "utf8"),
      readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    ]);

  assert.match(healthSource, /CRON_STALE_AFTER_MS = 15 \* 60 \* 1000/);
  assert.match(healthSource, /生产 Cron 已停止/);
  assert.match(healthSource, /requiresManualAction/);
  assert.match(healthSource, /deriveOperationalEvents/);
  assert.match(healthSource, /重复告警已抑制|suppressed/);
  assert.match(dashboardSource, /eq\(jobRuns\.job, "all"\)/);
  assert.match(dashboardSource, /automationHealth: deriveAutomationHealth/);
  assert.match(dashboardSource, /operationalEvents: deriveOperationalEvents/);
  assert.match(healthRouteSource, /ok: automationHealth\.state !== "critical"/);
  assert.match(pageSource, /window\.setInterval/);
  assert.match(pageSource, /60_000/);
  assert.match(pageSource, /真实订单扫描、自动发货和发布队列/);
  assert.match(pageSource, /disabled=\{manualRunning\}/);
  assert.match(pageSource, /timeZone: "Asia\/Shanghai"/);
  assert.match(pageSource, /本轮耗时/);
  assert.match(pageSource, /最近告警与恢复/);
  assert.match(pageSource, /运营告警邮件/);
  assert.match(pageSource, /失败告警/);
  assert.match(pageSource, /恢复通知/);
  assert.match(pageSource, /deleteDraft=\{deleteDraft\}/);
  assert.match(pageSource, /deleteDraft: \(product: Product\) => Promise<boolean>/);
});

test("session incident history distinguishes email and intervention states", () => {
  const events = deriveOperationalEvents([
    {
      id: 3,
      status: "success",
      startedAt: "2026-09-06T05:40:00.000Z",
      finishedAt: "2026-09-06T05:40:05.000Z",
      summary: JSON.stringify({ sessionRenewed: true, recoveryAlerts: 1 }),
    },
    {
      id: 2,
      status: "failed",
      startedAt: "2026-09-06T05:35:00.000Z",
      finishedAt: "2026-09-06T05:35:07.000Z",
      summary: JSON.stringify({
        sessionRenewed: false,
        failureAlerts: 1,
        errors: ["请求超时（7000ms）"],
      }),
    },
    {
      id: 1,
      status: "failed",
      startedAt: "2026-09-06T05:30:00.000Z",
      finishedAt: "2026-09-06T05:30:02.000Z",
      summary: JSON.stringify({
        sessionRenewed: false,
        failureAlerts: 1,
        errors: ["AUTH_REQUIRED：登录已失效"],
      }),
    },
  ]);

  assert.equal(events.length, 3);
  assert.equal(events[0].kind, "recovery");
  assert.equal(events[0].emailStatus, "sent");
  assert.equal(events[0].requiresManualAction, false);
  assert.equal(events[1].requiresManualAction, false);
  assert.equal(events[2].requiresManualAction, true);
});
