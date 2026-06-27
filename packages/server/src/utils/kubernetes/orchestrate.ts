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
	rolloutRestartDeployment,
	scaleDeployment,
	waitForRollout,
} from "./deployment";
import { isHttpError } from "./errors";
import { manageIngress, pruneStaleIngresses, removeIngress } from "./ingress";
import { detectExposedPorts } from "./inspect";
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
	deploymentId,
	imageTag,
	logPath,
}: {
	application: ApplicationForK8s;
	/** Deployment row id; written as a pod-template annotation so every deploy
	 * mutates the pod spec and triggers a rollout. */
	deploymentId: string;
	/** Per-build tag (e.g. short git SHA) appended to the registry image
	 * reference for built sources. Ignored when `sourceType === "docker"`. */
	imageTag?: string;
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

	const tag = imageTag ?? "latest";
	const image = isPrebuiltImage
		? application.dockerImage!
		: `${getRegistryTag(application.registry!, application.appName)}:${tag}`;
	await log(`🐳 Image: ${image}`);

	// For built sources, read the image's EXPOSE'd port(s) off the build host so
	// the Service can target them instead of the hardcoded 3000 fallback when the
	// app has no explicit ports/domains. Prebuilt `docker` images aren't pulled
	// locally, so there's nothing to inspect — they keep the 3000 fallback.
	let fallbackPorts: number[] = [];
	if (!isPrebuiltImage) {
		const buildServerId =
			application.buildServerId || application.serverId || null;
		fallbackPorts = await detectExposedPorts(
			`${application.appName}:latest`,
			buildServerId,
		);
		if (fallbackPorts.length) {
			await log(
				`🔎 Detected exposed port(s): ${fallbackPorts.join(", ")} (Service fallback)`,
			);
		}
	}

	const { appName } = await applyDeployment(
		client,
		application,
		image,
		namespace,
		deploymentId,
		imagePullSecretName,
		envSecretName,
		envObj,
	);
	await log(
		`✅ Deployment '${appName}' applied (replicas: ${application.replicas})`,
	);

	await applyService(client, application, namespace, fallbackPorts);
	await log(`✅ Service '${appName}' applied`);

	const domains = application.domains ?? [];

	// Garbage-collect Ingresses that no longer map to a current domain *before*
	// applying the current ones. An Ingress name embeds the domain's serial
	// `uniqueConfigKey`, so deleting + recreating a domain orphans the old
	// Ingress; since it still claims the same host + path, nginx's admission
	// webhook would reject the new Ingress ("host ... is already defined in
	// ingress ..."). Pruning first clears that collision. Best-effort — never
	// fail a deploy over cleanup.
	try {
		const removed = await pruneStaleIngresses(
			client,
			application.appName,
			domains,
			namespace,
		);
		for (const name of removed) {
			await log(`🧹 Removed stale Ingress '${name}'`);
		}
	} catch (err) {
		await log(
			`⚠️  Stale-Ingress cleanup skipped: ${err instanceof Error ? err.message : String(err)}`,
		);
	}

	for (const domain of domains) {
		await manageIngress(client, application, domain, namespace, {
			ingressClassName: cluster.ingressClassName,
			tlsIssuerName: cluster.tlsIssuerName,
		});
		await log(
			`✅ Ingress for '${domain.host}${domain.path ?? "/"}' (port ${domain.port ?? 3000}) applied`,
		);
	}
	if (domains.length === 0) {
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
 * Restart an application's pods on Kubernetes without rebuilding — the engine's
 * equivalent of Docker's reload (`mechanizeDockerContainer`). Stamps a fresh
 * `restartedAt` annotation on the Deployment's pod template to trigger a rolling
 * restart, then waits for the rollout to settle.
 */
export const restartKubernetesApplication = async ({
	application,
	logPath,
}: {
	application: ApplicationForK8s;
	logPath?: string;
}): Promise<void> => {
	const log = makeLogger(logPath);
	await log("🔄 Restarting Kubernetes application");

	const kubernetesId = application.environment.project.kubernetesId;
	if (!kubernetesId) {
		const msg =
			"Kubernetes engine selected but the project has no Kubernetes cluster bound. Set one on the project first.";
		await log(`❌ ${msg}`);
		throw new TRPCError({ code: "BAD_REQUEST", message: msg });
	}

	const cluster = await findKubernetesClusterById(kubernetesId);
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

	const appName = k8sName(application.appName);
	try {
		await rolloutRestartDeployment(client, appName, namespace);
	} catch (err) {
		if (isHttpError(err) && err.code === 404) {
			const msg = `No Kubernetes Deployment '${appName}' found in namespace '${namespace}' — deploy the application before reloading.`;
			await log(`❌ ${msg}`);
			throw new TRPCError({ code: "BAD_REQUEST", message: msg });
		}
		throw err;
	}
	await log(`✅ Triggered rollout restart of '${appName}'`);

	await log(`⏳ Waiting for rollout of '${appName}' (timeout 5m)...`);
	const rollout = await waitForRollout(client, appName, namespace);
	if (!rollout.ready) {
		const msg =
			rollout.message ?? "Kubernetes rollout did not complete in time.";
		await log(`❌ ${msg}`);
		throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: msg });
	}
	await log("🎉 Restart complete");
};

