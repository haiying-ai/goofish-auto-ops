import { sql } from "drizzle-orm";
import { integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

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
  id: integer("id").primaryKey({ autoIncrement: true }), productId: integer("product_id").notNull(), secret: text("secret").notNull(),
  status: text("status").notNull().default("available"), orderId: text("order_id"), deliveredAt: text("delivered_at"),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});
export const orders = sqliteTable("orders", {
  id: integer("id").primaryKey({ autoIncrement: true }), xianyuOrderId: text("xianyu_order_id").notNull(), productId: integer("product_id"),
  xianyuItemId: text("xianyu_item_id"), buyerId: text("buyer_id"), buyerNick: text("buyer_nick"), quantity: integer("quantity").notNull().default(1),
  rawStatus: text("raw_status"), status: text("status").notNull().default("pending"), deliveryContent: text("delivery_content"),
  attempts: integer("attempts").notNull().default(0), lastError: text("last_error"), deliveredAt: text("delivered_at"),
  messageSentAt: text("message_sent_at"), shipmentConfirmedAt: text("shipment_confirmed_at"),
  alertedAt: text("alerted_at"), alertReason: text("alert_reason"),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`), updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [uniqueIndex("orders_xianyu_order_id_uq").on(table.xianyuOrderId)]);
export const jobRuns = sqliteTable("job_runs", {
  id: integer("id").primaryKey({ autoIncrement: true }), job: text("job").notNull(), status: text("status").notNull(),
  summary: text("summary").notNull().default("{}"), startedAt: text("started_at").notNull().default(sql`CURRENT_TIMESTAMP`), finishedAt: text("finished_at"),
});
export const settings = sqliteTable("settings", { key: text("key").primaryKey(), value: text("value").notNull(), updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`) });
