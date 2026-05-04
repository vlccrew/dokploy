import { relations } from "drizzle-orm";
import { pgTable, text } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { nanoid } from "nanoid";
import { z } from "zod";
import { organization } from "./account";
import { applications } from "./application";
import { registry } from "./registry";

export const kubernetesClusters = pgTable("kubernetes_cluster", {
	kubernetesId: text("kubernetesId")
		.notNull()
		.primaryKey()
		.$defaultFn(() => nanoid()),
	name: text("name").notNull(),
	description: text("description"),
	kubeconfig: text("kubeconfig").notNull(),
	context: text("context"),
	defaultNamespacePrefix: text("defaultNamespacePrefix")
		.notNull()
		.default("dokploy"),
	ingressClassName: text("ingressClassName").notNull().default("nginx"),
	tlsIssuerName: text("tlsIssuerName"),
	defaultRegistryId: text("defaultRegistryId").references(
		() => registry.registryId,
		{ onDelete: "set null" },
	),
	createdAt: text("createdAt")
		.notNull()
		.$defaultFn(() => new Date().toISOString()),
	organizationId: text("organizationId")
		.notNull()
		.references(() => organization.id, { onDelete: "cascade" }),
});

export const kubernetesClustersRelations = relations(
	kubernetesClusters,
	({ one, many }) => ({
		organization: one(organization, {
			fields: [kubernetesClusters.organizationId],
			references: [organization.id],
		}),
		defaultRegistry: one(registry, {
			fields: [kubernetesClusters.defaultRegistryId],
			references: [registry.registryId],
			relationName: "kubernetesClusterDefaultRegistry",
		}),
		applications: many(applications, {
			relationName: "applicationKubernetesCluster",
		}),
	}),
);

const createSchema = createInsertSchema(kubernetesClusters, {
	kubernetesId: z.string().min(1),
	name: z.string().min(1),
	description: z.string().optional(),
	kubeconfig: z.string().min(1, "kubeconfig is required"),
	context: z.string().optional(),
	defaultNamespacePrefix: z
		.string()
		.regex(
			/^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/,
			"Must be a valid Kubernetes name (lowercase alphanumeric + dashes)",
		)
		.optional(),
	ingressClassName: z.string().min(1).optional(),
	tlsIssuerName: z.string().optional().nullable(),
	defaultRegistryId: z.string().optional().nullable(),
});

export const apiCreateKubernetesCluster = createSchema
	.pick({
		name: true,
		description: true,
		kubeconfig: true,
		context: true,
		defaultNamespacePrefix: true,
		ingressClassName: true,
		tlsIssuerName: true,
		defaultRegistryId: true,
	})
	.required({ name: true, kubeconfig: true });

export const apiUpdateKubernetesCluster = createSchema
	.partial()
	.extend({ kubernetesId: z.string().min(1) });

export const apiFindOneKubernetesCluster = z.object({
	kubernetesId: z.string().min(1),
});

export const apiRemoveKubernetesCluster = z.object({
	kubernetesId: z.string().min(1),
});

export const apiTestKubernetesConnection = z.object({
	kubernetesId: z.string().min(1).optional(),
	kubeconfig: z.string().min(1).optional(),
	context: z.string().optional(),
});
