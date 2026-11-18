-- Kubernetes deployment engine (certu fork).
--
-- Hand-edited to be idempotent. Instances deployed from the v0.29.2-based
-- fork already applied the same schema as 0166_giant_northstar,
-- 0167_rare_captain_britain and 0168_long_corsair, which collided with
-- upstream's 0166-0168. Drizzle skips any migration whose journal timestamp
-- is older than the newest applied one, so on those instances upstream's
-- 0166_nosy_slapstick (2026-05-09) never runs, and everything below except the
-- schedule backfill already exists. Fresh installs run all of it.
DO $$ BEGIN
	CREATE TYPE "public"."deploymentEngine" AS ENUM('docker', 'kubernetes');
EXCEPTION
	WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "kubernetes_cluster" (
	"kubernetesId" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"kubeconfig" text NOT NULL,
	"context" text,
	"defaultNamespacePrefix" text DEFAULT 'dokploy' NOT NULL,
	"ingressClassName" text DEFAULT 'nginx' NOT NULL,
	"tlsIssuerName" text,
	"defaultRegistryId" text,
	"createdAt" text NOT NULL,
	"organizationId" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "application" ADD COLUMN IF NOT EXISTS "deploymentEngine" "deploymentEngine" DEFAULT 'docker' NOT NULL;--> statement-breakpoint
ALTER TABLE "mariadb" ADD COLUMN IF NOT EXISTS "deploymentEngine" "deploymentEngine" DEFAULT 'docker' NOT NULL;--> statement-breakpoint
ALTER TABLE "mongo" ADD COLUMN IF NOT EXISTS "deploymentEngine" "deploymentEngine" DEFAULT 'docker' NOT NULL;--> statement-breakpoint
ALTER TABLE "mysql" ADD COLUMN IF NOT EXISTS "deploymentEngine" "deploymentEngine" DEFAULT 'docker' NOT NULL;--> statement-breakpoint
ALTER TABLE "postgres" ADD COLUMN IF NOT EXISTS "deploymentEngine" "deploymentEngine" DEFAULT 'docker' NOT NULL;--> statement-breakpoint
ALTER TABLE "project" ADD COLUMN IF NOT EXISTS "kubernetesNamespace" text;--> statement-breakpoint
ALTER TABLE "project" ADD COLUMN IF NOT EXISTS "kubernetesId" text;--> statement-breakpoint
ALTER TABLE "redis" ADD COLUMN IF NOT EXISTS "deploymentEngine" "deploymentEngine" DEFAULT 'docker' NOT NULL;--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "kubernetes_cluster" ADD CONSTRAINT "kubernetes_cluster_defaultRegistryId_registry_registryId_fk" FOREIGN KEY ("defaultRegistryId") REFERENCES "public"."registry"("registryId") ON DELETE set null ON UPDATE no action;
EXCEPTION
	WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "kubernetes_cluster" ADD CONSTRAINT "kubernetes_cluster_organizationId_organization_id_fk" FOREIGN KEY ("organizationId") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
	WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "project" ADD CONSTRAINT "project_kubernetesId_kubernetes_cluster_kubernetesId_fk" FOREIGN KEY ("kubernetesId") REFERENCES "public"."kubernetes_cluster"("kubernetesId") ON DELETE set null ON UPDATE no action;
EXCEPTION
	WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
-- Upstream 0166_nosy_slapstick; skipped on fork instances (see above).
ALTER TABLE "schedule" ADD COLUMN IF NOT EXISTS "description" text;
