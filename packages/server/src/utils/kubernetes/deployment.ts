import { createHash } from "node:crypto";
import type {
	V1ConfigMap,
	V1Container,
	V1Deployment,
	V1PersistentVolumeClaim,
	V1Pod,
	V1PodDisruptionBudget,
	V1PodSpec,
	V1Probe,
} from "@kubernetes/client-node";
import slugify from "slugify";
import type { Domain } from "../../services/domain";
import type { ApplicationNested } from "../builders";
import type { KubernetesClient } from "./client";
import { isHttpError } from "./errors";
import { buildContainerResources } from "./resources";
import { IMAGE_PULL_SECRET_NAME } from "./secrets";

export const ENV_CHECKSUM_ANNOTATION = "dokploy.io/env-checksum";
export const FILES_CHECKSUM_ANNOTATION = "dokploy.io/files-checksum";
export const DEPLOYMENT_ID_ANNOTATION = "dokploy.io/deployment-id";

// A new pod has to stay Ready this long before it counts as available, and
// only then does a rolling update remove an old pod. A container that crashes
// a few seconds after starting therefore never replaces a working one.
export const MIN_READY_SECONDS = 10;
// After this long without progress the Deployment controller marks the
// rollout failed (ProgressDeadlineExceeded), which waitForRollout reports.
export const PROGRESS_DEADLINE_SECONDS = 300;

// A terminating pod gets SIGTERM at the same moment it's removed from the
// Service's endpoints, and ingress-nginx or a Gateway routes to it until that
// removal reaches them. Waiting first keeps it serving those last requests.
export const PRE_STOP_SLEEP_SECONDS = 5;

/**
 * Whether the API server takes the native `sleep` preStop action (on by
 * default since Kubernetes 1.30). Older servers drop the field and then reject
 * the empty hook, so it's only set when this is true.
 */
export const supportsSleepAction = async (
	client: KubernetesClient,
): Promise<boolean> => {
	try {
		const { major, minor } = await client.version.getCode();
		// Managed clusters report minors like "30+".
		const maj = Number.parseInt(major, 10);
		const min = Number.parseInt(minor, 10);
		return maj > 1 || (maj === 1 && min >= 30);
	} catch {
		return false;
	}
};

// Faster than the 10s default period, so a pod takes traffic soon after it
// starts listening; a 3s timeout keeps a slow health endpoint from flapping.
export const READINESS_PROBE_TIMING = {
	periodSeconds: 5,
	timeoutSeconds: 3,
	failureThreshold: 3,
} as const;

// Pods read `envFrom` Secret/ConfigMap values only at start time, so updating
// the Secret in place leaves running pods with the old env. Putting a hash of
// the env content on the pod template forces the template to differ when env
// changes, which triggers a rolling restart.
const hashEnv = (env: Record<string, string>): string => {
	const sortedKeys = Object.keys(env).sort();
	const canonical = sortedKeys.map((k) => [k, env[k]] as const);
	return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
};

// File mounts ship as ConfigMaps consumed via `subPath`. kubelet does NOT
// propagate ConfigMap updates into subPath-mounted files, so the same trick
// the env-checksum uses applies: hash the ConfigMap data onto the pod template
// so file content changes trigger a rolling restart.
type FileConfigMap = NonNullable<VolumePiece["configMap"]>;
const hashFiles = (volumePieces: VolumePiece[]): string | null => {
	const cms: FileConfigMap[] = volumePieces
		.map((v) => v.configMap)
		.filter((cm): cm is FileConfigMap => Boolean(cm));
	if (cms.length === 0) return null;
	const sorted = [...cms].sort((a, b) => a.name.localeCompare(b.name));
	const canonical = sorted.map((cm) => {
		const sortedKeys = Object.keys(cm.data).sort();
		return [cm.name, sortedKeys.map((k) => [k, cm.data[k]] as const)] as const;
	});
	return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
};

export const k8sName = (raw: string): string => {
	const slug = slugify(raw, { lower: true, strict: true });
	return slug.replace(/[^a-z0-9-]/g, "-").slice(0, 63) || "app";
};

