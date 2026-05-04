import { TRPCError } from "@trpc/server";
import { findKubernetesClusterById } from "../../services/kubernetes";
import type { InferResultType } from "../../types/with";
import { getRegistryTag } from "../cluster/upload";
import { getKubernetesClient } from "./client";
import { applyDeployment, waitForRollout } from "./deployment";
import { manageIngress } from "./ingress";
import { ensureNamespace } from "./namespace";
import { applyImagePullSecret } from "./secrets";
import { applyService } from "./service";

export type ApplicationForK8s = InferResultType<
	"applications",
	{
		mounts: true;
		security: true;
		redirects: true;
		ports: true;
		registry: true;
		buildRegistry: true;
		rollbackRegistry: true;
		deployments: true;
		domains: true;
		environment: { with: { project: true } };
	}
>;

export const orchestrateKubernetesDeploy = async ({
	application,
}: {
	application: ApplicationForK8s;
}): Promise<void> => {
	if (!application.kubernetesId) {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message:
				"Kubernetes engine selected but no cluster is bound to this application.",
		});
	}
	if (!application.registry) {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message:
				"Kubernetes deployments require a container registry. Set the application's registry before deploying.",
		});
	}

	const cluster = await findKubernetesClusterById(application.kubernetesId);
	const client = await getKubernetesClient(application.kubernetesId);
	const namespace = await ensureNamespace(
		client,
		{
			projectId: application.environment.project.projectId,
			name: application.environment.project.name,
			kubernetesNamespace:
				application.environment.project.kubernetesNamespace ?? null,
		},
		cluster.defaultNamespacePrefix,
	);

	await applyImagePullSecret(client, namespace, application.registry);

	const image = getRegistryTag(
		application.registry,
		`${application.appName}:latest`,
	);
	const { appName } = await applyDeployment(
		client,
		application,
		image,
		namespace,
	);
	await applyService(client, application, namespace);

	for (const domain of application.domains ?? []) {
		await manageIngress(client, application, domain, namespace, {
			ingressClassName: cluster.ingressClassName,
			tlsIssuerName: cluster.tlsIssuerName,
		});
	}

	const rollout = await waitForRollout(client, appName, namespace);
	if (!rollout.ready) {
		throw new TRPCError({
			code: "INTERNAL_SERVER_ERROR",
			message:
				rollout.message ?? "Kubernetes rollout did not complete in time.",
		});
	}
};
