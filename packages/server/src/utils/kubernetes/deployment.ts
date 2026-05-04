import type {
	V1ConfigMap,
	V1Container,
	V1Deployment,
	V1PersistentVolumeClaim,
	V1PodSpec,
} from "@kubernetes/client-node";
import slugify from "slugify";
import type { ApplicationNested } from "../builders";
import type { KubernetesClient } from "./client";
import { isHttpError } from "./errors";
import { IMAGE_PULL_SECRET_NAME } from "./secrets";

export const k8sName = (raw: string): string => {
	const slug = slugify(raw, { lower: true, strict: true });
	return slug.replace(/[^a-z0-9-]/g, "-").slice(0, 63) || "app";
};

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

interface VolumePiece {
	name: string;
	mountPath: string;
	/** subPath within the volume — used for file mounts so the user's mountPath
	 * lands as a single file rather than a directory containing the file. */
	subPath?: string;
	volume: Record<string, unknown>;
	configMap?: { name: string; data: Record<string, string> };
}

const buildVolumes = (
	application: ApplicationNested,
	appName: string,
): VolumePiece[] => {
	const out: VolumePiece[] = [];
	let fileIndex = 0;
	for (const m of application.mounts) {
		const baseName = k8sName(`${appName}-${m.mountId.slice(0, 8)}`);
		if (m.type === "volume") {
			out.push({
				name: baseName,
				mountPath: m.mountPath,
				volume: { persistentVolumeClaim: { claimName: baseName } },
			});
		} else if (m.type === "bind") {
			out.push({
				name: baseName,
				mountPath: m.mountPath,
				volume: {
					hostPath: { path: m.hostPath ?? "/", type: "DirectoryOrCreate" },
				},
			});
		} else if (m.type === "file") {
			fileIndex += 1;
			const cmName = k8sName(`${appName}-files-${fileIndex}`);
			// Derive a stable key for the file inside the ConfigMap from the
			// user's mountPath so subPath works regardless of what they typed
			// in the (legacy / Docker-only) `filePath` field.
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
					name: cmName,
					data: { [fileName]: m.content ?? "" },
				},
			});
		}
	}
	return out;
};

// Builds PVCs for `volume` mounts. Sizing is fixed at 1Gi/RWO and no
// `storageClassName` is set, so the cluster's *default* StorageClass is used.
// Docker Desktop k8s ships with a `hostpath` provisioner as default, which
// auto-binds. Clusters without a default will leave PVCs in `Pending`.
const buildPvcs = (
	application: ApplicationNested,
	appName: string,
	namespace: string,
) =>
	application.mounts
		.filter((m) => m.type === "volume")
		.map((m) => ({
			apiVersion: "v1",
			kind: "PersistentVolumeClaim" as const,
			metadata: {
				name: k8sName(`${appName}-${m.mountId.slice(0, 8)}`),
				namespace,
				labels: {
					"app.kubernetes.io/managed-by": "dokploy",
					"app.kubernetes.io/name": k8sName(appName),
				},
			},
			spec: {
				accessModes: ["ReadWriteOnce"],
				resources: { requests: { storage: "1Gi" } },
			},
		}));

export interface DeploymentBuildInput {
	application: ApplicationNested;
	image: string;
	namespace: string;
	/**
	 * Image-pull secret name. Pass null to omit `imagePullSecrets` entirely
	 * (e.g. when deploying a public image with sourceType=docker).
	 */
	imagePullSecretName?: string | null;
	/**
	 * Secret to mount as env via `envFrom: [{ secretRef: ... }]`. Pass null
	 * to skip — the application has no env vars or the secret-creation step
	 * was skipped.
	 */
	envFromSecretName?: string | null;
}

