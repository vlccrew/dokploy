import type { Registry } from "../../services/registry";
import type { KubernetesClient } from "./client";
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
): Promise<void> => {
	const body = {
		apiVersion: "v1",
		kind: "Secret",
		type: "kubernetes.io/tls",
		metadata: {
			name: secretName,
			namespace,
			labels: { "app.kubernetes.io/managed-by": "dokploy" },
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

export { IMAGE_PULL_SECRET_NAME };
