CREATE TABLE `automation_runs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`trigger_key` text NOT NULL,
	`order_id` integer NOT NULL,
	`product_id` integer,
	`rule_id` integer,
	`status` text DEFAULT 'pending' NOT NULL,
	`current_step` text DEFAULT '' NOT NULL,
	`last_error` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`finished_at` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `automation_runs_trigger_key_uq` ON `automation_runs` (`trigger_key`);--> statement-breakpoint
CREATE INDEX `automation_runs_order_idx` ON `automation_runs` (`order_id`,`updated_at`);--> statement-breakpoint
CREATE TABLE `automation_steps` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`run_id` integer NOT NULL,
	`step_key` text NOT NULL,
	`action_type` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`output` text DEFAULT '' NOT NULL,
	`last_error` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`finished_at` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `automation_steps_run_step_uq` ON `automation_steps` (`run_id`,`step_key`);--> statement-breakpoint
CREATE INDEX `automation_steps_status_idx` ON `automation_steps` (`status`,`updated_at`);--> statement-breakpoint
CREATE TABLE `delivery_rules` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`product_id` integer NOT NULL,
	`spec_key` text DEFAULT '' NOT NULL,
	`spec_label` text DEFAULT '' NOT NULL,
	`delivery_type` text DEFAULT 'text' NOT NULL,
	`delivery_content` text DEFAULT '' NOT NULL,
	`api_config` text DEFAULT '' NOT NULL,
	`low_stock_threshold` integer DEFAULT 3 NOT NULL,
	`last_low_stock_level` integer,
	`enabled` integer DEFAULT true NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `delivery_rules_product_spec_uq` ON `delivery_rules` (`product_id`,`spec_key`);--> statement-breakpoint
CREATE INDEX `delivery_rules_enabled_idx` ON `delivery_rules` (`product_id`,`enabled`);--> statement-breakpoint
ALTER TABLE `inventory` ADD `rule_id` integer;--> statement-breakpoint
ALTER TABLE `inventory` ADD `secret_hash` text;--> statement-breakpoint
CREATE INDEX `inventory_rule_status_idx` ON `inventory` (`rule_id`,`status`);--> statement-breakpoint
ALTER TABLE `orders` ADD `rule_id` integer;--> statement-breakpoint
ALTER TABLE `orders` ADD `item_title` text;--> statement-breakpoint
ALTER TABLE `orders` ADD `spec_key` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `orders` ADD `spec_text` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `orders` ADD `delivery_type` text;--> statement-breakpoint
ALTER TABLE `orders` ADD `failure_alerted_at` text;--> statement-breakpoint
ALTER TABLE `orders` ADD `manual_note` text;