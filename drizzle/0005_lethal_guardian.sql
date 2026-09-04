CREATE TABLE `image_upload_chunks` (
	`upload_id` text NOT NULL,
	`part_number` integer NOT NULL,
	`data_base64` text NOT NULL,
	`size_bytes` integer NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	PRIMARY KEY(`upload_id`, `part_number`),
	FOREIGN KEY (`upload_id`) REFERENCES `image_uploads`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `image_upload_chunks_upload_idx` ON `image_upload_chunks` (`upload_id`,`part_number`);--> statement-breakpoint
CREATE TABLE `image_uploads` (
	`id` text PRIMARY KEY NOT NULL,
	`filename` text NOT NULL,
	`mime_type` text NOT NULL,
	`expected_bytes` integer NOT NULL,
	`received_bytes` integer DEFAULT 0 NOT NULL,
	`expected_sha256` text,
	`next_part` integer DEFAULT 0 NOT NULL,
	`status` text DEFAULT 'receiving' NOT NULL,
	`uploaded_url` text,
	`width` integer,
	`height` integer,
	`last_error` text,
	`expires_at` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE INDEX `image_uploads_expiry_idx` ON `image_uploads` (`expires_at`);--> statement-breakpoint
CREATE INDEX `image_uploads_status_idx` ON `image_uploads` (`status`,`updated_at`);