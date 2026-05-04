import { eq } from "drizzle-orm";
import { db } from "../../db";
import { certificates as certificatesTable } from "../../db/schema";
import type { Domain } from "../../services/domain";
import type { ApplicationNested } from "../builders";
import type { KubernetesClient } from "./client";
import { k8sName } from "./deployment";
import { isHttpError } from "./errors";
import { applyTlsSecret } from "./secrets";

export interface IngressContext {
	ingressClassName: string;
	tlsIssuerName?: string | null;
}

const ingressName = (appName: string, uniqueKey: number | null | undefined) =>
	k8sName(`${appName}-${uniqueKey ?? "default"}`);

const annotationsForApp = (
	application: ApplicationNested,
): Record<string, string> => {
	const ann: Record<string, string> = {
		"app.kubernetes.io/managed-by": "dokploy",
	};
	const redirects = application.redirects ?? [];
	if (redirects.length > 0) {
		const lines = redirects
			.map(
				(r) =>
					`if ($request_uri ~* "${r.regex}") { return ${
						r.permanent ? 308 : 307
					} ${r.replacement}; }`,
			)
			.join("\n");
		ann["nginx.ingress.kubernetes.io/configuration-snippet"] = lines;
	}
	const security = application.security?.[0];
	if (security) {
		ann["nginx.ingress.kubernetes.io/auth-type"] = "basic";
		ann["nginx.ingress.kubernetes.io/auth-secret"] = `${k8sName(
			application.appName,
		)}-basic-auth`;
		ann["nginx.ingress.kubernetes.io/auth-realm"] = "Authentication Required";
	}
	return ann;
};

export interface IngressBuildInput {
	application: ApplicationNested;
	domain: Domain;
	namespace: string;
	context: IngressContext;
}

export const buildIngressManifest = ({
	application,
	domain,
	namespace,
	context,
}: IngressBuildInput) => {
	const appName = k8sName(application.appName);
	const name = ingressName(appName, domain.uniqueConfigKey);
	const port = domain.port ?? 3000;
	const path = domain.path && domain.path !== "" ? domain.path : "/";
	const annotations: Record<string, string> = {
		...annotationsForApp(application),
		"nginx.ingress.kubernetes.io/backend-protocol": "HTTP",
	};

	if (domain.internalPath && domain.internalPath !== "/") {
		annotations["nginx.ingress.kubernetes.io/rewrite-target"] = domain.stripPath
			? domain.internalPath
			: `${domain.internalPath}$1`;
	} else if (domain.stripPath) {
		annotations["nginx.ingress.kubernetes.io/rewrite-target"] = "/";
	}

	if (domain.https && domain.certificateType === "letsencrypt") {
		if (context.tlsIssuerName) {
			annotations["cert-manager.io/cluster-issuer"] = context.tlsIssuerName;
		}
	}

	const tls =
		domain.https && domain.certificateType !== "none"
			? [
					{
						hosts: [domain.host],
						secretName: k8sName(`${name}-tls`),
					},
				]
			: undefined;

	return {
		apiVersion: "networking.k8s.io/v1",
		kind: "Ingress" as const,
		metadata: {
			name,
			namespace,
			labels: {
				"app.kubernetes.io/managed-by": "dokploy",
				"app.kubernetes.io/name": appName,
				"dokploy.io/domain-id": domain.domainId,
			},
			annotations,
		},
		spec: {
			ingressClassName: context.ingressClassName,
			rules: [
				{
					host: domain.host,
					http: {
						paths: [
							{
								path,
								pathType: "Prefix",
								backend: {
									service: {
										name: appName,
										port: { number: port },
									},
								},
							},
						],
					},
				},
			],
			...(tls && { tls }),
		},
	};
};

export const manageIngress = async (
	client: KubernetesClient,
	application: ApplicationNested,
	domain: Domain,
	namespace: string,
	context: IngressContext,
): Promise<void> => {
	if (
		domain.https &&
		domain.certificateType === "custom" &&
		domain.customCertResolver
	) {
		const cert = await db.query.certificates.findFirst({
			where: eq(certificatesTable.certificatePath, domain.customCertResolver),
		});
		if (cert) {
			const secretName = k8sName(
				`${ingressName(k8sName(application.appName), domain.uniqueConfigKey)}-tls`,
			);
			await applyTlsSecret(
				client,
				namespace,
				secretName,
				cert.certificateData,
				cert.privateKey,
			);
		}
	}

	const body = buildIngressManifest({
		application,
		domain,
		namespace,
		context,
	});
	const name = body.metadata.name;
	try {
		await client.networking.readNamespacedIngress({ name, namespace });
		await client.networking.replaceNamespacedIngress({
			name,
			namespace,
			body,
		});
	} catch (err) {
		if (isHttpError(err) && err.code === 404) {
			await client.networking.createNamespacedIngress({ namespace, body });
		} else {
			throw err;
		}
	}
};

export const removeIngress = async (
	client: KubernetesClient,
	appName: string,
	uniqueKey: number,
	namespace: string,
): Promise<void> => {
	const name = ingressName(k8sName(appName), uniqueKey);
	try {
		await client.networking.deleteNamespacedIngress({ name, namespace });
	} catch (err) {
		if (!isHttpError(err) || err.code !== 404) throw err;
	}
};