/**
 * Scale an application's Deployment to a replica count on Kubernetes — the
 * engine's equivalent of Docker's `docker service scale`. `stop` passes 0;
 * `start` passes the application's desired replicas. Does not wait for the
 * pods to settle (matches the fire-and-forget Docker stop/start behavior).
 */
export const scaleKubernetesApplication = async ({
	application,
	replicas,
	logPath,
}: {
	application: ApplicationForK8s;
	replicas: number;
	logPath?: string;
}): Promise<void> => {
	const log = makeLogger(logPath);
	await log(`📐 Scaling Kubernetes application to ${replicas} replica(s)`);

	const kubernetesId = application.environment.project.kubernetesId;
	if (!kubernetesId) {
		const msg =
			"Kubernetes engine selected but the project has no Kubernetes cluster bound. Set one on the project first.";
		await log(`❌ ${msg}`);
		throw new TRPCError({ code: "BAD_REQUEST", message: msg });
	}

	const cluster = await findKubernetesClusterById(kubernetesId);
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

	const appName = k8sName(application.appName);
	try {
		await scaleDeployment(client, appName, namespace, replicas);
	} catch (err) {
		if (isHttpError(err) && err.code === 404) {
			const msg = `No Kubernetes Deployment '${appName}' found in namespace '${namespace}' — deploy the application first.`;
			await log(`❌ ${msg}`);
			throw new TRPCError({ code: "BAD_REQUEST", message: msg });
		}
		throw err;
	}
	await log(`✅ Scaled '${appName}' to ${replicas} replica(s)`);
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

/**
 * Delete the single Ingress backing one domain. Called when a domain is removed
 * outside of a deploy so the orphaned Ingress doesn't linger until the next
 * deploy's reconciliation prunes it (and, in the meantime, collide with a
 * re-created domain at nginx's admission webhook).
 *
 * Best-effort: returns ok=false instead of throwing — domain deletion has
 * already removed the DB row by the time this runs.
 */
export const removeKubernetesIngress = async (input: {
	kubernetesId: string;
	appName: string;
	uniqueConfigKey: number;
	namespace: string;
}): Promise<{ ok: boolean; error?: string }> => {
	try {
		const client = await getKubernetesClient(input.kubernetesId);
		await removeIngress(
			client,
			input.appName,
			input.uniqueConfigKey,
			input.namespace,
		);
		return { ok: true };
	} catch (err) {
		return {
			ok: false,
			error: err instanceof Error ? err.message : String(err),
		};
	}
};
