import type { V1ResourceRequirements } from "@kubernetes/client-node";

/** Docker units, as stored on the service row: nanoCPUs and bytes. */
export interface ResourceSettings {
	cpuLimit?: string | null;
	memoryLimit?: string | null;
	cpuReservation?: string | null;
	memoryReservation?: string | null;
}

// Used for whatever the user leaves blank. With no requests at all, GKE
// Autopilot reserves 500m CPU / 2Gi memory per container, and other clusters
// run the pod as BestEffort with no ceiling.
const DEFAULT_CPU_REQUEST_MILLICORES = 100;
const DEFAULT_MEMORY_REQUEST_MIB = 256;
const DEFAULT_CPU_LIMIT_MILLICORES = 1000;
const DEFAULT_MEMORY_LIMIT_MIB = 1024;

const toMillicores = (nanoCpus?: string | null): number | undefined => {
	if (!nanoCpus) return undefined;
	const n = Number.parseInt(nanoCpus, 10);
	if (Number.isNaN(n) || n <= 0) return undefined;
	return Math.max(1, Math.round(n / 1_000_000));
};

const toMebibytes = (bytes?: string | null): number | undefined => {
	if (!bytes) return undefined;
	const n = Number.parseInt(bytes, 10);
	if (Number.isNaN(n) || n <= 0) return undefined;
	return Math.max(1, Math.floor(n / (1024 * 1024)));
};

// Kubernetes rejects a request above its limit, so a default never crosses a
// value the user did set: a large reservation raises the default limit, and a
// small limit lowers the default request.
const withDefaults = (
	request: number | undefined,
	limit: number | undefined,
	defaultRequest: number,
	defaultLimit: number,
) => ({
	request: request ?? Math.min(defaultRequest, limit ?? defaultRequest),
	limit: limit ?? Math.max(defaultLimit, request ?? defaultLimit),
});

export const buildContainerResources = (
	settings: ResourceSettings,
): V1ResourceRequirements => {
	const cpu = withDefaults(
		toMillicores(settings.cpuReservation),
		toMillicores(settings.cpuLimit),
		DEFAULT_CPU_REQUEST_MILLICORES,
		DEFAULT_CPU_LIMIT_MILLICORES,
	);
	const memory = withDefaults(
		toMebibytes(settings.memoryReservation),
		toMebibytes(settings.memoryLimit),
		DEFAULT_MEMORY_REQUEST_MIB,
		DEFAULT_MEMORY_LIMIT_MIB,
	);
	return {
		requests: { cpu: `${cpu.request}m`, memory: `${memory.request}Mi` },
		limits: { cpu: `${cpu.limit}m`, memory: `${memory.limit}Mi` },
	};
};
