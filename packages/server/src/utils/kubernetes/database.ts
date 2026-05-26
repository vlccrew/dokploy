import { createHash } from "node:crypto";
import { appendFile } from "node:fs/promises";
import type {
	V1ConfigMap,
	V1Container,
	V1Deployment,
	V1PersistentVolumeClaim,
	V1Service,
} from "@kubernetes/client-node";
import { TRPCError } from "@trpc/server";
import { findKubernetesClusterById } from "../../services/kubernetes";
import { getEnvironmentVariablesObject } from "../docker/utils";
import { getKubernetesClient, type KubernetesClient } from "./client";
import {
	deleteDeployment,
	ENV_CHECKSUM_ANNOTATION,
	FILES_CHECKSUM_ANNOTATION,
	k8sLabelValue,
	k8sName,
	waitForRollout,
} from "./deployment";
import { isHttpError } from "./errors";
import { ensureNamespace } from "./namespace";
import { applyEnvSecret } from "./secrets";

export type DatabaseKind = "postgres" | "redis" | "mysql" | "mariadb" | "mongo";

export interface DatabaseMount {
	mountId: string;
	type: "volume" | "bind" | "file";
	mountPath: string;
	hostPath?: string | null;
	content?: string | null;
}

export interface DatabaseProjectContext {
	projectId: string;
	name: string;
	kubernetesId: string | null;
	kubernetesNamespace: string | null;
	organizationId: string;
	env?: string | null;
}

export interface DatabaseEnvironmentContext {
	env?: string | null;
	project: DatabaseProjectContext;
}

export interface DatabaseDeploymentInput {
	kind: DatabaseKind;
	databaseId: string;
	appName: string;
	image: string;
	env: string | null;
	command?: string | null;
	args?: string[] | null;
	containerPort: number;
	externalPort?: number | null;
	memoryLimit?: string | null;
	memoryReservation?: string | null;
	cpuLimit?: string | null;
	cpuReservation?: string | null;
	/** All mounts the pod should see. The database's data dir is expected
	 * to live here as a `type: "volume"` mount — the create-database flow
	 * inserts it automatically via `createMount`. We do not synthesize a
	 * data PVC ourselves: that would double-mount the data dir when the
	 * user mount is already present. */
	mounts: DatabaseMount[];
	environment: DatabaseEnvironmentContext;
	/** Mongo only: replicaSets requires a custom init script that's not yet
	 * implemented on K8s — when true the orchestrator rejects deploy. */
	replicaSets?: boolean;
}

const parseMemory = (value?: string | null): string | undefined => {
	if (!value) return undefined;
	const bytes = Number.parseInt(value);
	if (Number.isNaN(bytes) || bytes <= 0) return undefined;
	return `${Math.max(1, Math.floor(bytes / (1024 * 1024)))}Mi`;
};

const parseCpu = (nanoCpus?: string | null): string | undefined => {
	if (!nanoCpus) return undefined;
	const n = Number.parseInt(nanoCpus);
	if (Number.isNaN(n) || n <= 0) return undefined;
	const cores = n / 1_000_000_000;
	return `${Math.max(1, Math.round(cores * 1000))}m`;
};

const hashEnv = (env: Record<string, string>): string => {
	const sortedKeys = Object.keys(env).sort();
	const canonical = sortedKeys.map((k) => [k, env[k]] as const);
	return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
};

const hashConfigMaps = (cms: V1ConfigMap[]): string | null => {
	if (cms.length === 0) return null;
	const sorted = [...cms].sort((a, b) =>
		(a.metadata?.name ?? "").localeCompare(b.metadata?.name ?? ""),
	);
	const canonical = sorted.map((cm) => {
		const data = cm.data ?? {};
		const sortedKeys = Object.keys(data).sort();
		return [
			cm.metadata?.name ?? "",
			sortedKeys.map((k) => [k, data[k]] as const),
		] as const;
	});
	return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
};

interface UserVolumePiece {
	name: string;
	mountPath: string;
	subPath?: string;
	volume: Record<string, unknown>;
	configMap?: V1ConfigMap;
	pvc?: V1PersistentVolumeClaim;
}

