ALTER TABLE "application" DROP CONSTRAINT "application_kubernetesId_kubernetes_cluster_kubernetesId_fk";
--> statement-breakpoint
ALTER TABLE "project" ADD COLUMN "kubernetesId" text;--> statement-breakpoint
ALTER TABLE "project" ADD CONSTRAINT "project_kubernetesId_kubernetes_cluster_kubernetesId_fk" FOREIGN KEY ("kubernetesId") REFERENCES "public"."kubernetes_cluster"("kubernetesId") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "application" DROP COLUMN "kubernetesId";