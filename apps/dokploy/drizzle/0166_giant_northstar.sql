CREATE TYPE "public"."deploymentEngine" AS ENUM('docker', 'kubernetes');--> statement-breakpoint
CREATE TABLE "kubernetes_cluster" (
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
ALTER TABLE "application" ADD COLUMN "deploymentEngine" "deploymentEngine" DEFAULT 'docker' NOT NULL;--> statement-breakpoint
ALTER TABLE "application" ADD COLUMN "kubernetesId" text;--> statement-breakpoint
ALTER TABLE "project" ADD COLUMN "kubernetesNamespace" text;--> statement-breakpoint
ALTER TABLE "kubernetes_cluster" ADD CONSTRAINT "kubernetes_cluster_defaultRegistryId_registry_registryId_fk" FOREIGN KEY ("defaultRegistryId") REFERENCES "public"."registry"("registryId") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kubernetes_cluster" ADD CONSTRAINT "kubernetes_cluster_organizationId_organization_id_fk" FOREIGN KEY ("organizationId") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "application" ADD CONSTRAINT "application_kubernetesId_kubernetes_cluster_kubernetesId_fk" FOREIGN KEY ("kubernetesId") REFERENCES "public"."kubernetes_cluster"("kubernetesId") ON DELETE set null ON UPDATE no action;