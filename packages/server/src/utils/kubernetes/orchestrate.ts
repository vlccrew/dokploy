import { appendFile } from "node:fs/promises";
import { TRPCError } from "@trpc/server";
import { findKubernetesClusterById } from "../../services/kubernetes";
import type { InferResultType } from "../../types/with";
import { getRegistryTag } from "../cluster/upload";
import { getEnvironmentVariablesObject } from "../docker/utils";
import { getKubernetesClient } from "./client";
import {
	applyDeployment,
	deleteDeployment,
	k8sName,
	waitForRollout,
} from "./deployment";
import { isHttpError } from "./errors";
import { manageIngress } from "./ingress";
import { deleteNamespace, ensureNamespace } from "./namespace";
import { applyEnvSecret, applyImagePullSecret } from "./secrets";
import { applyService, deleteService } from "./service";

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

	const bindMount = (application.mounts ?? []).find((m) => m.type === "bind");
	if (bindMount) {
		const msg = `Bind mounts (hostPath) aren't supported on Kubernetes — convert mount '${bindMount.mountPath}' to a Volume mount or remove the bind.`;
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

	const envObj = getEnvironmentVariablesObject(
		application.env ?? null,
		application.environment.project.env,
		application.environment.env,
	);
	const envSecretName = await applyEnvSecret(
		client,
		namespace,
		application.appName,
		envObj,
	);
	if (envSecretName) {
		await log(
			`✅ Env Secret '${envSecretName}' applied (${Object.keys(envObj).length} vars)`,
		);
	} else {
		await log("ℹ️  No env vars — skipping env Secret");
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
		envSecretName,
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

/**
 * Tear down the Kubernetes resources owned by an application.
 *
 * Deletes: Deployment, Service, all Ingresses owned by the application
 * (matched by the `dokploy.io/application-id` label), and any ConfigMaps
 * we created for file-mounts (matched by app name prefix + managed-by label).
 *
 * Intentionally skips:
 * - PVCs   — they hold user data; require explicit "delete data" intent.
 * - Image-pull secret — shared across all apps in the namespace.
 * - Namespace — shared with the project; deleted only on project teardown.
 *
 * Best-effort: returns instead of throwing if anything fails. The caller is
 * expected to be a delete handler that has already removed the DB rows.
 */
export interface CleanupInput {
	applicationId: string;
	appName: string;
	namespace: string;
	kubernetesId: string;
}

export const cleanupKubernetesApplication = async (
	input: CleanupInput,
): Promise<{ ok: boolean; errors: string[] }> => {
	const errors: string[] = [];
	let client: Awaited<ReturnType<typeof getKubernetesClient>>;
	try {
		client = await getKubernetesClient(input.kubernetesId);
	} catch (err) {
		return {
			ok: false,
			errors: [
				`Could not reach cluster: ${err instanceof Error ? err.message : String(err)}`,
			],
		};
	}

	const slug = k8sName(input.appName);

	try {
		await deleteDeployment(client, slug, input.namespace);
	} catch (err) {
		errors.push(
			`Deployment delete failed: ${err instanceof Error ? err.message : String(err)}`,
		);
	}

	try {
		await deleteService(client, slug, input.namespace);
	} catch (err) {
		errors.push(
			`Service delete failed: ${err instanceof Error ? err.message : String(err)}`,
		);
	}

	try {
		// Match by app.kubernetes.io/name (the slugged appName) so the selector
		// covers both ingresses created before we started labeling with
		// application-id and any new ones.
		const ingresses = await client.networking.listNamespacedIngress({
			namespace: input.namespace,
			labelSelector: `app.kubernetes.io/name=${slug}`,
		});
		for (const ing of ingresses.items ?? []) {
			const name = ing.metadata?.name;
			if (!name) continue;
			try {
				await client.networking.deleteNamespacedIngress({
					name,
					namespace: input.namespace,
				});
			} catch (err) {
				if (!isHttpError(err) || err.code !== 404) {
					errors.push(`Ingress ${name} delete failed`);
				}
			}
		}
	} catch (err) {
		errors.push(
			`Ingress list failed: ${err instanceof Error ? err.message : String(err)}`,
		);
	}

	try {
		const cms = await client.core.listNamespacedConfigMap({
			namespace: input.namespace,
			labelSelector: "app.kubernetes.io/managed-by=dokploy",
		});
		for (const cm of cms.items ?? []) {
			const name = cm.metadata?.name;
			if (!name || !name.startsWith(`${slug}-files-`)) continue;
			try {
				await client.core.deleteNamespacedConfigMap({
					name,
					namespace: input.namespace,
				});
			} catch (err) {
				if (!isHttpError(err) || err.code !== 404) {
					errors.push(`ConfigMap ${name} delete failed`);
				}
			}
		}
	} catch (err) {
		errors.push(
			`ConfigMap list failed: ${err instanceof Error ? err.message : String(err)}`,
		);
	}

	// Owned Secrets — env Secret carries app.kubernetes.io/name=<slug>.
	// The shared image-pull secret only has managed-by, so it's not selected
	// here and is intentionally left in place for other apps in the namespace.
	try {
		const secrets = await client.core.listNamespacedSecret({
			namespace: input.namespace,
			labelSelector: `app.kubernetes.io/name=${slug}`,
		});
		for (const sec of secrets.items ?? []) {
			const name = sec.metadata?.name;
			if (!name) continue;
			try {
				await client.core.deleteNamespacedSecret({
					name,
					namespace: input.namespace,
				});
			} catch (err) {
				if (!isHttpError(err) || err.code !== 404) {
					errors.push(`Secret ${name} delete failed`);
				}
			}
		}
	} catch (err) {
		errors.push(
			`Secret list failed: ${err instanceof Error ? err.message : String(err)}`,
		);
	}

	return { ok: errors.length === 0, errors };
};

/**
 * Tear down the Kubernetes namespace for a project. Kubernetes cascades the
 * delete to every owned resource inside (Deployments, Services, Ingresses,
 * ConfigMaps, Secrets, PVCs — including user data on PVCs). Project deletion
 * is the explicit "I want everything gone" intent that justifies wiping data.
 *
 * Best-effort: returns ok=false instead of throwing if the cluster call fails.
 */
export const cleanupKubernetesProject = async (input: {
	kubernetesId: string;
	namespace: string;
}): Promise<{ ok: boolean; error?: string }> => {
	try {
		const client = await getKubernetesClient(input.kubernetesId);
		await deleteNamespace(client, input.namespace);
		return { ok: true };
	} catch (err) {
		return {
			ok: false,
			error: err instanceof Error ? err.message : String(err),
		};
	}
};