const buildUserVolumes = (
	mounts: DatabaseMount[],
	appName: string,
	namespace: string,
	commonLabels: Record<string, string>,
): UserVolumePiece[] => {
	const out: UserVolumePiece[] = [];
	let fileIndex = 0;
	for (const m of mounts) {
		const baseName = k8sName(`${appName}-${m.mountId.slice(0, 8)}`);
		if (m.type === "volume") {
			out.push({
				name: baseName,
				mountPath: m.mountPath,
				volume: { persistentVolumeClaim: { claimName: baseName } },
				pvc: {
					apiVersion: "v1",
					kind: "PersistentVolumeClaim",
					metadata: { name: baseName, namespace, labels: commonLabels },
					spec: {
						accessModes: ["ReadWriteOnce"],
						resources: { requests: { storage: "1Gi" } },
					},
				},
			});
		} else if (m.type === "file") {
			fileIndex += 1;
			const cmName = k8sName(`${appName}-files-${fileIndex}`);
			const fileName =
				(m.mountPath || "").split("/").pop() || `file-${fileIndex}`;
			out.push({
				name: baseName,
				mountPath: m.mountPath,
				subPath: fileName,
				volume: {
					configMap: {
						name: cmName,
						items: [{ key: fileName, path: fileName }],
					},
				},
				configMap: {
					apiVersion: "v1",
					kind: "ConfigMap",
					metadata: {
						name: cmName,
						namespace,
						labels: { "app.kubernetes.io/managed-by": "dokploy" },
					},
					data: { [fileName]: m.content ?? "" },
				},
			});
		}
		// bind mounts are rejected upstream
	}
	return out;
};

export interface DatabaseManifestBundle {
	deployment: V1Deployment;
	service: V1Service;
	pvcs: V1PersistentVolumeClaim[];
	configMaps: V1ConfigMap[];
	appName: string;
}

export const buildDatabaseManifest = (
	input: DatabaseDeploymentInput,
	envObj: Record<string, string>,
	namespace: string,
	envFromSecretName: string | null,
): DatabaseManifestBundle => {
	const appName = k8sName(input.appName);
	const labels: Record<string, string> = {
		"app.kubernetes.io/managed-by": "dokploy",
		"app.kubernetes.io/name": appName,
		"dokploy.io/database-id": k8sLabelValue(input.databaseId),
		"dokploy.io/database-kind": input.kind,
	};

	const userPieces = buildUserVolumes(
		input.mounts ?? [],
		appName,
		namespace,
		labels,
	);

	const volumeMounts: V1Container["volumeMounts"] = userPieces.map(
		({ name, mountPath, subPath }) => ({
			name,
			mountPath,
			...(subPath && { subPath }),
		}),
	);

	const volumes = userPieces.map(({ name, volume }) => ({ name, ...volume }));

	const cpuLimit = parseCpu(input.cpuLimit);
	const memoryLimit = parseMemory(input.memoryLimit);
	const cpuRequest = parseCpu(input.cpuReservation);
	const memoryRequest = parseMemory(input.memoryReservation);

	const container: V1Container = {
		name: appName,
		image: input.image,
		imagePullPolicy: "IfNotPresent",
		...(envFromSecretName && {
			envFrom: [{ secretRef: { name: envFromSecretName } }],
		}),
		ports: [{ containerPort: input.containerPort, protocol: "TCP" }],
		resources: {
			...(cpuLimit || memoryLimit
				? {
						limits: {
							...(cpuLimit && { cpu: cpuLimit }),
							...(memoryLimit && { memory: memoryLimit }),
						},
					}
				: {}),
			...(cpuRequest || memoryRequest
				? {
						requests: {
							...(cpuRequest && { cpu: cpuRequest }),
							...(memoryRequest && { memory: memoryRequest }),
						},
					}
				: {}),
		},
		...(input.command && { command: ["/bin/sh", "-c", input.command] }),
		...(input.args && input.args.length > 0 && { args: input.args }),
		...(volumeMounts.length > 0 && { volumeMounts }),
	};

	const configMaps = userPieces
		.map((p) => p.configMap)
		.filter((cm): cm is V1ConfigMap => Boolean(cm));

	const envChecksum = Object.keys(envObj).length > 0 ? hashEnv(envObj) : null;
	const filesChecksum = hashConfigMaps(configMaps);
	const annotations: Record<string, string> = {
		...(envChecksum && { [ENV_CHECKSUM_ANNOTATION]: envChecksum }),
		...(filesChecksum && { [FILES_CHECKSUM_ANNOTATION]: filesChecksum }),
	};
	const hasAnnotations = Object.keys(annotations).length > 0;

	const deployment: V1Deployment = {
		apiVersion: "apps/v1",
		kind: "Deployment",
		metadata: { name: appName, namespace, labels },
		spec: {
			// RWO PVC can be bound by exactly one pod, so we can't have an old
			// and a new pod running concurrently. Recreate tears down the old
			// pod before starting the new one.
			strategy: { type: "Recreate" },
			replicas: 1,
			selector: { matchLabels: { "app.kubernetes.io/name": appName } },
			template: {
				metadata: {
					labels,
					...(hasAnnotations && { annotations }),
				},
				spec: {
					containers: [container],
					restartPolicy: "Always",
					...(volumes.length > 0 && { volumes }),
				},
			},
		},
	};

	// ClusterIP is the default — internal-only access. When externalPort is set
	// the database is exposed on every node at that port via NodePort. Teams
	// that want a LoadBalancer can edit the Service directly post-deploy.
	const useNodePort =
		typeof input.externalPort === "number" && input.externalPort > 0;
	const service: V1Service = {
		apiVersion: "v1",
		kind: "Service",
		metadata: {
			name: appName,
			namespace,
			labels: {
				"app.kubernetes.io/managed-by": "dokploy",
				"app.kubernetes.io/name": appName,
			},
		},
		spec: {
			type: useNodePort ? "NodePort" : "ClusterIP",
			selector: { "app.kubernetes.io/name": appName },
			ports: [
				{
					name: input.kind,
					port: input.containerPort,
					targetPort: input.containerPort,
					protocol: "TCP",
					...(useNodePort && { nodePort: input.externalPort! }),
				},
			],
		},
	};

	return {
		deployment,
		service,
		pvcs: userPieces
			.map((p) => p.pvc)
			.filter((p): p is V1PersistentVolumeClaim => Boolean(p)),
		configMaps,
		appName,
	};
};

