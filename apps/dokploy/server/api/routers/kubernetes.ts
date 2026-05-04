import {
	createKubernetesCluster,
	deleteKubernetesCluster,
	findKubernetesClusterById,
	findKubernetesClustersByOrganization,
	testKubernetesConnection,
	updateKubernetesClusterById,
} from "@dokploy/server";
import {
	apiCreateKubernetesCluster,
	apiFindOneKubernetesCluster,
	apiRemoveKubernetesCluster,
	apiTestKubernetesConnection,
	apiUpdateKubernetesCluster,
} from "@dokploy/server/db/schema";
import { TRPCError } from "@trpc/server";
import {
	createTRPCRouter,
	protectedProcedure,
	withPermission,
} from "@/server/api/trpc";

export const kubernetesRouter = createTRPCRouter({
	create: withPermission("kubernetes", "create")
		.input(apiCreateKubernetesCluster)
		.mutation(async ({ ctx, input }) => {
			return createKubernetesCluster(input, ctx.session.activeOrganizationId);
		}),

	one: withPermission("kubernetes", "read")
		.input(apiFindOneKubernetesCluster)
		.query(async ({ ctx, input }) => {
			const cluster = await findKubernetesClusterById(input.kubernetesId);
			if (cluster.organizationId !== ctx.session.activeOrganizationId) {
				throw new TRPCError({ code: "FORBIDDEN" });
			}
			return cluster;
		}),

	all: protectedProcedure.query(async ({ ctx }) =>
		findKubernetesClustersByOrganization(ctx.session.activeOrganizationId),
	),

	update: withPermission("kubernetes", "update")
		.input(apiUpdateKubernetesCluster)
		.mutation(async ({ ctx, input }) => {
			const existing = await findKubernetesClusterById(input.kubernetesId);
			if (existing.organizationId !== ctx.session.activeOrganizationId) {
				throw new TRPCError({ code: "FORBIDDEN" });
			}
			return updateKubernetesClusterById(input);
		}),

	delete: withPermission("kubernetes", "delete")
		.input(apiRemoveKubernetesCluster)
		.mutation(async ({ ctx, input }) => {
			const existing = await findKubernetesClusterById(input.kubernetesId);
			if (existing.organizationId !== ctx.session.activeOrganizationId) {
				throw new TRPCError({ code: "FORBIDDEN" });
			}
			await deleteKubernetesCluster(input.kubernetesId);
			return { ok: true };
		}),

	testConnection: withPermission("kubernetes", "read")
		.input(apiTestKubernetesConnection)
		.mutation(async ({ ctx, input }) => {
			let kubeconfig = input.kubeconfig;
			let context = input.context ?? null;
			let ingressClassName: string | null = null;
			if (input.kubernetesId) {
				const cluster = await findKubernetesClusterById(input.kubernetesId);
				if (cluster.organizationId !== ctx.session.activeOrganizationId) {
					throw new TRPCError({ code: "FORBIDDEN" });
				}
				kubeconfig = cluster.kubeconfig;
				context = cluster.context ?? null;
				ingressClassName = cluster.ingressClassName;
			}
			if (!kubeconfig) {
				throw new TRPCError({
					code: "BAD_REQUEST",
					message: "kubeconfig is required",
				});
			}
			return testKubernetesConnection({
				kubeconfig,
				context,
				ingressClassName,
			});
		}),
});
