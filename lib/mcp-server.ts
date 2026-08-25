import { env } from "cloudflare:workers";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { desc, eq } from "drizzle-orm";
import * as z from "zod/v4";
import { POST as runAutomationRoute } from "../app/api/jobs/run/route";
import {
  DELETE as takeProductOfflineRoute,
  PATCH as updateProductRoute,
  POST as createProductRoute,
} from "../app/api/products/route";
import {
  GET as listDeliveryRulesRoute,
  POST as configureDeliveryRuleRoute,
} from "../app/api/delivery-rules/route";
import { POST as importInventoryRoute } from "../app/api/inventory/route";
import {
  GET as listOrdersRoute,
  PATCH as updateOrderRoute,
} from "../app/api/orders/route";
import { POST as syncProductsRoute } from "../app/api/xianyu/items/route";
import { getDb } from "../db";
import {
  deliveryRules,
  inventory,
  orders,
  products,
} from "../db/schema";
import {
  getListingDetails,
  parseListingImages,
  uploadListingImage,
} from "./xianyu-items";
import { createXianyuSession } from "./xianyu-session";
import { AUTO_OPS_SCOPE } from "./oauth";

type RuntimeEnv = { XIANYU_COOKIE?: string };
type ProductRow = typeof products.$inferSelect;
type JsonObject = Record<string, unknown>;

const productStatus = z.enum([
  "draft",
  "queued",
  "published",
  "offline",
  "sold",
  "failed",
  "unknown",
]);
const shippingMode = z.enum(["none", "free", "distance", "fixed"]);
const categoryMode = z.enum(["auto", "manual"]);
const deliveryType = z.enum(["text", "inventory", "api"]);
const imageSchema = z.object({
  url: z.url().describe("可公开读取的 HTTP(S) 图片地址或 upload_product_image 返回的地址"),
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
});
const skuSchema = z.object({
  properties: z
    .array(z.object({ name: z.string().min(1), value: z.string().min(1) }))
    .min(1)
    .max(2),
  price_yuan: z.number().positive(),
  quantity: z.number().int().min(0).max(9999),
});
const propertySchema = z.object({
  name: z.string().min(1),
  value: z.string().min(1),
});

const resultSchema = { data: z.unknown() };

