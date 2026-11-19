-- Gateway API routing for Kubernetes clusters (certu fork). Idempotent like
-- 0203, so a fork rebase that renumbers it can re-run it safely.
ALTER TABLE "kubernetes_cluster" ADD COLUMN IF NOT EXISTS "routingMode" text DEFAULT 'ingress' NOT NULL;--> statement-breakpoint
ALTER TABLE "kubernetes_cluster" ADD COLUMN IF NOT EXISTS "gatewayName" text;--> statement-breakpoint
ALTER TABLE "kubernetes_cluster" ADD COLUMN IF NOT EXISTS "gatewayNamespace" text;
