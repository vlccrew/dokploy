ALTER TABLE "mariadb" ADD COLUMN "deploymentEngine" "deploymentEngine" DEFAULT 'docker' NOT NULL;--> statement-breakpoint
ALTER TABLE "mongo" ADD COLUMN "deploymentEngine" "deploymentEngine" DEFAULT 'docker' NOT NULL;--> statement-breakpoint
ALTER TABLE "mysql" ADD COLUMN "deploymentEngine" "deploymentEngine" DEFAULT 'docker' NOT NULL;--> statement-breakpoint
ALTER TABLE "postgres" ADD COLUMN "deploymentEngine" "deploymentEngine" DEFAULT 'docker' NOT NULL;--> statement-breakpoint
ALTER TABLE "redis" ADD COLUMN "deploymentEngine" "deploymentEngine" DEFAULT 'docker' NOT NULL;