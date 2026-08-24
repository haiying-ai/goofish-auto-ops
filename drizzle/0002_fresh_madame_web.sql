ALTER TABLE `orders` ADD `xianyu_item_id` text;--> statement-breakpoint
ALTER TABLE `orders` ADD `buyer_nick` text;--> statement-breakpoint
ALTER TABLE `orders` ADD `quantity` integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE `orders` ADD `raw_status` text;--> statement-breakpoint
ALTER TABLE `orders` ADD `message_sent_at` text;--> statement-breakpoint
ALTER TABLE `orders` ADD `shipment_confirmed_at` text;--> statement-breakpoint
ALTER TABLE `orders` ADD `alerted_at` text;--> statement-breakpoint
ALTER TABLE `orders` ADD `alert_reason` text;--> statement-breakpoint
ALTER TABLE `products` ADD `original_price_cents` integer;--> statement-breakpoint
ALTER TABLE `products` ADD `quantity` integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE `products` ADD `shipping_mode` text DEFAULT 'none' NOT NULL;--> statement-breakpoint
ALTER TABLE `products` ADD `shipping_fee_cents` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `products` ADD `self_pickup` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `products` ADD `category_mode` text DEFAULT 'auto' NOT NULL;--> statement-breakpoint
ALTER TABLE `products` ADD `category_id` text;--> statement-breakpoint
ALTER TABLE `products` ADD `category_name` text;--> statement-breakpoint
ALTER TABLE `products` ADD `sku_json` text DEFAULT '[]' NOT NULL;--> statement-breakpoint
ALTER TABLE `products` ADD `properties_json` text DEFAULT '[]' NOT NULL;