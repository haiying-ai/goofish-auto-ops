import { sql } from "drizzle-orm";
import {
  index,
  integer,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

export const products = sqliteTable("products", {
  id: integer("id").primaryKey({ autoIncrement: true }), title: text("title").notNull(),
  description: text("description").notNull().default(""), priceCents: integer("price_cents").notNull(),
  originalPriceCents: integer("original_price_cents"), quantity: integer("quantity").notNull().default(1),
  shippingMode: text("shipping_mode").notNull().default("none"), shippingFeeCents: integer("shipping_fee_cents").notNull().default(0),
  selfPickup: integer("self_pickup", { mode: "boolean" }).notNull().default(false),
  categoryMode: text("category_mode").notNull().default("auto"), categoryId: text("category_id"), categoryName: text("category_name"),
  skuJson: text("sku_json").notNull().default("[]"), propertiesJson: text("properties_json").notNull().default("[]"),
  imagesJson: text("images_json").notNull().default("[]"), deliveryType: text("delivery_type").notNull().default("text"),
  deliveryContent: text("delivery_content").notNull().default(""), status: text("status").notNull().default("queued"),
  xianyuItemId: text("xianyu_item_id"), lastError: text("last_error"),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`), updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [uniqueIndex("products_xianyu_item_id_uq").on(table.xianyuItemId)]);
export const inventory = sqliteTable("inventory", {
  id: integer("id").primaryKey({ autoIncrement: true }), productId: integer("product_id").notNull(), ruleId: integer("rule_id"), secret: text("secret").notNull(), secretHash: text("secret_hash"),
  status: text("status").notNull().default("available"), orderId: text("order_id"), deliveredAt: text("delivered_at"),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [index("inventory_rule_status_idx").on(table.ruleId, table.status)]);
export const orders = sqliteTable("orders", {
  id: integer("id").primaryKey({ autoIncrement: true }), xianyuOrderId: text("xianyu_order_id").notNull(), productId: integer("product_id"),
  ruleId: integer("rule_id"), xianyuItemId: text("xianyu_item_id"), itemTitle: text("item_title"), specKey: text("spec_key").notNull().default(""), specText: text("spec_text").notNull().default(""),
  buyerId: text("buyer_id"), buyerNick: text("buyer_nick"), quantity: integer("quantity").notNull().default(1),
  rawStatus: text("raw_status"), status: text("status").notNull().default("pending"), deliveryType: text("delivery_type"), deliveryContent: text("delivery_content"),
  attempts: integer("attempts").notNull().default(0), lastError: text("last_error"), deliveredAt: text("delivered_at"),
  messageSentAt: text("message_sent_at"), shipmentConfirmedAt: text("shipment_confirmed_at"),
  alertedAt: text("alerted_at"), failureAlertedAt: text("failure_alerted_at"), alertReason: text("alert_reason"), manualNote: text("manual_note"),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`), updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [uniqueIndex("orders_xianyu_order_id_uq").on(table.xianyuOrderId)]);

export const deliveryRules = sqliteTable("delivery_rules", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  productId: integer("product_id").notNull(),
  specKey: text("spec_key").notNull().default(""),
  specLabel: text("spec_label").notNull().default(""),
  deliveryType: text("delivery_type").notNull().default("text"),
  deliveryContent: text("delivery_content").notNull().default(""),
  apiConfig: text("api_config").notNull().default(""),
  lowStockThreshold: integer("low_stock_threshold").notNull().default(3),
  lastLowStockLevel: integer("last_low_stock_level"),
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [
  uniqueIndex("delivery_rules_product_spec_uq").on(table.productId, table.specKey),
  index("delivery_rules_enabled_idx").on(table.productId, table.enabled),
]);

export const automationRuns = sqliteTable("automation_runs", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  triggerKey: text("trigger_key").notNull(),
  orderId: integer("order_id").notNull(),
  productId: integer("product_id"),
  ruleId: integer("rule_id"),
  status: text("status").notNull().default("pending"),
  currentStep: text("current_step").notNull().default(""),
  lastError: text("last_error"),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  finishedAt: text("finished_at"),
}, (table) => [
  uniqueIndex("automation_runs_trigger_key_uq").on(table.triggerKey),
  index("automation_runs_order_idx").on(table.orderId, table.updatedAt),
]);

export const automationSteps = sqliteTable("automation_steps", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  runId: integer("run_id").notNull(),
  stepKey: text("step_key").notNull(),
  actionType: text("action_type").notNull(),
  status: text("status").notNull().default("pending"),
  attempts: integer("attempts").notNull().default(0),
  output: text("output").notNull().default(""),
  lastError: text("last_error"),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  finishedAt: text("finished_at"),
}, (table) => [
  uniqueIndex("automation_steps_run_step_uq").on(table.runId, table.stepKey),
  index("automation_steps_status_idx").on(table.status, table.updatedAt),
]);
export const jobRuns = sqliteTable("job_runs", {
  id: integer("id").primaryKey({ autoIncrement: true }), job: text("job").notNull(), status: text("status").notNull(),
  summary: text("summary").notNull().default("{}"), startedAt: text("started_at").notNull().default(sql`CURRENT_TIMESTAMP`), finishedAt: text("finished_at"),
});
export const settings = sqliteTable("settings", { key: text("key").primaryKey(), value: text("value").notNull(), updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`) });
