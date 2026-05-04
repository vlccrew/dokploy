import type { ApplicationNested } from "../builders";
import type { KubernetesClient } from "./client";
import { k8sName } from "./deployment";
import { isHttpError } from "./errors";

export interface ApplicationWithDomains extends ApplicationNested {
	domains: { port: number | null }[];
}

export const buildServiceManifest = (
	application: ApplicationWithDomains,
	namespace: string,
) => {
	const appName = k8sName(application.appName);
	const labels = { "app.kubernetes.io/name": appName };
	const containerPorts = new Set<number>();
	for (const p of application.ports) containerPorts.add(p.targetPort);
	for (const d of application.domains) {
		if (d.port) containerPorts.add(d.port);
	}
	if (containerPorts.size === 0) containerPorts.add(3000);

	const ports = [...containerPorts].map((port) => ({
		name: `port-${port}`,
		port,
		targetPort: port,
		protocol: "TCP",
	}));

	return {
		apiVersion: "v1",
		kind: "Service" as const,
		metadata: {
			name: appName,
			namespace,
			labels: { ...labels, "app.kubernetes.io/managed-by": "dokploy" },
		},
		spec: {
			type: "ClusterIP",
			selector: labels,
			ports,
		},
	};
};

export const applyService = async (
	client: KubernetesClient,
	application: ApplicationWithDomains,
	namespace: string,
): Promise<void> => {
	const body = buildServiceManifest(application, namespace);
	const name = body.metadata.name;
	try {
		const existing = await client.core.readNamespacedService({
			name,
			namespace,
		});
		const merged = {
			...body,
			metadata: {
				...body.metadata,
				resourceVersion: existing.metadata?.resourceVersion,
			},
			spec: { ...body.spec, clusterIP: existing.spec?.clusterIP },
		};
		await client.core.replaceNamespacedService({
			name,
			namespace,
			body: merged,
		});
	} catch (err) {
		if (isHttpError(err) && err.code === 404) {
			await client.core.createNamespacedService({ namespace, body });
		} else {
			throw err;
		}
	}
};

export const deleteService = async (
	client: KubernetesClient,
	appName: string,
	namespace: string,
): Promise<void> => {
	try {
		await client.core.deleteNamespacedService({
			name: k8sName(appName),
			namespace,
		});
	} catch (err) {
		if (!isHttpError(err) || err.code !== 404) throw err;
	}
};
