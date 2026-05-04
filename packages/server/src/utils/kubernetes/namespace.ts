import { eq } from "drizzle-orm";
import slugify from "slugify";
import { db } from "../../db";
import { projects } from "../../db/schema";
import type { KubernetesClient } from "./client";
import { isHttpError } from "./errors";

export const computeNamespaceName = (
	prefix: string,
	projectName: string,
	projectId: string,
): string => {
	const slug = slugify(projectName, { lower: true, strict: true });
	const shortId = projectId.slice(0, 6).toLowerCase();
	const raw = `${prefix}-${slug}-${shortId}`;
	// k8s namespace: lowercase alphanumeric and dashes, max 63 chars, must start/end alphanumeric
	const cleaned = raw.replace(/[^a-z0-9-]/g, "-").replace(/^-+|-+$/g, "");
	return cleaned.slice(0, 63);
};

export const ensureNamespace = async (
	client: KubernetesClient,
	project: {
		projectId: string;
		name: string;
		kubernetesNamespace: string | null;
	},
	prefix: string,
): Promise<string> => {
	let namespace = project.kubernetesNamespace;
	if (!namespace) {
		namespace = computeNamespaceName(prefix, project.name, project.projectId);
		await db
			.update(projects)
			.set({ kubernetesNamespace: namespace })
			.where(eq(projects.projectId, project.projectId));
	}

	try {
		await client.core.readNamespace({ name: namespace });
	} catch (err) {
		if (isHttpError(err) && err.code === 404) {
			await client.core.createNamespace({
				body: {
					apiVersion: "v1",
					kind: "Namespace",
					metadata: {
						name: namespace,
						labels: {
							"app.kubernetes.io/managed-by": "dokploy",
							"dokploy.io/project-id": project.projectId,
						},
					},
				},
			});
		} else {
			throw err;
		}
	}

	return namespace;
};

export const deleteNamespace = async (
	client: KubernetesClient,
	namespace: string,
): Promise<void> => {
	try {
		await client.core.deleteNamespace({ name: namespace });
	} catch (err) {
		if (isHttpError(err) && err.code === 404) return;
		throw err;
	}
};
