import { eq, or } from "drizzle-orm";
import { db } from "../../db";
import { certificates as certificatesTable } from "../../db/schema";
import type { Domain } from "../../services/domain";
import type { ApplicationNested } from "../builders";
import type { KubernetesClient } from "./client";
import { k8sLabelValue, k8sName } from "./deployment";
import { isHttpError } from "./errors";
import { applyTlsSecret } from "./secrets";

export interface IngressContext {
	ingressClassName: string;
	tlsIssuerName?: string | null;
}

export const ingressName = (
	appName: string,
	uniqueKey: number | null | undefined,
) => k8sName(`${appName}-${uniqueKey ?? "default"}`);

type TlsDomain = Pick<
	Domain,
	"host" | "https" | "certificateType" | "uniqueConfigKey"
>;

/**
 * The Secret that holds a domain's certificate.
 *
 * An app's Let's Encrypt domains on the same host share one Secret, named
 * after the oldest of them (lowest `uniqueConfigKey`). With a Secret per
 * domain, cert-manager ordered a certificate for every path of a host, and
 * Let's Encrypt issues at most 5 per week for the same host, so the sixth
 * path's certificate failed. nginx serves one certificate per host anyway.
 * Reusing an existing domain's name means an app deployed before this keeps
 * the certificate it already has, rather than ordering a new one and serving
 * nginx's self-signed fallback until it arrives.
 *
 * A custom certificate keeps a Secret per domain, since manageIngress writes
 * each one from that domain's own certificate.
 */
export const tlsSecretName = (
	appName: string,
	domain: TlsDomain,
	domains: TlsDomain[] = [],
): string => {
	let key = domain.uniqueConfigKey;
	if (domain.certificateType === "letsencrypt") {
		const host = domain.host.toLowerCase();
		for (const other of domains) {
			if (
				other.https &&
				other.certificateType === "letsencrypt" &&
				other.host.toLowerCase() === host &&
				other.uniqueConfigKey != null &&
				(key == null || other.uniqueConfigKey < key)
			) {
				key = other.uniqueConfigKey;
			}
		}
	}
	return k8sName(`${ingressName(k8sName(appName), key)}-tls`);
};

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
	/** The app's domains being exposed; picks the shared TLS Secret. */
	domains?: Domain[];
	namespace: string;
	context: IngressContext;
}

export const buildIngressManifest = ({
	application,
	domain,
	domains = [],
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
						secretName: tlsSecretName(application.appName, domain, domains),
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
				"dokploy.io/application-id": k8sLabelValue(application.applicationId),
				"dokploy.io/domain-id": k8sLabelValue(domain.domainId),
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
	domains: Domain[],
): Promise<void> => {
	if (
		domain.https &&
		domain.certificateType === "custom" &&
		domain.customCertResolver
	) {
		// The UI stores the certificate's `name` in `customCertResolver`
		// (the field is named after the Traefik concept of a "cert resolver").
		// Fall back to certificatePath for older rows / Traefik parity.
		const cert = await db.query.certificates.findFirst({
			where: or(
				eq(certificatesTable.name, domain.customCertResolver),
				eq(certificatesTable.certificatePath, domain.customCertResolver),
			),
		});
		if (cert) {
			await applyTlsSecret(
				client,
				namespace,
				tlsSecretName(application.appName, domain),
				cert.certificateData,
				cert.privateKey,
				k8sName(application.appName),
			);
		}
	}

	const body = buildIngressManifest({
		application,
		domain,
		domains,
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

/**
 * Given the app's current domains and the Ingress names that currently exist in
 * the cluster for this app, return the names that are orphaned and should be
 * deleted.
 *
 * Ingress names embed the domain's `uniqueConfigKey`, a Postgres `serial`.
 * Deleting + recreating a domain (or editing one in a way that replaces the row)
 * yields a new key and therefore a new Ingress name, leaving the old Ingress
 * behind. Because the old and new Ingress share the same host + path, nginx's
 * admission webhook rejects the new one ("host ... and path ... is already
 * defined in ingress ..."). Pruning the orphans clears that collision.
 */
export const staleIngressNames = (
	appName: string,
	domains: Pick<Domain, "uniqueConfigKey">[],
	existingNames: string[],
): string[] => {
	const slug = k8sName(appName);
	const desired = new Set(
		domains.map((d) => ingressName(slug, d.uniqueConfigKey)),
	);
	return existingNames.filter((name) => !desired.has(name));
};

/**
 * Delete every Ingress owned by the app (matched by the `app.kubernetes.io/name`
 * label) that no longer maps to a current domain. Returns the names removed.
 * 404s are ignored; any other delete error propagates so the caller can decide.
 */
export const pruneStaleIngresses = async (
	client: KubernetesClient,
	appName: string,
	domains: Pick<Domain, "uniqueConfigKey">[],
	namespace: string,
): Promise<string[]> => {
	const slug = k8sName(appName);
	const list = await client.networking.listNamespacedIngress({
		namespace,
		labelSelector: `app.kubernetes.io/name=${slug}`,
	});
	const existing = (list.items ?? [])
		.map((ing) => ing.metadata?.name)
		.filter((n): n is string => Boolean(n));
	const stale = staleIngressNames(appName, domains, existing);
	const removed: string[] = [];
	for (const name of stale) {
		try {
			await client.networking.deleteNamespacedIngress({ name, namespace });
			removed.push(name);
		} catch (err) {
			if (!isHttpError(err) || err.code !== 404) throw err;
		}
	}
	return removed;
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