const makeLogger = (logPath?: string) => async (line: string) => {
	const stamped = `[${new Date().toISOString()}] ${line}\n`;
	if (logPath) {
		try {
			await appendFile(logPath, stamped);
		} catch {
			// best-effort
		}
	}
};

const ensurePvc = async (
	client: KubernetesClient,
	pvc: V1PersistentVolumeClaim,
): Promise<void> => {
	const name = pvc.metadata?.name;
	const namespace = pvc.metadata?.namespace;
	if (!name || !namespace) return;
	try {
		await client.core.readNamespacedPersistentVolumeClaim({ name, namespace });
	} catch (err) {
		if (isHttpError(err) && err.code === 404) {
			await client.core.createNamespacedPersistentVolumeClaim({
				namespace,
				body: pvc,
			});
			return;
		}
		throw err;
	}
};

const upsertConfigMap = async (
	client: KubernetesClient,
	cm: V1ConfigMap,
): Promise<void> => {
	const name = cm.metadata?.name;
	const namespace = cm.metadata?.namespace;
	if (!name || !namespace) return;
	try {
		await client.core.readNamespacedConfigMap({ name, namespace });
		await client.core.replaceNamespacedConfigMap({ name, namespace, body: cm });
	} catch (err) {
		if (isHttpError(err) && err.code === 404) {
			await client.core.createNamespacedConfigMap({ namespace, body: cm });
			return;
		}
		throw err;
	}
};

const upsertDeployment = async (
	client: KubernetesClient,
	deployment: V1Deployment,
): Promise<void> => {
	const name = deployment.metadata?.name;
	const namespace = deployment.metadata?.namespace;
	if (!name || !namespace) return;
	try {
		await client.apps.readNamespacedDeployment({ name, namespace });
		await client.apps.replaceNamespacedDeployment({
			name,
			namespace,
			body: deployment,
		});
	} catch (err) {
		if (isHttpError(err) && err.code === 404) {
			await client.apps.createNamespacedDeployment({
				namespace,
				body: deployment,
			});
			return;
		}
		throw err;
	}
};

const upsertService = async (
	client: KubernetesClient,
	service: V1Service,
): Promise<void> => {
	const name = service.metadata?.name;
	const namespace = service.metadata?.namespace;
	if (!name || !namespace) return;
	try {
		const existing = await client.core.readNamespacedService({
			name,
			namespace,
		});
		const merged: V1Service = {
			...service,
			metadata: {
				...service.metadata,
				resourceVersion: existing.metadata?.resourceVersion,
			},
			spec: {
				...service.spec,
				clusterIP: existing.spec?.clusterIP,
			},
		};
		await client.core.replaceNamespacedService({
			name,
			namespace,
			body: merged,
		});
	} catch (err) {
		if (isHttpError(err) && err.code === 404) {
			await client.core.createNamespacedService({ namespace, body: service });
			return;
		}
		throw err;
	}
};

