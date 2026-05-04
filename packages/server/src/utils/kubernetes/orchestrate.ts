import { appendFile } from "node:fs/promises";
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

const makeLogger = (logPath?: string) => async (line: string) => {
	const stamped = `[${new Date().toISOString()}] ${line}\n`;
	if (logPath) {
		try {
			await appendFile(logPath, stamped);
		} catch {
			// best-effort; never fail a deploy because of logging
		}
	}
};

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
	logPath,
}: {
	application: ApplicationForK8s;
	logPath?: string;
}): Promise<void> => {
	const log = makeLogger(logPath);
	await log("🚀 Starting Kubernetes deployment");

	const kubernetesId = application.environment.project.kubernetesId;
	if (!kubernetesId) {
		const msg =
			"Kubernetes engine selected but the project has no Kubernetes cluster bound. Set one on the project first.";
		await log(`❌ ${msg}`);
		throw new TRPCError({ code: "BAD_REQUEST", message: msg });
	}

	const isPrebuiltImage = application.sourceType === "docker";
	if (!isPrebuiltImage && !application.registry) {
		const msg =
			"Kubernetes deployments require a container registry to push built images. Set the application's registry before deploying.";
		await log(`❌ ${msg}`);
		throw new TRPCError({ code: "BAD_REQUEST", message: msg });
	}
	if (isPrebuiltImage && !application.dockerImage) {
		const msg = "sourceType=docker requires a dockerImage to be set.";
		await log(`❌ ${msg}`);
		throw new TRPCError({ code: "BAD_REQUEST", message: msg });
	}

	const cluster = await findKubernetesClusterById(kubernetesId);
	await log(`Resolved cluster '${cluster.name}'`);
	const client = await getKubernetesClient(kubernetesId);

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
	await log(`✅ Namespace '${namespace}' ready`);

	let imagePullSecretName: string | null = null;
	if (application.registry) {
		imagePullSecretName = await applyImagePullSecret(
			client,
			namespace,
			application.registry,
		);
		await log(`✅ Image-pull secret '${imagePullSecretName}' applied`);
	} else {
		await log("ℹ️  No registry attached — skipping image-pull secret");
	}

	const image = isPrebuiltImage
		? application.dockerImage!
		: getRegistryTag(application.registry!, `${application.appName}:latest`);
	await log(`🐳 Image: ${image}`);

	const { appName } = await applyDeployment(
		client,
		application,
		image,
		namespace,
		imagePullSecretName,
	);
	await log(
		`✅ Deployment '${appName}' applied (replicas: ${application.replicas})`,
	);

	await applyService(client, application, namespace);
	await log(`✅ Service '${appName}' applied`);

	for (const domain of application.domains ?? []) {
		await manageIngress(client, application, domain, namespace, {
			ingressClassName: cluster.ingressClassName,
			tlsIssuerName: cluster.tlsIssuerName,
		});
		await log(
			`✅ Ingress for '${domain.host}${domain.path ?? "/"}' (port ${domain.port ?? 3000}) applied`,
		);
	}
	if ((application.domains ?? []).length === 0) {
		await log("ℹ️  No domains attached — skipping Ingress");
	}

	await log(`⏳ Waiting for rollout of '${appName}' (timeout 5m)...`);
	const rollout = await waitForRollout(client, appName, namespace);
	if (!rollout.ready) {
		const msg =
			rollout.message ?? "Kubernetes rollout did not complete in time.";
		await log(`❌ ${msg}`);
		throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: msg });
	}
	await log("🎉 Rollout complete");
};
