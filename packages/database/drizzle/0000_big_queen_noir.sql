CREATE TABLE "devices" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"device_identifier" varchar(255) NOT NULL,
	"name" varchar(255) NOT NULL,
	"platform" varchar(50) NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_revalidated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"offline_auth_window_days" integer DEFAULT 7 NOT NULL,
	"is_revoked" boolean DEFAULT false NOT NULL,
	"revoked_at" timestamp with time zone,
	"revoked_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "devices_device_identifier_unique" UNIQUE("device_identifier")
);
--> statement-breakpoint
CREATE TABLE "inspections" (
	"id" uuid PRIMARY KEY NOT NULL,
	"site_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"device_id" uuid NOT NULL,
	"title" varchar(255) NOT NULL,
	"status" varchar(50) DEFAULT 'DRAFT' NOT NULL,
	"scheduled_date" timestamp with time zone,
	"completed_date" timestamp with time zone,
	"notes" text,
	"version" integer DEFAULT 1 NOT NULL,
	"is_deleted" boolean DEFAULT false NOT NULL,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "measurements" (
	"id" uuid PRIMARY KEY NOT NULL,
	"inspection_id" uuid NOT NULL,
	"metric_type" varchar(50) NOT NULL,
	"numeric_value" double precision,
	"stringValue" text,
	"unit" varchar(50) NOT NULL,
	"gps" jsonb,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"notes" text,
	"version" integer DEFAULT 1 NOT NULL,
	"is_deleted" boolean DEFAULT false NOT NULL,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "projects" (
	"id" uuid PRIMARY KEY NOT NULL,
	"name" varchar(255) NOT NULL,
	"code" varchar(50) NOT NULL,
	"description" text,
	"status" varchar(50) DEFAULT 'ACTIVE' NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"is_deleted" boolean DEFAULT false NOT NULL,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "projects_code_unique" UNIQUE("code")
);
--> statement-breakpoint
CREATE TABLE "sites" (
	"id" uuid PRIMARY KEY NOT NULL,
	"project_id" uuid NOT NULL,
	"name" varchar(255) NOT NULL,
	"code" varchar(50) NOT NULL,
	"gps" jsonb,
	"description" text,
	"version" integer DEFAULT 1 NOT NULL,
	"is_deleted" boolean DEFAULT false NOT NULL,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY NOT NULL,
	"email" varchar(255) NOT NULL,
	"name" varchar(255) NOT NULL,
	"role" varchar(50) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "change_log" (
	"sequence" bigserial PRIMARY KEY NOT NULL,
	"entity_type" varchar(50) NOT NULL,
	"entity_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"operation_type" varchar(50) NOT NULL,
	"payload" jsonb NOT NULL,
	"is_tombstone" boolean DEFAULT false NOT NULL,
	"changed_by_user_id" uuid NOT NULL,
	"changed_by_device_id" uuid NOT NULL,
	"operation_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "conflicts" (
	"conflict_id" uuid PRIMARY KEY NOT NULL,
	"entity_type" varchar(50) NOT NULL,
	"entity_id" uuid NOT NULL,
	"operation_id" uuid NOT NULL,
	"conflict_type" varchar(50) NOT NULL,
	"server_version" integer NOT NULL,
	"client_version" integer NOT NULL,
	"server_state" jsonb,
	"client_state" jsonb NOT NULL,
	"status" varchar(50) DEFAULT 'PENDING' NOT NULL,
	"resolution" varchar(50),
	"resolved_at" timestamp with time zone,
	"resolved_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "conflict_edit_delete_invariant_check" CHECK (conflict_type != 'EDIT_DELETE' OR (resolution = 'KEEP_SERVER' AND status = 'RESOLVED' AND resolved_by_user_id IS NULL))
);
--> statement-breakpoint
CREATE TABLE "idempotency_records" (
	"operation_id" uuid PRIMARY KEY NOT NULL,
	"entity_type" varchar(50) NOT NULL,
	"entity_id" uuid NOT NULL,
	"applied_sequence" bigint,
	"status" varchar(50) NOT NULL,
	"response_payload" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sync_attempts" (
	"attempt_id" uuid PRIMARY KEY NOT NULL,
	"device_id" uuid NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	"status" varchar(50) NOT NULL,
	"operations_pushed" integer DEFAULT 0 NOT NULL,
	"operations_applied" integer DEFAULT 0 NOT NULL,
	"operations_rejected" integer DEFAULT 0 NOT NULL,
	"conflicts_encountered" integer DEFAULT 0 NOT NULL,
	"changes_pulled" integer DEFAULT 0 NOT NULL,
	"cursor_before" bigint DEFAULT 0 NOT NULL,
	"cursor_after" bigint DEFAULT 0 NOT NULL,
	"error_summary" text
);
--> statement-breakpoint
CREATE TABLE "sync_cursors" (
	"device_id" uuid NOT NULL,
	"scope" varchar(100) DEFAULT 'default' NOT NULL,
	"last_server_sequence" bigint DEFAULT 0 NOT NULL,
	"last_sync_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sync_cursors_device_id_scope_pk" PRIMARY KEY("device_id","scope")
);
--> statement-breakpoint
ALTER TABLE "devices" ADD CONSTRAINT "devices_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inspections" ADD CONSTRAINT "inspections_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inspections" ADD CONSTRAINT "inspections_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inspections" ADD CONSTRAINT "inspections_device_id_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."devices"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "measurements" ADD CONSTRAINT "measurements_inspection_id_inspections_id_fk" FOREIGN KEY ("inspection_id") REFERENCES "public"."inspections"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sites" ADD CONSTRAINT "sites_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "devices_user_id_idx" ON "devices" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "devices_is_revoked_idx" ON "devices" USING btree ("is_revoked");--> statement-breakpoint
CREATE INDEX "inspections_site_id_idx" ON "inspections" USING btree ("site_id");--> statement-breakpoint
CREATE INDEX "inspections_user_id_idx" ON "inspections" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "inspections_is_deleted_idx" ON "inspections" USING btree ("is_deleted");--> statement-breakpoint
CREATE INDEX "measurements_inspection_id_idx" ON "measurements" USING btree ("inspection_id");--> statement-breakpoint
CREATE INDEX "measurements_metric_type_idx" ON "measurements" USING btree ("metric_type");--> statement-breakpoint
CREATE INDEX "measurements_is_deleted_idx" ON "measurements" USING btree ("is_deleted");--> statement-breakpoint
CREATE INDEX "projects_code_idx" ON "projects" USING btree ("code");--> statement-breakpoint
CREATE INDEX "projects_is_deleted_idx" ON "projects" USING btree ("is_deleted");--> statement-breakpoint
CREATE INDEX "sites_project_id_idx" ON "sites" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "sites_is_deleted_idx" ON "sites" USING btree ("is_deleted");--> statement-breakpoint
CREATE INDEX "change_log_sequence_idx" ON "change_log" USING btree ("sequence");--> statement-breakpoint
CREATE INDEX "change_log_entity_idx" ON "change_log" USING btree ("entity_type","entity_id");--> statement-breakpoint
CREATE INDEX "change_log_operation_id_idx" ON "change_log" USING btree ("operation_id");--> statement-breakpoint
CREATE INDEX "conflicts_entity_idx" ON "conflicts" USING btree ("entity_type","entity_id");--> statement-breakpoint
CREATE INDEX "conflicts_status_idx" ON "conflicts" USING btree ("status");--> statement-breakpoint
CREATE INDEX "conflicts_type_idx" ON "conflicts" USING btree ("conflict_type");--> statement-breakpoint
CREATE INDEX "conflicts_entity_status_idx" ON "conflicts" USING btree ("entity_type","entity_id","status");--> statement-breakpoint
CREATE INDEX "idempotency_entity_idx" ON "idempotency_records" USING btree ("entity_type","entity_id");--> statement-breakpoint
CREATE INDEX "sync_attempts_device_idx" ON "sync_attempts" USING btree ("device_id");--> statement-breakpoint
CREATE INDEX "sync_attempts_status_idx" ON "sync_attempts" USING btree ("status");