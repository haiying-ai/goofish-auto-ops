CREATE TABLE `inventory` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`product_id` integer NOT NULL,
	`secret` text NOT NULL,
	`status` text DEFAULT 'available' NOT NULL,
	`order_id` text,
	`delivered_at` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE TABLE `job_runs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`job` text NOT NULL,
	`status` text NOT NULL,
	`summary` text DEFAULT '{}' NOT NULL,
	`started_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`finished_at` text
);
--> statement-breakpoint
CREATE TABLE `orders` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`xianyu_order_id` text NOT NULL,
	`product_id` integer,
	`buyer_id` text,
	`status` text DEFAULT 'pending' NOT NULL,
	`delivery_content` text,
	`attempts` integer DEFAULT 0 NOT NULL,
	`last_error` text,
	`delivered_at` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `orders_xianyu_order_id_uq` ON `orders` (`xianyu_order_id`);--> statement-breakpoint
CREATE TABLE `products` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`title` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`price_cents` integer NOT NULL,
	`images_json` text DEFAULT '[]' NOT NULL,
	`delivery_type` text DEFAULT 'text' NOT NULL,
	`delivery_content` text DEFAULT '' NOT NULL,
	`status` text DEFAULT 'queued' NOT NULL,
	`xianyu_item_id` text,
	`last_error` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE TABLE `settings` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
