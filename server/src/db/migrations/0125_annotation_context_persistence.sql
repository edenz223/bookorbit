CREATE TABLE "annotation_context_files" (
	"book_file_id" integer PRIMARY KEY NOT NULL,
	"fingerprint" varchar(64),
	"checked_at" timestamp with time zone,
	"next_check_at" timestamp with time zone DEFAULT now() NOT NULL,
	"invalidation_pending" boolean DEFAULT false NOT NULL,
	"annotation_cursor" integer DEFAULT 0 NOT NULL,
	"lease_token" uuid,
	"lease_expires_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "annotation_context_maintenance" (
	"name" varchar(32) PRIMARY KEY NOT NULL,
	"cursor" integer DEFAULT 0 NOT NULL,
	"upper_bound" integer,
	"algorithm_version" integer DEFAULT 1 NOT NULL,
	"lease_token" uuid,
	"lease_expires_at" timestamp with time zone,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "annotation_contexts" (
	"annotation_id" integer PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"book_file_id" integer,
	"input_fingerprint" varchar(32),
	"algorithm_version" integer DEFAULT 1 NOT NULL,
	"status" varchar(16) DEFAULT 'pending' NOT NULL,
	"before" text,
	"after" text,
	"reason" varchar(64),
	"priority" integer DEFAULT 50 NOT NULL,
	"generation" integer DEFAULT 1 NOT NULL,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"available_at" timestamp with time zone DEFAULT now(),
	"lease_token" uuid,
	"lease_expires_at" timestamp with time zone,
	"generated_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "annotation_contexts_status_chk" CHECK ("annotation_contexts"."status" in ('pending', 'processing', 'ready', 'unavailable', 'failed'))
);
--> statement-breakpoint
ALTER TABLE "annotation_context_files" ADD CONSTRAINT "annotation_context_files_book_file_id_book_files_id_fk" FOREIGN KEY ("book_file_id") REFERENCES "public"."book_files"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "annotation_contexts" ADD CONSTRAINT "annotation_contexts_annotation_id_annotations_id_fk" FOREIGN KEY ("annotation_id") REFERENCES "public"."annotations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "annotation_contexts" ADD CONSTRAINT "annotation_contexts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "annotation_contexts" ADD CONSTRAINT "annotation_contexts_book_file_id_book_files_id_fk" FOREIGN KEY ("book_file_id") REFERENCES "public"."book_files"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "annotation_context_files_due_idx" ON "annotation_context_files" USING btree ("next_check_at","book_file_id");--> statement-breakpoint
CREATE INDEX "annotation_contexts_user_page_idx" ON "annotation_contexts" USING btree ("user_id","annotation_id");--> statement-breakpoint
CREATE INDEX "annotation_contexts_pending_idx" ON "annotation_contexts" USING btree ("priority" DESC NULLS LAST,"available_at","annotation_id") WHERE "annotation_contexts"."status" in ('pending', 'failed') and "annotation_contexts"."available_at" is not null;--> statement-breakpoint
CREATE INDEX "annotation_contexts_lease_idx" ON "annotation_contexts" USING btree ("lease_expires_at") WHERE "annotation_contexts"."status" = 'processing';--> statement-breakpoint
CREATE INDEX "annotation_contexts_file_idx" ON "annotation_contexts" USING btree ("book_file_id","annotation_id");