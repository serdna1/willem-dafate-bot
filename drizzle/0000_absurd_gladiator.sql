CREATE TABLE "adventures" (
	"id" serial PRIMARY KEY NOT NULL,
	"guild_id" text NOT NULL,
	"name" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "characters" (
	"id" serial PRIMARY KEY NOT NULL,
	"guild_id" text NOT NULL,
	"adventure_id" integer,
	"name" text NOT NULL,
	"description" text,
	"refresh" integer DEFAULT 3,
	"high_concept" text,
	"trouble" text,
	"aspects" jsonb DEFAULT '[]'::jsonb,
	"skills" jsonb DEFAULT '{}'::jsonb,
	"stunts" text,
	"extras" text,
	"physical_stress" integer DEFAULT 0,
	"mental_stress" integer DEFAULT 0,
	"consequences" jsonb DEFAULT '{"mild":"","moderate":"","severe":""}'::jsonb
);
--> statement-breakpoint
ALTER TABLE "characters" ADD CONSTRAINT "characters_adventure_id_adventures_id_fk" FOREIGN KEY ("adventure_id") REFERENCES "public"."adventures"("id") ON DELETE no action ON UPDATE no action;