export function createAutoOpsMcpServer(
  authorizationHeader = "",
  requestOrigin = "https://auto-ops.internal",
) {
  const apiRequest = (path: string, method: string, body?: unknown) =>
    jsonRequest(path, method, body, authorizationHeader, requestOrigin);
  const server = new McpServer(
    { name: "xianyu-auto-ops", version: "2.0.0" },
    {
      instructions:
        "这是闲鱼 Auto Ops。发布、修改在售商品或下架前，必须先调用 get_product_detail 核对商品编号、标题、状态和图片，并取得用户对本次操作的明确确认。新商品先用 create_product_draft 建草稿；草稿不会被 Cron 自动发布。不要输出 Cookie、访问令牌、完整卡密库存或 API 密钥。",
    },
  );

  server.registerTool(
    "get_dashboard_summary",
    {
      title: "获取 Auto Ops 总览",
      description:
        "查看商品状态、可用卡密、已发货订单和待处理订单的汇总。适合进入后台维护前先了解整体状态。",
      inputSchema: {},
      outputSchema: resultSchema,
      _meta: oauthToolMeta(),
      annotations: readOnlyAnnotations,
    },
    async () => {
      const db = getDb();
      const [productRows, inventoryRows, orderRows] = await Promise.all([
        db.select({ id: products.id, status: products.status }).from(products),
        db.select({ status: inventory.status }).from(inventory),
        db.select({ status: orders.status }).from(orders),
      ]);
      const summary = {
        products: productRows.length,
        draft: countBy(productRows, "status", "draft"),
        queued: countBy(productRows, "status", "queued"),
        published: countBy(productRows, "status", "published"),
        offline: countBy(productRows, "status", "offline"),
        sold: countBy(productRows, "status", "sold"),
        availableInventory: countBy(inventoryRows, "status", "available"),
        deliveredOrders: countBy(orderRows, "status", "delivered"),
        needsAttentionOrders: orderRows.filter((row) =>
          ["failed", "needs_configuration"].includes(row.status),
        ).length,
      };
      return toolResult({ data: summary }, `当前共有 ${summary.products} 件商品，在售 ${summary.published} 件。`);
    },
  );

  server.registerTool(
    "list_products",
    {
      title: "筛选商品",
      description:
        "按标题、闲鱼商品编号、状态或发货配置筛选 Auto Ops 中的商品。返回稳定的本地商品编号，供详情和维护工具继续使用。",
      inputSchema: {
        keyword: z.string().trim().max(100).optional(),
        status: productStatus.optional(),
        delivery_status: z.enum(["configured", "unconfigured"]).optional(),
        delivery_type: deliveryType.optional(),
        limit: z.number().int().min(1).max(200).default(50),
      },
      outputSchema: resultSchema,
      _meta: oauthToolMeta(),
      annotations: readOnlyAnnotations,
    },
    async ({ keyword, status, delivery_status, delivery_type, limit }) => {
      const db = getDb();
      const [productRows, ruleRows, inventoryRows] = await Promise.all([
        db.select().from(products).orderBy(desc(products.updatedAt)).limit(500),
        db.select().from(deliveryRules),
        db.select({ productId: inventory.productId, ruleId: inventory.ruleId, status: inventory.status }).from(inventory),
      ]);
      const needle = String(keyword || "").toLocaleLowerCase();
      const matches = productRows
        .map((row) => productSummary(row, ruleRows, inventoryRows))
        .filter((row) => !needle || `${row.title}\n${row.xianyuItemId || ""}\n${row.description || ""}`.toLocaleLowerCase().includes(needle))
        .filter((row) => !status || row.status === status)
        .filter((row) => !delivery_status || (delivery_status === "configured" ? row.deliveryConfigured : !row.deliveryConfigured))
        .filter((row) => !delivery_type || row.deliveryTypes.includes(delivery_type))
        .slice(0, limit);
      return toolResult(
        { data: { products: matches, count: matches.length } },
        `找到 ${matches.length} 件符合条件的商品。`,
      );
    },
  );

  server.registerTool(
    "get_product_detail",
    {
      title: "获取商品详情",
      description:
        "按 Auto Ops 商品编号读取标题、价格、库存、运费、类目、规格、图片、发货配置和本地状态；可选读取闲鱼端实时详情。任何发布、修改或下架操作前都应先调用。",
      inputSchema: {
        product_id: z.number().int().positive(),
        include_remote: z.boolean().default(false),
      },
      outputSchema: resultSchema,
      _meta: oauthToolMeta(),
      annotations: { ...readOnlyAnnotations, openWorldHint: true },
    },
    async ({ product_id, include_remote }) => {
      const db = getDb();
      const [product] = await db.select().from(products).where(eq(products.id, product_id)).limit(1);
      if (!product) throw new Error("商品不存在");
      const [ruleRows, inventoryRows] = await Promise.all([
        db.select().from(deliveryRules).where(eq(deliveryRules.productId, product.id)),
        db.select({ ruleId: inventory.ruleId, status: inventory.status }).from(inventory).where(eq(inventory.productId, product.id)),
      ]);
      let remote: unknown = null;
      if (include_remote && product.xianyuItemId) {
        remote = await getListingDetails(await requiredXianyuSession(), product.xianyuItemId);
      }
      const detail = {
        ...productDetail(product),
        deliveryRules: ruleRows.map((rule) => sanitizeRule(rule, inventoryRows)),
        remote,
      };
      return toolResult({ data: detail }, `已读取商品「${product.title}」的详情。`);
    },
  );

  server.registerTool(
    "get_product_metrics",
    {
      title: "获取商品运营指标",
      description:
        "获取单件商品的本地订单、成交、发货、卡密库存和闲鱼实时状态。闲鱼详情接口未返回的曝光、浏览、想要或咨询指标会明确标记为不可用，不会伪造。",
      inputSchema: {
        product_id: z.number().int().positive(),
        include_remote: z.boolean().default(true),
      },
      outputSchema: resultSchema,
      _meta: oauthToolMeta(),
      annotations: { ...readOnlyAnnotations, openWorldHint: true },
    },
    async ({ product_id, include_remote }) => {
      const db = getDb();
      const [product] = await db.select().from(products).where(eq(products.id, product_id)).limit(1);
      if (!product) throw new Error("商品不存在");
      const [orderRows, inventoryRows] = await Promise.all([
        db.select().from(orders).where(eq(orders.productId, product.id)),
        db.select({ status: inventory.status }).from(inventory).where(eq(inventory.productId, product.id)),
      ]);
      let remote: Awaited<ReturnType<typeof getListingDetails>> | null = null;
      if (include_remote && product.xianyuItemId) {
        remote = await getListingDetails(await requiredXianyuSession(), product.xianyuItemId);
      }
      const metrics = {
        productId: product.id,
        xianyuItemId: product.xianyuItemId,
        title: product.title,
        localStatus: product.status,
        remoteStatus: remote?.itemStatus ?? null,
        remoteEngagement: remote?.engagement ?? {
          views: null,
          wants: null,
          inquiries: null,
          sold: null,
        },
        metricAvailability: {
          exposure: "闲鱼当前详情接口未提供",
          views: remote?.engagement.views == null ? "未提供" : "available",
          wants: remote?.engagement.wants == null ? "未提供" : "available",
          inquiries: remote?.engagement.inquiries == null ? "未提供" : "available",
        },
        orders: {
          total: orderRows.length,
          pending: countBy(orderRows, "status", "pending"),
          delivered: countBy(orderRows, "status", "delivered"),
          failed: countBy(orderRows, "status", "failed"),
          needsConfiguration: countBy(orderRows, "status", "needs_configuration"),
        },
        inventory: {
          available: countBy(inventoryRows, "status", "available"),
          reserved: countBy(inventoryRows, "status", "reserved"),
          used: countBy(inventoryRows, "status", "used"),
        },
        updatedAt: product.updatedAt,
      };
      return toolResult({ data: metrics }, `已读取「${product.title}」的可用运营指标。`);
    },
  );

  server.registerTool(
    "upload_product_image",
    {
      title: "上传商品图片",
      description:
        "把一张图片上传到闲鱼图片服务，返回可用于商品草稿的地址和尺寸。支持 data URL 或纯 Base64，单张不超过 8 MiB。",
      inputSchema: {
        image_base64: z.string().min(16).describe("data:image/...;base64,... 或纯 Base64 内容"),
        filename: z.string().trim().min(1).max(120).default("listing.png"),
        mime_type: z.enum(["image/png", "image/jpeg", "image/webp"]).default("image/png"),
      },
      outputSchema: resultSchema,
      _meta: oauthToolMeta(),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: true,
      },
    },
    async ({ image_base64, filename, mime_type }) => {
      const parsed = decodeImage(image_base64, mime_type);
      const uploaded = await uploadListingImage(
        await requiredXianyuSession(),
        new Blob([parsed.bytes], { type: parsed.mimeType }),
        filename,
      );
      return toolResult({ data: uploaded }, `图片已上传，尺寸 ${uploaded.width}×${uploaded.height}。`);
    },
  );

  server.registerTool(
    "create_product_draft",
    {
      title: "创建商品草稿",
      description:
        "在 Auto Ops 中创建不会被 Cron 自动发布的商品草稿。至少需要一张图片；价格和运费均以人民币元输入。",
      inputSchema: {
        title: z.string().trim().min(1).max(60),
        description: z.string().max(5000).default(""),
        price_yuan: z.number().positive(),
        original_price_yuan: z.number().positive().optional(),
        quantity: z.number().int().min(1).max(9999).default(1),
        images: z.array(imageSchema).min(1).max(9),
        shipping_mode: shippingMode.default("none"),
        shipping_fee_yuan: z.number().min(0).default(0),
        self_pickup: z.boolean().default(false),
        category_mode: categoryMode.default("auto"),
        category_id: z.string().trim().optional(),
        category_name: z.string().trim().optional(),
        skus: z.array(skuSchema).max(100).default([]),
        properties: z.array(propertySchema).max(30).default([]),
      },
      outputSchema: resultSchema,
      _meta: oauthToolMeta(),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: false,
      },
    },
    async (input) => {
      const response = await createProductRoute(
        apiRequest("/api/products", "POST", listingBody(input, true)),
      );
      const body = await requireJson(response);
      const product = body.product as ProductRow;
      return toolResult(
        { data: { product: productDetail(product), publishMode: "draft" } },
        `草稿「${product.title}」已创建，商品编号 ${product.id}。`,
      );
    },
  );

  server.registerTool(
    "publish_product",
    {
      title: "发布商品到闲鱼",
      description:
        "把已核对的草稿、待发布或失败商品正式发布到闲鱼。调用前必须先读取详情，并让用户明确确认标题和本次发布。",
      inputSchema: {
        product_id: z.number().int().positive(),
        expected_title: z.string().trim().min(1),
        category_reference_item_id: z.string().trim().optional(),
        confirm_publish: z.literal(true).describe("仅在用户明确确认本次发布后传 true"),
      },
      outputSchema: resultSchema,
      _meta: oauthToolMeta(),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: true,
      },
    },
    async ({ product_id, expected_title, category_reference_item_id }) => {
      const product = await requireProduct(product_id);
      requireExpectedTitle(product, expected_title);
      const response = await updateProductRoute(
        apiRequest("/api/products", "PATCH", {
          id: product.id,
          action: "publish_listing",
          categoryReferenceItemId: category_reference_item_id || "",
        }),
      );
      const body = await requireJson(response);
      const updated = body.product as ProductRow;
      return toolResult(
        { data: { product: productDetail(updated), remoteUpdated: true } },
        `商品「${updated.title}」已发布，闲鱼商品编号 ${updated.xianyuItemId}。`,
      );
    },
  );

  server.registerTool(
    "update_product",
    {
      title: "修改商品信息",
      description:
        "修改商品标题、价格、库存、描述、图片、运费、类目、规格或属性。在售商品会同步修改闲鱼端，调用前必须核对详情并明确确认。",
      inputSchema: {
        product_id: z.number().int().positive(),
        expected_title: z.string().trim().min(1),
        confirm_remote_update: z.boolean().default(false),
        title: z.string().trim().min(1).max(60).optional(),
        description: z.string().max(5000).optional(),
        price_yuan: z.number().positive().optional(),
        original_price_yuan: z.number().positive().nullable().optional(),
        quantity: z.number().int().min(1).max(9999).optional(),
        images: z.array(imageSchema).min(1).max(9).optional(),
        shipping_mode: shippingMode.optional(),
        shipping_fee_yuan: z.number().min(0).optional(),
        self_pickup: z.boolean().optional(),
        category_mode: categoryMode.optional(),
        category_id: z.string().trim().optional(),
        category_name: z.string().trim().optional(),
        skus: z.array(skuSchema).max(100).optional(),
        properties: z.array(propertySchema).max(30).optional(),
      },
      outputSchema: resultSchema,
      _meta: oauthToolMeta(),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: true,
      },
    },
    async (input) => {
      const product = await requireProduct(input.product_id);
      requireExpectedTitle(product, input.expected_title);
      if (product.status === "published" && !input.confirm_remote_update) {
        throw new Error("该商品正在闲鱼出售；请在用户明确确认本次远程修改后将 confirm_remote_update 设为 true");
      }
      const response = await updateProductRoute(
        apiRequest("/api/products", "PATCH", {
          ...listingBody(input, false),
          id: product.id,
          action: "edit_listing",
        }),
      );
      const body = await requireJson(response);
      const updated = body.product as ProductRow;
      return toolResult(
        { data: { product: productDetail(updated), remoteUpdated: body.remoteUpdated === true } },
        `商品「${updated.title}」已更新${body.remoteUpdated ? "，并同步到闲鱼" : ""}。`,
      );
    },
  );

  server.registerTool(
    "take_product_offline",
    {
      title: "下架商品",
      description:
        "将指定商品从闲鱼下架并把 Auto Ops 状态改为已下架。调用前必须核对详情并取得用户明确确认。",
      inputSchema: {
        product_id: z.number().int().positive(),
        expected_title: z.string().trim().min(1),
        confirm_offline: z.literal(true).describe("仅在用户明确确认本次下架后传 true"),
      },
      outputSchema: resultSchema,
      _meta: oauthToolMeta(),
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        openWorldHint: true,
      },
    },
    async ({ product_id, expected_title }) => {
      const product = await requireProduct(product_id);
      requireExpectedTitle(product, expected_title);
      const response = await takeProductOfflineRoute(
        apiRequest("/api/products", "DELETE", { id: product.id }),
      );
      const body = await requireJson(response);
      const updated = body.product as ProductRow;
      return toolResult(
        { data: { product: productDetail(updated), remoteUpdated: body.remoteUpdated === true } },
        `商品「${updated.title}」已下架。`,
      );
    },
  );

  server.registerTool(
    "list_delivery_rules",
    {
      title: "查看发货配置",
      description:
        "按商品筛选固定文本、卡密库存或 API 动态发卡规则。默认仅返回配置状态和固定文本预览，不返回完整卡密或 API 密钥。",
      inputSchema: {
        product_id: z.number().int().positive().optional(),
        delivery_type: deliveryType.optional(),
        configured: z.boolean().optional(),
        include_fixed_text: z.boolean().default(false),
      },
      outputSchema: resultSchema,
      _meta: oauthToolMeta(),
      annotations: readOnlyAnnotations,
    },
    async ({ product_id, delivery_type, configured, include_fixed_text }) => {
      const body = await requireJson(
        await listDeliveryRulesRoute(apiRequest("/api/delivery-rules", "GET")),
      );
      const rows = Array.isArray(body.rules) ? (body.rules as JsonObject[]) : [];
      const filtered = rows
        .filter((row) => !product_id || Number(row.productId) === product_id)
        .filter((row) => !delivery_type || row.deliveryType === delivery_type)
        .map((row) => sanitizeExposedRule(row, include_fixed_text))
        .filter((row) => configured === undefined || Boolean(row.configured) === configured);
      return toolResult(
        { data: { rules: filtered, count: filtered.length } },
        `找到 ${filtered.length} 条发货配置。`,
      );
    },
  );

  server.registerTool(
    "configure_delivery_rule",
    {
      title: "配置自动发货规则",
      description:
        "为商品默认规格或指定规格设置固定文本、卡密库存或 API 动态发卡。保存后定时任务可按此规则自动发货，必须先取得用户明确确认。",
      inputSchema: {
        product_id: z.number().int().positive(),
        spec_label: z.string().trim().max(200).default(""),
        delivery_type: deliveryType,
        delivery_content: z.string().max(10000).default(""),
        api_config: z.record(z.string(), z.unknown()).optional(),
        low_stock_threshold: z.number().int().min(0).max(9999).default(3),
        enabled: z.boolean().default(true),
        confirm_configuration: z.literal(true),
      },
      outputSchema: resultSchema,
      _meta: oauthToolMeta(),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: false,
      },
    },
    async (input) => {
      const product = await requireProduct(input.product_id);
      const body = await requireJson(
        await configureDeliveryRuleRoute(
          apiRequest("/api/delivery-rules", "POST", {
            productId: product.id,
            specLabel: input.spec_label,
            deliveryType: input.delivery_type,
            deliveryContent: input.delivery_content,
            apiConfig: input.api_config,
            lowStockThreshold: input.low_stock_threshold,
            enabled: input.enabled,
          }),
        ),
      );
      return toolResult(
        { data: { rule: sanitizeExposedRule(body.rule as JsonObject, false) } },
        `商品「${product.title}」的发货规则已保存。`,
      );
    },
  );

  server.registerTool(
    "import_inventory_codes",
    {
      title: "导入卡密库存",
      description:
        "向商品的默认或规格发货规则导入卡密；只返回新增和重复数量，不回显卡密正文。必须先取得用户明确确认。",
      inputSchema: {
        product_id: z.number().int().positive(),
        rule_id: z.number().int().positive().nullable().default(null),
        codes: z.array(z.string().trim().min(1).max(5000)).min(1).max(1000),
        confirm_import: z.literal(true),
      },
      outputSchema: resultSchema,
      _meta: oauthToolMeta(),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: false,
      },
    },
    async ({ product_id, rule_id, codes }) => {
      await requireProduct(product_id);
      const body = await requireJson(
        await importInventoryRoute(
          apiRequest("/api/inventory", "POST", {
            productId: product_id,
            ruleId: rule_id,
            secrets: codes.join("\n"),
          }),
        ),
      );
      return toolResult(
        { data: { added: Number(body.added || 0), skipped: Number(body.skipped || 0) } },
        `已新增 ${Number(body.added || 0)} 条卡密，跳过 ${Number(body.skipped || 0)} 条重复项。`,
      );
    },
  );

  server.registerTool(
    "list_orders",
    {
      title: "筛选订单与发货状态",
      description:
        "按状态、商品标题或闲鱼订单编号查看订单、自动化步骤和错误。默认不返回已生成的完整发货内容。",
      inputSchema: {
        keyword: z.string().trim().max(100).optional(),
        status: z.string().trim().max(50).optional(),
        include_delivery_content: z.boolean().default(false),
        limit: z.number().int().min(1).max(100).default(50),
      },
      outputSchema: resultSchema,
      _meta: oauthToolMeta(),
      annotations: readOnlyAnnotations,
    },
    async ({ keyword, status, include_delivery_content, limit }) => {
      const body = await requireJson(
        await listOrdersRoute(apiRequest("/api/orders", "GET")),
      );
      const needle = String(keyword || "").toLocaleLowerCase();
      const rows = (Array.isArray(body.orders) ? body.orders : [])
        .filter((row: JsonObject) => !status || row.status === status)
        .filter((row: JsonObject) => !needle || `${row.xianyuOrderId || ""}\n${row.productTitle || ""}\n${row.buyerNick || ""}`.toLocaleLowerCase().includes(needle))
        .slice(0, limit)
        .map((row: JsonObject) => ({
          ...row,
          deliveryContent: include_delivery_content && row.deliveryContent ? row.deliveryContent : undefined,
        }));
      return toolResult({ data: { orders: rows, count: rows.length } }, `找到 ${rows.length} 笔订单。`);
    },
  );

  server.registerTool(
    "retry_order_delivery",
    {
      title: "重试订单发货",
      description:
        "把失败或待处理订单重新加入自动发货，或重新发送已生成的发货消息。调用前必须取得用户明确确认。",
      inputSchema: {
        order_id: z.number().int().positive(),
        mode: z.enum(["retry", "resend"]).default("retry"),
        confirm_retry: z.literal(true),
      },
      outputSchema: resultSchema,
      _meta: oauthToolMeta(),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: true,
      },
    },
    async ({ order_id, mode }) => {
      const body = await requireJson(
        await updateOrderRoute(
          apiRequest("/api/orders", "PATCH", { id: order_id, action: mode }),
        ),
      );
      return toolResult({ data: body }, `订单 ${order_id} 已重新加入发货流程。`);
    },
  );

  server.registerTool(
    "sync_xianyu_products",
    {
      title: "同步闲鱼商品",
      description:
        "从闲鱼账号同步在售、已售出和已下架商品，并在完整扫描后修正 Auto Ops 中已不在售的状态。不会改变闲鱼端商品。",
      inputSchema: {},
      outputSchema: resultSchema,
      _meta: oauthToolMeta(),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: true,
      },
    },
    async () => {
      const body = await requireJson(
        await syncProductsRoute(apiRequest("/api/xianyu/items", "POST")),
      );
      return toolResult({ data: body }, `同步完成，共读取 ${Number(body.synced || 0)} 件闲鱼商品。`);
    },
  );

  server.registerTool(
    "run_automation_now",
    {
      title: "立即运行自动化",
      description:
        "立即执行一次与 Cron 相同的发布队列、订单扫描、自动发货和库存告警流程。dry_run=true 只规划不执行；实际执行前必须明确确认。",
      inputSchema: {
        dry_run: z.boolean().default(true),
        product_id: z.number().int().positive().optional(),
        confirm_execution: z.boolean().default(false),
      },
      outputSchema: resultSchema,
      _meta: oauthToolMeta(),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: true,
      },
    },
    async ({ dry_run, product_id, confirm_execution }) => {
      if (!dry_run && !confirm_execution) {
        throw new Error("实际运行可能发布排队商品并向买家发货；请在用户明确确认后将 confirm_execution 设为 true");
      }
      const request = apiRequest("/api/jobs/run", "POST", {
        dryRun: dry_run,
        productId: product_id,
      });
      const body = await requireJson(await runAutomationRoute(request));
      return toolResult(
        { data: body },
        dry_run ? "自动化演练已完成，未执行外部写入。" : "自动化任务已执行。",
      );
    },
  );

  return server;
}

const readOnlyAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  openWorldHint: false,
} as const;

function toolResult(structuredContent: JsonObject, text: string) {
  return {
    structuredContent,
    content: [{ type: "text" as const, text }],
  };
}

function jsonRequest(
  path: string,
  method: string,
  body?: unknown,
  authorizationHeader = "",
  requestOrigin = "https://auto-ops.internal",
) {
  const headers = new Headers({ "content-type": "application/json" });
  if (authorizationHeader) headers.set("authorization", authorizationHeader);
  return new Request(`${requestOrigin}${path}`, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

function oauthToolMeta() {
  return {
    securitySchemes: [{ type: "oauth2", scopes: [AUTO_OPS_SCOPE] }],
  };
}

async function requireJson(response: Response): Promise<JsonObject> {
  const body = (await response.json()) as JsonObject;
  if (!response.ok) {
    throw new Error(String(body.error || `请求失败（HTTP ${response.status}）`));
  }
  return body;
}

async function requireProduct(id: number) {
  const [product] = await getDb().select().from(products).where(eq(products.id, id)).limit(1);
  if (!product) throw new Error("商品不存在");
  return product;
}

function requireExpectedTitle(product: ProductRow, expectedTitle: string) {
  if (product.title.trim() !== expectedTitle.trim()) {
    throw new Error(`标题核对失败：商品 ${product.id} 当前标题为「${product.title}」`);
  }
}

async function requiredXianyuSession() {
  const cookie = (env as unknown as RuntimeEnv).XIANYU_COOKIE;
  if (!cookie) throw new Error("尚未配置闲鱼 Cookie");
  return createXianyuSession(cookie);
}

function listingBody(input: JsonObject, draft: boolean) {
  const body: JsonObject = {};
  copy(input, body, "title", "title");
  copy(input, body, "description", "description");
  copy(input, body, "price_yuan", "price");
  copy(input, body, "original_price_yuan", "originalPrice");
  copy(input, body, "quantity", "quantity");
  copy(input, body, "images", "images");
  copy(input, body, "shipping_mode", "shippingMode");
  copy(input, body, "shipping_fee_yuan", "shippingFee");
  copy(input, body, "self_pickup", "selfPickup");
  copy(input, body, "category_mode", "categoryMode");
  copy(input, body, "category_id", "categoryId");
  copy(input, body, "category_name", "categoryName");
  copy(input, body, "properties", "properties");
  if (Array.isArray(input.skus)) {
    body.skus = input.skus.map((entry) => {
      const sku = entry as z.infer<typeof skuSchema>;
      return {
        properties: sku.properties,
        priceCents: Math.round(sku.price_yuan * 100),
        quantity: sku.quantity,
      };
    });
  }
  if (draft) body.publishMode = "draft";
  return body;
}

function copy(source: JsonObject, target: JsonObject, from: string, to: string) {
  if (source[from] !== undefined) target[to] = source[from];
}

function productDetail(row: ProductRow) {
  return {
    id: row.id,
    xianyuItemId: row.xianyuItemId,
    title: row.title,
    description: row.description,
    priceYuan: row.priceCents / 100,
    originalPriceYuan: row.originalPriceCents == null ? null : row.originalPriceCents / 100,
    quantity: row.quantity,
    shippingMode: row.shippingMode,
    shippingFeeYuan: row.shippingFeeCents / 100,
    selfPickup: row.selfPickup,
    categoryMode: row.categoryMode,
    categoryId: row.categoryId,
    categoryName: row.categoryName,
    skus: parseJson(row.skuJson),
    properties: parseJson(row.propertiesJson),
    images: parseListingImages(row.imagesJson),
    status: row.status,
    deliveryType: row.deliveryType,
    deliveryConfigured: Boolean(row.deliveryContent),
    lastError: row.lastError,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function productSummary(
  row: ProductRow,
  rules: Array<typeof deliveryRules.$inferSelect>,
  stock: Array<{ productId: number; ruleId: number | null; status: string }>,
) {
  const assigned = rules.filter((rule) => rule.productId === row.id && rule.enabled);
  const availableByRule = new Map<number | null, number>();
  for (const item of stock.filter((item) => item.productId === row.id && item.status === "available")) {
    availableByRule.set(item.ruleId, (availableByRule.get(item.ruleId) || 0) + 1);
  }
  const deliveryTypes = [
    ...new Set([
      ...(row.deliveryContent ? [row.deliveryType] : []),
      ...assigned.map((rule) => rule.deliveryType),
    ]),
  ];
  const configured = Boolean(row.deliveryContent) || assigned.some((rule) => {
    if (rule.deliveryType === "text") return Boolean(rule.deliveryContent);
    if (rule.deliveryType === "api") return Boolean(rule.apiConfig);
    return (availableByRule.get(rule.id) || availableByRule.get(null) || 0) > 0;
  });
  return {
    id: row.id,
    xianyuItemId: row.xianyuItemId,
    title: row.title,
    description: row.description,
    priceYuan: row.priceCents / 100,
    quantity: row.quantity,
    status: row.status,
    image: parseListingImages(row.imagesJson)[0] || null,
    deliveryConfigured: configured,
    deliveryTypes,
    updatedAt: row.updatedAt,
  };
}

function sanitizeRule(
  rule: typeof deliveryRules.$inferSelect,
  stock: Array<{ ruleId: number | null; status: string }>,
) {
  const pool = stock.filter((item) => item.ruleId === rule.id || (!rule.specKey && item.ruleId == null));
  return {
    id: rule.id,
    specKey: rule.specKey,
    specLabel: rule.specLabel || "默认规则",
    deliveryType: rule.deliveryType,
    configured: rule.deliveryType === "text" ? Boolean(rule.deliveryContent) : rule.deliveryType === "api" ? Boolean(rule.apiConfig) : pool.some((item) => item.status === "available"),
    enabled: rule.enabled,
    lowStockThreshold: rule.lowStockThreshold,
    inventory: {
      available: countBy(pool, "status", "available"),
      reserved: countBy(pool, "status", "reserved"),
      used: countBy(pool, "status", "used"),
    },
  };
}

function sanitizeExposedRule(row: JsonObject, includeFixedText: boolean) {
  const type = String(row.deliveryType || "text");
  const content = String(row.deliveryContent || "");
  const configured = type === "inventory" ? Number(row.available || 0) > 0 : type === "api" ? Boolean(row.apiConfig && Object.keys(row.apiConfig as JsonObject).length) : Boolean(content);
  return {
    id: row.id ?? null,
    productId: Number(row.productId),
    title: String(row.title || ""),
    xianyuItemId: row.xianyuItemId ?? null,
    productStatus: row.productStatus,
    specKey: String(row.specKey || ""),
    specLabel: String(row.specLabel || "默认规则"),
    deliveryType: type,
    configured,
    enabled: row.enabled !== false,
    fixedText: type === "text" && includeFixedText ? content : undefined,
    fixedTextPreview: type === "text" && content ? `${content.slice(0, 80)}${content.length > 80 ? "…" : ""}` : "",
    api: type === "api" ? redactApiConfig(row.apiConfig) : undefined,
    inventory: {
      available: Number(row.available || 0),
      reserved: Number(row.reserved || 0),
      used: Number(row.used || 0),
    },
    lowStockThreshold: Number(row.lowStockThreshold || 0),
  };
}

function redactApiConfig(value: unknown) {
  const config = value && typeof value === "object" && !Array.isArray(value) ? (value as JsonObject) : {};
  return {
    url: config.url || config.endpoint || null,
    method: config.method || "POST",
    configured: Object.keys(config).length > 0,
    credentials: Object.keys(config).some((key) => /token|secret|authorization|api.?key/i.test(key)) ? "已配置（已隐藏）" : "未检测到",
  };
}

function parseJson(value: string) {
  try {
    return JSON.parse(value);
  } catch {
    return [];
  }
}

function countBy<T extends Record<string, unknown>>(rows: T[], key: keyof T, value: unknown) {
  return rows.filter((row) => row[key] === value).length;
}

function decodeImage(value: string, fallbackMimeType: string) {
  const match = value.match(/^data:(image\/(?:png|jpeg|webp));base64,(.+)$/s);
  const mimeType = match?.[1] || fallbackMimeType;
  const encoded = (match?.[2] || value).replace(/\s+/g, "");
  let binary: string;
  try {
    binary = atob(encoded);
  } catch {
    throw new Error("图片 Base64 格式不正确");
  }
  if (binary.length > 8 * 1024 * 1024) throw new Error("单张图片不能超过 8 MiB");
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return { bytes, mimeType };
}
