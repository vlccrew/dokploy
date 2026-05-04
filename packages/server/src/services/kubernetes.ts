import { TRPCError } from "@trpc/server";
import { eq } from "drizzle-orm";
import type { z } from "zod";
import { db } from "../db";
import {
	type apiCreateKubernetesCluster,
	type apiUpdateKubernetesCluster,
	kubernetesClusters,
} from "../db/schema";
import {
	buildKubeConfigFromString,
	buildKubernetesClient,
} from "../utils/kubernetes/client";
import { isHttpError } from "../utils/kubernetes/errors";

export type KubernetesCluster = typeof kubernetesClusters.$inferSelect;

export const createKubernetesCluster = async (
	input: z.infer<typeof apiCreateKubernetesCluster>,
	organizationId: string,
): Promise<KubernetesCluster> => {
	const created = await db
		.insert(kubernetesClusters)
		.values({
			...input,
			organizationId,
			createdAt: new Date().toISOString(),
		} as typeof kubernetesClusters.$inferInsert)
		.returning()
		.then((rows) => rows[0]);

	if (!created) {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message: "Error creating the kubernetes cluster",
		});
	}
	return created;
};

export const findKubernetesClusterById = async (
	kubernetesId: string,
): Promise<KubernetesCluster> => {
	const cluster = await db.query.kubernetesClusters.findFirst({
		where: eq(kubernetesClusters.kubernetesId, kubernetesId),
	});
	if (!cluster) {
		throw new TRPCError({
			code: "NOT_FOUND",
			message: "Kubernetes cluster not found",
		});
	}
	return cluster;
};

export const findKubernetesClustersByOrganization = async (
	organizationId: string,
): Promise<KubernetesCluster[]> => {
	return db.query.kubernetesClusters.findMany({
		where: eq(kubernetesClusters.organizationId, organizationId),
	});
};

export const updateKubernetesClusterById = async (
	input: z.infer<typeof apiUpdateKubernetesCluster>,
): Promise<KubernetesCluster> => {
	const { kubernetesId, ...rest } = input;
	const updated = await db
		.update(kubernetesClusters)
		.set(rest)
		.where(eq(kubernetesClusters.kubernetesId, kubernetesId))
		.returning()
		.then((rows) => rows[0]);
	if (!updated) {
		throw new TRPCError({
			code: "NOT_FOUND",
			message: "Kubernetes cluster not found",
		});
	}
	return updated;
};

export const deleteKubernetesCluster = async (
	kubernetesId: string,
): Promise<void> => {
	await db
		.delete(kubernetesClusters)
		.where(eq(kubernetesClusters.kubernetesId, kubernetesId));
};

export interface KubernetesConnectionTest {
	ok: boolean;
	serverVersion?: string;
	platform?: string;
	nodes?: number;
	ingressClassPresent?: boolean;
	certManagerPresent?: boolean;
	error?: string;
}

export const testKubernetesConnection = async (params: {
	kubeconfig: string;
	context?: string | null;
	ingressClassName?: string | null;
}): Promise<KubernetesConnectionTest> => {
	try {
		const kc = buildKubeConfigFromString(params.kubeconfig, params.context);
		const client = buildKubernetesClient(kc);

		const versionInfo = await client.version.getCode();
		const nodes = await client.core.listNode();

		let ingressClassPresent = false;
		try {
			const ingressClass = params.ingressClassName ?? "nginx";
			const list = await client.networking.listIngressClass();
			ingressClassPresent = (list.items ?? []).some(
				(c) => c.metadata?.name === ingressClass,
			);
		} catch {
			ingressClassPresent = false;
		}

		let certManagerPresent = false;
		try {
			const deployments = await client.apps.listNamespacedDeployment({
				namespace: "cert-manager",
			});
			certManagerPresent = (deployments.items ?? []).some((d) =>
				d.metadata?.name?.startsWith("cert-manager"),
			);
		} catch (err) {
			if (!isHttpError(err) || err.code !== 404) {
				certManagerPresent = false;
			}
		}

		return {
			ok: true,
			serverVersion: versionInfo.gitVersion,
			platform: versionInfo.platform,
			nodes: nodes.items?.length ?? 0,
			ingressClassPresent,
			certManagerPresent,
		};
	} catch (err) {
		return {
			ok: false,
			error: err instanceof Error ? err.message : String(err),
		};
	}
};
