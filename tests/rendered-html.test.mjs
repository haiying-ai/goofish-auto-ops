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