export const orchestrateKubernetesDatabaseDeploy = async ({
	input,
	logPath,
}: {
	input: DatabaseDeploymentInput;
	logPath?: string;
}): Promise<void> => {
	const log = makeLogger(logPath);
	await log(`🚀 Starting Kubernetes deployment for ${input.kind}`);

	const { kubernetesId } = input.environment.project;
	if (!kubernetesId) {
		const msg =
			"Kubernetes engine selected but the project has no Kubernetes cluster bound. Set one on the project first.";
		await log(`❌ ${msg}`);
		throw new TRPCError({ code: "BAD_REQUEST", message: msg });
	}

	const bindMount = (input.mounts ?? []).find((m) => m.type === "bind");
	if (bindMount) {
		const msg = `Bind mounts (hostPath) aren't supported on Kubernetes — convert mount '${bindMount.mountPath}' to a Volume mount or remove the bind.`;
		await log(`❌ ${msg}`);
		throw new TRPCError({ code: "BAD_REQUEST", message: msg });
	}

	if (input.kind === "mongo" && input.replicaSets) {
		const msg =
			"MongoDB replica sets aren't supported on Kubernetes yet — disable replicaSets or deploy this database on Docker.";
		await log(`❌ ${msg}`);
		throw new TRPCError({ code: "BAD_REQUEST", message: msg });
	}

	const cluster = await findKubernetesClusterById(kubernetesId);
	await log(`Resolved cluster '${cluster.name}'`);
	const client = await getKubernetesClient(kubernetesId);

	const namespace = await ensureNamespace(
		client,
		{
			projectId: input.environment.project.projectId,
			name: input.environment.project.name,
			kubernetesNamespace:
				input.environment.project.kubernetesNamespace ?? null,
		},
		cluster.defaultNamespacePrefix,
	);
	await log(`✅ Namespace '${namespace}' ready`);

	const envObj = getEnvironmentVariablesObject(
		input.env ?? null,
		input.environment.project.env,
		input.environment.env,
	);
	const envSecretName = await applyEnvSecret(
		client,
		namespace,
		input.appName,
		envObj,
	);
	if (envSecretName) {
		await log(
			`✅ Env Secret '${envSecretName}' applied (${Object.keys(envObj).length} vars)`,
		);
	} else {
		await log("ℹ️  No env vars — skipping env Secret");
	}

	const bundle = buildDatabaseManifest(input, envObj, namespace, envSecretName);

	for (const pvc of bundle.pvcs) {
		await ensurePvc(client, pvc);
	}
	if (bundle.pvcs.length > 0) {
		await log(`✅ ${bundle.pvcs.length} PVC(s) ready`);
	}
	for (const cm of bundle.configMaps) {
		await upsertConfigMap(client, cm);
	}

	await upsertDeployment(client, bundle.deployment);
	await log(`✅ Deployment '${bundle.appName}' applied`);

	await upsertService(client, bundle.service);
	await log(`✅ Service '${bundle.appName}' applied`);

	await log(`⏳ Waiting for rollout of '${bundle.appName}' (timeout 5m)...`);
	const rollout = await waitForRollout(client, bundle.appName, namespace);
	if (!rollout.ready) {
		const msg =
			rollout.message ?? "Kubernetes rollout did not complete in time.";
		await log(`❌ ${msg}`);
		throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: msg });
	}
	await log("🎉 Rollout complete");
};

export interface DatabaseCleanupInput {
	kind: DatabaseKind;
	databaseId: string;
	appName: string;
	namespace: string;
	kubernetesId: string;
}

/**
 * Tear down K8s resources for a database. Deletes Deployment, Service, env
 * Secret, and any file-mount ConfigMaps. **Keeps PVCs** — both the data PVC
 * and any user-defined `volume` mounts — because they hold user data.
 *
 * Best-effort: collects errors instead of throwing so the caller (a delete
 * handler) can still finish removing DB rows even if cluster calls fail.
 */
export const cleanupKubernetesDatabase = async (
	input: DatabaseCleanupInput,
): Promise<{ ok: boolean; errors: string[] }> => {
	const errors: string[] = [];
	let client: KubernetesClient;
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
		await client.core.deleteNamespacedService({
			name: slug,
			namespace: input.namespace,
		});
	} catch (err) {
		if (!isHttpError(err) || err.code !== 404) {
			errors.push(
				`Service delete failed: ${err instanceof Error ? err.message : String(err)}`,
			);
		}
	}

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

	return { ok: errors.length === 0, errors };
};

export interface DatabaseScaleInput {
	kubernetesId: string;
	namespace: string;
	appName: string;
	replicas: 0 | 1;
}

export const scaleKubernetesDatabase = async (
	input: DatabaseScaleInput,
): Promise<void> => {
	const client = await getKubernetesClient(input.kubernetesId);
	const name = k8sName(input.appName);
	await client.apps.patchNamespacedDeployment({
		name,
		namespace: input.namespace,
		body: { spec: { replicas: input.replicas } },
	});
};