// K8s label values: max 63 chars, must start and end with [A-Za-z0-9].
// nanoid IDs can start/end with `-` or `_`, which fails validation, so trim those.
export const k8sLabelValue = (raw: string): string => {
	const trimmed = raw.replace(/^[^A-Za-z0-9]+/, "").slice(0, 63);
	return trimmed.replace(/[^A-Za-z0-9]+$/, "");
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

type ProbeSettings = Pick<ApplicationNested, "kubernetesProbes" | "ports"> & {
	domains?: Pick<Domain, "port" | "enabled">[];
};

/**
 * The app's readiness probe: the one set on the app, or else a TCP check on
 * the port its first domain routes to. The app has to listen there for the
 * domain to work at all, so the check is safe, and it keeps traffic off a new
 * pod until it listens. Apps without a domain (workers) get no probe unless
 * one is set.
 */
export const buildReadinessProbe = (
	application: ProbeSettings,
): V1Probe | undefined => {
	const configured = application.kubernetesProbes?.readiness;
	if (configured?.type === "none") return undefined;
	const domain = application.domains?.find((d) => d.enabled);
	const domainPort = domain ? (domain.port ?? 3000) : undefined;
	if (!configured) {
		return domainPort
			? { tcpSocket: { port: domainPort }, ...READINESS_PROBE_TIMING }
			: undefined;
	}
	const port =
		configured.port ??
		domainPort ??
		application.ports.find((p) => p.protocol !== "udp")?.targetPort ??
		3000;
	return configured.type === "http"
		? {
				httpGet: { path: configured.path, port },
				...READINESS_PROBE_TIMING,
			}
		: { tcpSocket: { port }, ...READINESS_PROBE_TIMING };
};

export interface DeploymentBuildInput {
	/** `domains` picks the default readiness probe's port. */
	application: ApplicationNested & ProbeSettings;
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
	/**
	 * Resolved env-var map. Hashed onto the pod template as the
	 * `dokploy.io/env-checksum` annotation so secret content changes trigger
	 * a rolling restart. Pass null/undefined when there are no env vars.
	 */
	env?: Record<string, string> | null;
	/**
	 * Deployment row id for this deploy. Written as the
	 * `dokploy.io/deployment-id` pod-template annotation so every deploy
	 * mutates the pod spec — guarantees a rollout even when the image
	 * reference is unchanged (e.g. sourceType=docker with a fixed tag).
	 */
	deploymentId: string;
	/** Whether the cluster takes the native `sleep` preStop action. */
	sleepAction?: boolean;
}

export const buildDeploymentManifest = ({
	application,
	image,
	namespace,
	imagePullSecretName = IMAGE_PULL_SECRET_NAME,
	envFromSecretName = null,
	env = null,
	deploymentId,
	sleepAction = false,
}: DeploymentBuildInput) => {
	const appName = k8sName(application.appName);
	const labels = {
		"app.kubernetes.io/managed-by": "dokploy",
		"app.kubernetes.io/name": appName,
		"dokploy.io/application-id": k8sLabelValue(application.applicationId),
	};

	const volumePieces = buildVolumes(application, appName);
	const volumeMounts = volumePieces.map(({ name, mountPath, subPath }) => ({
		name,
		mountPath,
		...(subPath && { subPath }),
	}));
	const volumes = volumePieces.map(({ name, volume }) => ({ name, ...volume }));
	// `volume` mounts are RWO PVCs, attachable by one node at a time. Under the
	// default RollingUpdate, a new pod scheduled on another node hangs in
	// ContainerCreating until the rollout times out, so tear the old pod down
	// first — same reason the database Deployments use Recreate.
	const hasRwoVolume = application.mounts.some((m) => m.type === "volume");
	const replicas = application.replicas ?? 1;
	// Skipped with an RWO volume: every replica needs the one node holding it.
	const spreadAcrossNodes = replicas > 1 && !hasRwoVolume;

	const ports = application.ports.map((p) => ({
		containerPort: p.targetPort,
		protocol: p.protocol === "udp" ? "UDP" : "TCP",
	}));

	const readinessProbe = buildReadinessProbe(application);
	const routed = application.domains?.some((d) => d.enabled) ?? false;
	const container: V1Container = {
		name: appName,
		image,
		imagePullPolicy: "Always",
		...(envFromSecretName && {
			envFrom: [{ secretRef: { name: envFromSecretName } }],
		}),
		ports,
		resources: buildContainerResources(application),
		...(application.command && {
			command: ["/bin/sh", "-c", application.command],
		}),
		...(application.args &&
			application.args.length > 0 && {
				args: application.args,
			}),
		...(volumeMounts.length > 0 && { volumeMounts }),
		...(readinessProbe && { readinessProbe }),
		...(routed &&
			sleepAction && {
				lifecycle: {
					preStop: { sleep: { seconds: PRE_STOP_SLEEP_SECONDS } },
				},
			}),
	};

	const podSpec: V1PodSpec = {
		containers: [container],
		...(imagePullSecretName && {
			imagePullSecrets: [{ name: imagePullSecretName }],
		}),
		restartPolicy: "Always",
		...(volumes.length > 0 && { volumes: volumes as V1PodSpec["volumes"] }),
		// One replica per node, enforced at scheduling time. Not podAntiAffinity:
		// GKE Autopilot raises any pod using it to a 500m CPU request. A hard
		// spread also never strands a replica as Pending when replicas outnumber
		// nodes; it balances them instead. matchLabelKeys counts only pods of the
		// same revision, so surge pods in a rollout ignore the old ones, and
		// nodeTaintsPolicy leaves out nodes the pod can't run on (e.g. a tainted
		// control plane), which would otherwise hold the minimum at zero.
		...(spreadAcrossNodes && {
			topologySpreadConstraints: [
				{
					maxSkew: 1,
					topologyKey: "kubernetes.io/hostname",
					whenUnsatisfiable: "DoNotSchedule",
					labelSelector: {
						matchLabels: { "app.kubernetes.io/name": appName },
					},
					matchLabelKeys: ["pod-template-hash"],
					nodeTaintsPolicy: "Honor",
				},
			],
		}),
	};

	const envChecksum = env && Object.keys(env).length > 0 ? hashEnv(env) : null;
	const filesChecksum = hashFiles(volumePieces);
	const annotations = {
		[DEPLOYMENT_ID_ANNOTATION]: deploymentId,
		...(envChecksum && { [ENV_CHECKSUM_ANNOTATION]: envChecksum }),
		...(filesChecksum && { [FILES_CHECKSUM_ANNOTATION]: filesChecksum }),
	};

	const deployment: V1Deployment = {
		apiVersion: "apps/v1",
		kind: "Deployment",
		metadata: { name: appName, namespace, labels },
		spec: {
			replicas,
			minReadySeconds: MIN_READY_SECONDS,
			progressDeadlineSeconds: PROGRESS_DEADLINE_SECONDS,
			...(hasRwoVolume && { strategy: { type: "Recreate" } }),
			selector: { matchLabels: { "app.kubernetes.io/name": appName } },
			template: {
				metadata: { labels, annotations },
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

interface DisruptionTarget {
	appName: string;
	replicas?: number | null;
}

// GKE Autopilot keeps adding spare-capacity nodes and the cluster autoscaler
// drains them minutes later, restarting whatever pods landed there. The
// autoscaler never evicts past a budget, so a single replica is left alone and
// a multi-replica app loses at most one pod at a time. (The safe-to-evict
// annotation would also do it, but Autopilot raises any pod carrying it to a
// 500m CPU / 512Mi request.) Rollouts are unaffected: the Deployment
// controller deletes pods rather than evicting them.
export const buildPodDisruptionBudget = (
	target: DisruptionTarget,
	namespace: string,
): V1PodDisruptionBudget => {
	const appName = k8sName(target.appName);
	return {
		apiVersion: "policy/v1",
		kind: "PodDisruptionBudget",
		metadata: {
			name: appName,
			namespace,
			labels: {
				"app.kubernetes.io/managed-by": "dokploy",
				"app.kubernetes.io/name": appName,
			},
		},
		spec: {
			maxUnavailable: (target.replicas ?? 1) > 1 ? 1 : 0,
			selector: { matchLabels: { "app.kubernetes.io/name": appName } },
			// Otherwise a crash-looping or not-ready pod would hold up node
			// drains, including GKE's node upgrades, until it recovers.
			unhealthyPodEvictionPolicy: "AlwaysAllow",
		},
	};
};

export const applyPodDisruptionBudget = async (
	client: KubernetesClient,
	target: DisruptionTarget,
	namespace: string,
): Promise<V1PodDisruptionBudget> => {
	const pdb = buildPodDisruptionBudget(target, namespace);
	const name = k8sName(target.appName);
	try {
		const existing = await client.policy.readNamespacedPodDisruptionBudget({
			name,
			namespace,
		});
		// Unlike a Deployment, a PDB update is rejected unless it names the
		// version it replaces.
		await client.policy.replaceNamespacedPodDisruptionBudget({
			name,
			namespace,
			body: {
				...pdb,
				metadata: {
					...pdb.metadata,
					resourceVersion: existing.metadata?.resourceVersion,
				},
			},
		});
	} catch (err) {
		if (isHttpError(err) && err.code === 404) {
			await client.policy.createNamespacedPodDisruptionBudget({
				namespace,
				body: pdb,
			});
		} else {
			throw err;
		}
	}
	return pdb;
};

// A budget only guards against voluntary disruptions, so a kubeconfig without
// access to policy/v1 shouldn't fail the deploy.
export const tryApplyPodDisruptionBudget = async (
	client: KubernetesClient,
	target: DisruptionTarget,
	namespace: string,
	log: (line: string) => Promise<void>,
): Promise<void> => {
	try {
		const pdb = await applyPodDisruptionBudget(client, target, namespace);
		await log(
			`✅ PodDisruptionBudget '${pdb.metadata?.name}' applied (maxUnavailable: ${pdb.spec?.maxUnavailable})`,
		);
	} catch (err) {
		await log(
			`⚠️ PodDisruptionBudget not applied: ${err instanceof Error ? err.message : String(err)}`,
		);
	}
};

export const deletePodDisruptionBudget = async (
	client: KubernetesClient,
	name: string,
	namespace: string,
): Promise<void> => {
	try {
		await client.policy.deleteNamespacedPodDisruptionBudget({
			name,
			namespace,
		});
	} catch (err) {
		if (!isHttpError(err) || err.code !== 404) throw err;
	}
};

export const applyDeployment = async (
	client: KubernetesClient,
	application: DeploymentBuildInput["application"],
	image: string,
	namespace: string,
	deploymentId: string,
	imagePullSecretName: string | null = IMAGE_PULL_SECRET_NAME,
	envFromSecretName: string | null = null,
	env: Record<string, string> | null = null,
): Promise<{ appName: string }> => {
	const { deployment, configMaps, pvcs, appName } = buildDeploymentManifest({
		application,
		image,
		namespace,
		imagePullSecretName,
		envFromSecretName,
		env,
		deploymentId,
		sleepAction: await supportsSleepAction(client),
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

// Annotation `kubectl rollout restart` writes to force a rolling restart. Using
// the same key keeps our restart indistinguishable from a manual kubectl one.
export const RESTARTED_AT_ANNOTATION = "kubectl.kubernetes.io/restartedAt";

/**
 * Restart a Deployment's pods in place without rebuilding the image — the
 * Kubernetes equivalent of Docker's `service.update({ ForceUpdate })` reload.
 *
 * Stamps a fresh timestamp annotation on the pod template (exactly what
 * `kubectl rollout restart` does), which mutates the pod spec and triggers a
 * rolling restart. Read-then-replace mirrors how `applyDeployment` updates.
 */
export const rolloutRestartDeployment = async (
	client: KubernetesClient,
	appName: string,
	namespace: string,
	restartedAt: string = new Date().toISOString(),
): Promise<void> => {
	const deployment = await client.apps.readNamespacedDeployment({
		name: appName,
		namespace,
	});
	if (!deployment.spec?.template) {
		throw new Error(`Deployment '${appName}' has no pod template to restart`);
	}
	deployment.spec.template.metadata = deployment.spec.template.metadata ?? {};
	deployment.spec.template.metadata.annotations = {
		...(deployment.spec.template.metadata.annotations ?? {}),
		[RESTARTED_AT_ANNOTATION]: restartedAt,
	};
	await client.apps.replaceNamespacedDeployment({
		name: appName,
		namespace,
		body: deployment,
	});
};

/**
 * Set a Deployment's replica count — the Kubernetes equivalent of Docker's
 * `docker service scale <app>=<n>`. Used by start (scale up to the desired
 * replicas) and stop (scale to 0). Read-then-replace mirrors `applyDeployment`.
 */
export const scaleDeployment = async (
	client: KubernetesClient,
	appName: string,
	namespace: string,
	replicas: number,
): Promise<void> => {
	const deployment = await client.apps.readNamespacedDeployment({
		name: appName,
		namespace,
	});
	if (!deployment.spec) {
		throw new Error(`Deployment '${appName}' has no spec to scale`);
	}
	deployment.spec.replicas = replicas;
	await client.apps.replaceNamespacedDeployment({
		name: appName,
		namespace,
		body: deployment,
	});
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

export type RolloutStatus =
	| { state: "complete" }
	| { state: "progressing"; message: string }
	| { state: "failed"; message: string };

/**
 * The checks `kubectl rollout status` makes, in its order. During a rolling
 * update `availableReplicas` still counts the old pods, so the rollout is only
 * complete once no old pods are left and every new one is available.
 */
export const rolloutStatus = (deployment: V1Deployment): RolloutStatus => {
	const status = deployment.status ?? {};
	if (
		(status.observedGeneration ?? 0) < (deployment.metadata?.generation ?? 0)
	) {
		return {
			state: "progressing",
			message: "Waiting for the Deployment controller to pick up the change",
		};
	}
	const progressing = status.conditions?.find((c) => c.type === "Progressing");
	if (progressing?.reason === "ProgressDeadlineExceeded") {
		return {
			state: "failed",
			message: `no progress for ${deployment.spec?.progressDeadlineSeconds ?? 600}s`,
		};
	}
	const desired = deployment.spec?.replicas ?? 1;
	const updated = status.updatedReplicas ?? 0;
	const total = status.replicas ?? 0;
	const available = status.availableReplicas ?? 0;
	if (updated < desired) {
		return {
			state: "progressing",
			message: `${updated} of ${desired} new pod(s) created`,
		};
	}
	if (total > updated) {
		return {
			state: "progressing",
			message: `${total - updated} old pod(s) still running`,
		};
	}
	if (available < updated || (status.unavailableReplicas ?? 0) > 0) {
		return {
			state: "progressing",
			message: `${available} of ${updated} new pod(s) available`,
		};
	}
	return { state: "complete" };
};

const describeUnreadyPod = (pod: V1Pod): string => {
	const container = pod.status?.containerStatuses?.[0];
	const parts: string[] = [];
	if (container?.state?.waiting?.reason) {
		parts.push(container.state.waiting.reason);
	} else if (container?.state?.terminated?.reason) {
		parts.push(container.state.terminated.reason);
	} else if (container?.state?.running) {
		parts.push("running, readiness check not passing");
	} else {
		const unscheduled = pod.status?.conditions?.find(
			(c) => c.type === "PodScheduled" && c.status === "False",
		);
		parts.push(unscheduled?.message ?? pod.status?.phase ?? "unknown state");
	}
	const exitCode =
		container?.state?.terminated?.exitCode ??
		container?.lastState?.terminated?.exitCode;
	if (exitCode !== undefined) parts.push(`last exit code ${exitCode}`);
	if (container?.restartCount) parts.push(`${container.restartCount} restarts`);
	return `${pod.metadata?.name}: ${parts.join(", ")}`;
};

// Only for the failure message, so it never fails the wait itself.
const describeUnreadyPods = async (
	client: KubernetesClient,
	name: string,
	namespace: string,
): Promise<string> => {
	try {
		const pods = await client.core.listNamespacedPod({
			namespace,
			labelSelector: `app.kubernetes.io/name=${name}`,
		});
		const unready = pods.items.filter(
			(pod) =>
				!pod.metadata?.deletionTimestamp &&
				!pod.status?.conditions?.some(
					(c) => c.type === "Ready" && c.status === "True",
				),
		);
		return unready.length > 0
			? ` (${unready.map(describeUnreadyPod).join("; ")})`
			: "";
	} catch {
		return "";
	}
};

/**
 * Wait for a Deployment's rollout to finish, as `kubectl rollout status` does.
 * The Deployment's progress deadline decides when a stuck rollout has failed;
 * `timeoutMs` only bounds the wait if the controller never reports.
 */
export const waitForRollout = async (
	client: KubernetesClient,
	name: string,
	namespace: string,
	{
		onProgress,
		timeoutMs = 15 * 60 * 1000,
		intervalMs = 2_000,
	}: {
		/** Called with each new "still waiting" message. */
		onProgress?: (message: string) => Promise<void>;
		timeoutMs?: number;
		intervalMs?: number;
	} = {},
): Promise<{ ready: boolean; message?: string }> => {
	const deadline = Date.now() + timeoutMs;
	let reported = "";
	for (;;) {
		const deployment = await client.apps.readNamespacedDeployment({
			name,
			namespace,
		});
		const status = rolloutStatus(deployment);
		if (status.state === "complete") return { ready: true };
		if (status.state === "failed") {
			return {
				ready: false,
				message: `Rollout of '${name}' failed: ${status.message}${await describeUnreadyPods(client, name, namespace)}`,
			};
		}
		if (status.message !== reported) {
			reported = status.message;
			await onProgress?.(status.message);
		}
		if (Date.now() >= deadline) {
			return {
				ready: false,
				message: `Rollout of '${name}' did not finish in ${Math.round(timeoutMs / 60_000)}m: ${status.message}${await describeUnreadyPods(client, name, namespace)}`,
			};
		}
		await new Promise((r) => setTimeout(r, intervalMs));
	}
};