export const buildDeploymentManifest = ({
	application,
	image,
	namespace,
	imagePullSecretName = IMAGE_PULL_SECRET_NAME,
	envFromSecretName = null,
}: DeploymentBuildInput) => {
	const appName = k8sName(application.appName);
	const labels = {
		"app.kubernetes.io/managed-by": "dokploy",
		"app.kubernetes.io/name": appName,
		"dokploy.io/application-id": application.applicationId,
	};

	const volumePieces = buildVolumes(application, appName);
	const volumeMounts = volumePieces.map(({ name, mountPath, subPath }) => ({
		name,
		mountPath,
		...(subPath && { subPath }),
	}));
	const volumes = volumePieces.map(({ name, volume }) => ({ name, ...volume }));

	const cpuLimit = parseCpu(application.cpuLimit);
	const memoryLimit = parseMemory(application.memoryLimit);
	const cpuRequest = parseCpu(application.cpuReservation);
	const memoryRequest = parseMemory(application.memoryReservation);

	const ports = application.ports.map((p) => ({
		containerPort: p.targetPort,
		protocol: p.protocol === "udp" ? "UDP" : "TCP",
	}));

	const container: V1Container = {
		name: appName,
		image,
		imagePullPolicy: "Always",
		...(envFromSecretName && {
			envFrom: [{ secretRef: { name: envFromSecretName } }],
		}),
		ports,
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
		...(application.command && {
			command: ["/bin/sh", "-c", application.command],
		}),
		...(application.args &&
			application.args.length > 0 && {
				args: application.args,
			}),
		...(volumeMounts.length > 0 && { volumeMounts }),
	};

	const podSpec: V1PodSpec = {
		containers: [container],
		...(imagePullSecretName && {
			imagePullSecrets: [{ name: imagePullSecretName }],
		}),
		restartPolicy: "Always",
		...(volumes.length > 0 && { volumes: volumes as V1PodSpec["volumes"] }),
	};

	const deployment: V1Deployment = {
		apiVersion: "apps/v1",
		kind: "Deployment",
		metadata: { name: appName, namespace, labels },
		spec: {
			replicas: application.replicas ?? 1,
			selector: { matchLabels: { "app.kubernetes.io/name": appName } },
			template: {
				metadata: { labels },
				spec: podSpec,
			},
		},
	};

	const configMaps: V1ConfigMap[] = volumePieces
		.filter((v) => v.configMap)
		.map((v) => ({
			apiVersion: "v1",
			kind: "ConfigMap",
			metadata: {
				name: v.configMap!.name,
				namespace,
				labels: { "app.kubernetes.io/managed-by": "dokploy" },
			},
			data: v.configMap!.data,
		}));

	const pvcs = buildPvcs(
		application,
		appName,
		namespace,
	) as V1PersistentVolumeClaim[];

	return { deployment, configMaps, pvcs, appName };
};

export const applyDeployment = async (
	client: KubernetesClient,
	application: ApplicationNested,
	image: string,
	namespace: string,
	imagePullSecretName: string | null = IMAGE_PULL_SECRET_NAME,
	envFromSecretName: string | null = null,
): Promise<{ appName: string }> => {
	const { deployment, configMaps, pvcs, appName } = buildDeploymentManifest({
		application,
		image,
		namespace,
		imagePullSecretName,
		envFromSecretName,
	});

	for (const pvc of pvcs) {
		const pvcName = pvc.metadata?.name;
		if (!pvcName) continue;
		try {
			await client.core.readNamespacedPersistentVolumeClaim({
				name: pvcName,
				namespace,
			});
		} catch (err) {
			if (isHttpError(err) && err.code === 404) {
				await client.core.createNamespacedPersistentVolumeClaim({
					namespace,
					body: pvc,
				});
			} else {
				throw err;
			}
		}
	}

	for (const cm of configMaps) {
		const cmName = cm.metadata?.name;
		if (!cmName) continue;
		try {
			await client.core.readNamespacedConfigMap({ name: cmName, namespace });
			await client.core.replaceNamespacedConfigMap({
				name: cmName,
				namespace,
				body: cm,
			});
		} catch (err) {
			if (isHttpError(err) && err.code === 404) {
				await client.core.createNamespacedConfigMap({ namespace, body: cm });
			} else {
				throw err;
			}
		}
	}

	try {
		await client.apps.readNamespacedDeployment({ name: appName, namespace });
		await client.apps.replaceNamespacedDeployment({
			name: appName,
			namespace,
			body: deployment,
		});
	} catch (err) {
		if (isHttpError(err) && err.code === 404) {
			await client.apps.createNamespacedDeployment({
				namespace,
				body: deployment,
			});
		} else {
			throw err;
		}
	}

	return { appName };
};

export const deleteDeployment = async (
	client: KubernetesClient,
	appName: string,
	namespace: string,
): Promise<void> => {
	try {
		await client.apps.deleteNamespacedDeployment({ name: appName, namespace });
	} catch (err) {
		if (!isHttpError(err) || err.code !== 404) throw err;
	}
};

export const waitForRollout = async (
	client: KubernetesClient,
	name: string,
	namespace: string,
	timeoutMs = 5 * 60 * 1000,
): Promise<{ ready: boolean; message?: string }> => {
	const start = Date.now();
	while (Date.now() - start < timeoutMs) {
		const dep = await client.apps.readNamespacedDeployment({ name, namespace });
		const status = dep.status ?? {};
		const desired = dep.spec?.replicas ?? 0;
		if (
			status.observedGeneration !== undefined &&
			dep.metadata?.generation !== undefined &&
			status.observedGeneration >= dep.metadata.generation &&
			(status.availableReplicas ?? 0) >= desired &&
			(status.updatedReplicas ?? 0) >= desired
		) {
			return { ready: true };
		}
		await new Promise((r) => setTimeout(r, 2_000));
	}
	return {
		ready: false,
		message: `Rollout did not complete in ${timeoutMs}ms`,
	};
};
