import type { Registry } from "../../services/registry";
import type { KubernetesClient } from "./client";
import { k8sName } from "./deployment";
import { isHttpError } from "./errors";

const IMAGE_PULL_SECRET_NAME = "dokploy-registry";

const buildDockerConfigJson = (registry: Registry): string => {
	const auth = Buffer.from(
		`${registry.username}:${registry.password}`,
	).toString("base64");
	const url = registry.registryUrl?.trim() || "https://index.docker.io/v1/";
	return JSON.stringify({
		auths: {
			[url]: {
				username: registry.username,
				password: registry.password,
				auth,
			},
		},
	});
};

export const applyImagePullSecret = async (
	client: KubernetesClient,
	namespace: string,
	registry: Registry,
): Promise<string> => {
	const dockerconfig = buildDockerConfigJson(registry);
	const data = {
		".dockerconfigjson": Buffer.from(dockerconfig).toString("base64"),
	};
	const body = {
		apiVersion: "v1",
		kind: "Secret",
		type: "kubernetes.io/dockerconfigjson",
		metadata: {
			name: IMAGE_PULL_SECRET_NAME,
			namespace,
			labels: { "app.kubernetes.io/managed-by": "dokploy" },
		},
		data,
	};

	try {
		await client.core.readNamespacedSecret({
			name: IMAGE_PULL_SECRET_NAME,
			namespace,
		});
		await client.core.replaceNamespacedSecret({
			name: IMAGE_PULL_SECRET_NAME,
			namespace,
			body,
		});
	} catch (err) {
		if (isHttpError(err) && err.code === 404) {
			await client.core.createNamespacedSecret({ namespace, body });
		} else {
			throw err;
		}
	}

	return IMAGE_PULL_SECRET_NAME;
};

export const applyTlsSecret = async (
	client: KubernetesClient,
	namespace: string,
	secretName: string,
	certificateData: string,
	privateKey: string,
	/** App slug — sets the `app.kubernetes.io/name` label so the TLS Secret is
	 * cleaned up when the owning application is deleted. */
	ownerAppSlug: string,
): Promise<void> => {
	const body = {
		apiVersion: "v1",
		kind: "Secret",
		type: "kubernetes.io/tls",
		metadata: {
			name: secretName,
			namespace,
			labels: {
				"app.kubernetes.io/managed-by": "dokploy",
				"app.kubernetes.io/name": ownerAppSlug,
			},
		},
		data: {
			"tls.crt": Buffer.from(certificateData).toString("base64"),
			"tls.key": Buffer.from(privateKey).toString("base64"),
		},
	};

	try {
		await client.core.readNamespacedSecret({ name: secretName, namespace });
		await client.core.replaceNamespacedSecret({
			name: secretName,
			namespace,
			body,
		});
	} catch (err) {
		if (isHttpError(err) && err.code === 404) {
			await client.core.createNamespacedSecret({ namespace, body });
		} else {
			throw err;
		}
	}
};

/**
 * Apply (create-or-replace) the per-application env Secret. Returns the
 * Secret name when at least one env var is provided, `null` when the env
 * map is empty (caller should then omit `envFrom` from the Deployment).
 *
 * Labels: `app.kubernetes.io/managed-by=dokploy`, `app.kubernetes.io/name=<slug>`
 * — so `cleanupKubernetesApplication` can list-and-delete it on app delete.
 */
export const applyEnvSecret = async (
	client: KubernetesClient,
	namespace: string,
	appName: string,
	env: Record<string, string>,
): Promise<string | null> => {
	const slug = k8sName(appName);
	const secretName = `${slug}-env`;

	if (Object.keys(env).length === 0) {
		try {
			await client.core.deleteNamespacedSecret({
				name: secretName,
				namespace,
			});
		} catch (err) {
			if (!isHttpError(err) || err.code !== 404) throw err;
		}
		return null;
	}

	const body = {
		apiVersion: "v1",
		kind: "Secret",
		type: "Opaque",
		metadata: {
			name: secretName,
			namespace,
			labels: {
				"app.kubernetes.io/managed-by": "dokploy",
				"app.kubernetes.io/name": slug,
			},
		},
		stringData: env,
	};

	try {
		await client.core.readNamespacedSecret({ name: secretName, namespace });
		await client.core.replaceNamespacedSecret({
			name: secretName,
			namespace,
			body,
		});
	} catch (err) {
		if (isHttpError(err) && err.code === 404) {
			await client.core.createNamespacedSecret({ namespace, body });
		} else {
			throw err;
		}
	}

	return secretName;
};

export { IMAGE_PULL_SECRET_NAME };
