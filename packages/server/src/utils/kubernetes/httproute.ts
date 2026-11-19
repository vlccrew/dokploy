import type { Domain } from "../../services/domain";
import type { ApplicationNested } from "../builders";
import type { KubernetesClient } from "./client";
import { k8sLabelValue, k8sName } from "./deployment";
import { isHttpError } from "./errors";
import { ingressName, staleIngressNames } from "./ingress";

export interface GatewayRef {
	name: string;
	namespace: string;
}

export interface KubernetesRouting {
	ingress: boolean;
	gateway: GatewayRef | null;
}

type Log = (line: string) => Promise<void>;

const HTTP_ROUTES = {
	group: "gateway.networking.k8s.io",
	version: "v1",
	plural: "httproutes",
} as const;

export const resolveRouting = (cluster: {
	name: string;
	routingMode: "ingress" | "gateway" | "both";
	gatewayName: string | null;
	gatewayNamespace: string | null;
}): KubernetesRouting => {
	if (cluster.routingMode === "ingress") {
		return { ingress: true, gateway: null };
	}
	if (!cluster.gatewayName || !cluster.gatewayNamespace) {
		throw new Error(
			`Cluster '${cluster.name}' routes through a Gateway but has no Gateway name and namespace set. Set them in the cluster settings.`,
		);
	}
	return {
		ingress: cluster.routingMode === "both",
		gateway: { name: cluster.gatewayName, namespace: cluster.gatewayNamespace },
	};
};

// Mirrors the Traefik middlewares in utils/traefik/domain.ts: strip the public
// path first, then prepend internalPath (skipped when it equals the path).
const upstreamPrefix = (
	path: string,
	domain: Pick<Domain, "stripPath" | "internalPath">,
): string | undefined => {
	const base = domain.stripPath ? "/" : path;
	const internal =
		domain.internalPath &&
		domain.internalPath !== "/" &&
		domain.internalPath !== path
			? domain.internalPath.replace(/\/+$/, "")
			: "";
	const target = internal ? `${internal}${base === "/" ? "" : base}` : base;
	return target === path ? undefined : target;
};

export interface HttpRouteBuildInput {
	application: Pick<ApplicationNested, "appName" | "applicationId">;
	domain: Domain;
	namespace: string;
	gateway: GatewayRef;
}

export const buildHttpRouteManifest = ({
	application,
	domain,
	namespace,
	gateway,
}: HttpRouteBuildInput) => {
	const appName = k8sName(application.appName);
	const path = domain.path && domain.path !== "" ? domain.path : "/";
	const prefix = upstreamPrefix(path, domain);
	return {
		apiVersion: `${HTTP_ROUTES.group}/${HTTP_ROUTES.version}`,
		kind: "HTTPRoute" as const,
		metadata: {
			// Same name as the domain's Ingress, so "both" mode pairs them up and
			// the stale-name logic applies to either kind.
			name: ingressName(appName, domain.uniqueConfigKey),
			namespace,
			labels: {
				"app.kubernetes.io/managed-by": "dokploy",
				"app.kubernetes.io/name": appName,
				"dokploy.io/application-id": k8sLabelValue(application.applicationId),
				"dokploy.io/domain-id": k8sLabelValue(domain.domainId),
			},
		},
		spec: {
			parentRefs: [
				{
					group: HTTP_ROUTES.group,
					kind: "Gateway",
					name: gateway.name,
					namespace: gateway.namespace,
				},
			],
			hostnames: [domain.host],
			rules: [
				{
					matches: [{ path: { type: "PathPrefix", value: path } }],
					...(prefix && {
						filters: [
							{
								type: "URLRewrite",
								urlRewrite: {
									path: {
										type: "ReplacePrefixMatch",
										replacePrefixMatch: prefix,
									},
								},
							},
						],
					}),
					backendRefs: [
						{
							group: "",
							kind: "Service",
							name: appName,
							port: domain.port ?? 3000,
						},
					],
					// Envoy otherwise ends every request 15s after it starts, which
					// cuts off streamed responses. nginx only gives up after 60s
					// without data; Envoy's stream idle timeout still covers that.
					timeouts: { request: "0s" },
				},
			],
		},
	};
};

type HttpRoute = ReturnType<typeof buildHttpRouteManifest>;

interface RouteCondition {
	type: string;
	status: string;
	reason?: string;
	message?: string;
	observedGeneration?: number;
}

interface RouteObject {
	metadata?: { name?: string; generation?: number; resourceVersion?: string };
	status?: {
		parents?: {
			parentRef?: { name?: string; namespace?: string };
			conditions?: RouteCondition[];
		}[];
	};
}

export const applyHttpRoute = async (
	client: KubernetesClient,
	body: HttpRoute,
): Promise<void> => {
	const { name, namespace } = body.metadata;
	let existing: RouteObject;
	try {
		existing = await client.custom.getNamespacedCustomObject({
			...HTTP_ROUTES,
			namespace,
			name,
		});
	} catch (err) {
		if (!isHttpError(err) || err.code !== 404) throw err;
		try {
			await client.custom.createNamespacedCustomObject({
				...HTTP_ROUTES,
				namespace,
				body,
			});
		} catch (createErr) {
			// A second 404 means the HTTPRoute kind itself is missing.
			if (isHttpError(createErr) && createErr.code === 404) {
				throw new Error(
					"The cluster has no HTTPRoute API. Install the Gateway API CRDs and kgateway, or switch the cluster's routing back to Ingress.",
				);
			}
			throw createErr;
		}
		return;
	}
	await client.custom.replaceNamespacedCustomObject({
		...HTTP_ROUTES,
		namespace,
		name,
		body: {
			...body,
			metadata: {
				...body.metadata,
				resourceVersion: existing.metadata?.resourceVersion,
			},
		},
	});
};

/**
 * Delete the app's HTTPRoutes that don't belong to one of `domains` (all of
 * them when `domains` is empty). A cluster without the Gateway API has nothing
 * to delete.
 */
export const pruneHttpRoutes = async (
	client: KubernetesClient,
	appName: string,
	domains: Pick<Domain, "uniqueConfigKey">[],
	namespace: string,
): Promise<string[]> => {
	let list: { items?: RouteObject[] };
	try {
		list = await client.custom.listNamespacedCustomObject({
			...HTTP_ROUTES,
			namespace,
			labelSelector: `app.kubernetes.io/name=${k8sName(appName)}`,
		});
	} catch (err) {
		if (isHttpError(err) && err.code === 404) return [];
		throw err;
	}
	const existing = (list.items ?? [])
		.map((route) => route.metadata?.name)
		.filter((n): n is string => Boolean(n));
	const removed: string[] = [];
	for (const name of staleIngressNames(appName, domains, existing)) {
		try {
			await client.custom.deleteNamespacedCustomObject({
				...HTTP_ROUTES,
				namespace,
				name,
			});
			removed.push(name);
		} catch (err) {
			if (!isHttpError(err) || err.code !== 404) throw err;
		}
	}
	return removed;
};

export const removeHttpRoute = async (
	client: KubernetesClient,
	appName: string,
	uniqueKey: number,
	namespace: string,
): Promise<void> => {
	try {
		await client.custom.deleteNamespacedCustomObject({
			...HTTP_ROUTES,
			namespace,
			name: ingressName(k8sName(appName), uniqueKey),
		});
	} catch (err) {
		if (!isHttpError(err) || err.code !== 404) throw err;
	}
};

export type RouteAcceptance =
	| { state: "accepted" }
	| { state: "rejected"; reason: string; message: string }
	| { state: "unknown" };

/**
 * Wait for the Gateway's controller to report on the route. A route whose
 * hostname no listener covers is rejected here rather than at apply time, so
 * this is where a domain the Gateway can't serve shows up.
 */
export const waitForHttpRouteAcceptance = async (
	client: KubernetesClient,
	name: string,
	namespace: string,
	gateway: GatewayRef,
	{ timeoutMs = 15_000, intervalMs = 1_000 } = {},
): Promise<RouteAcceptance> => {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const route: RouteObject = await client.custom.getNamespacedCustomObject({
			...HTTP_ROUTES,
			namespace,
			name,
		});
		const generation = route.metadata?.generation ?? 0;
		const parent = route.status?.parents?.find(
			(p) =>
				p.parentRef?.name === gateway.name &&
				(p.parentRef?.namespace ?? namespace) === gateway.namespace,
		);
		const current = (parent?.conditions ?? []).filter(
			(c) => (c.observedGeneration ?? generation) >= generation,
		);
		const failed = current.find(
			(c) =>
				(c.type === "Accepted" || c.type === "ResolvedRefs") &&
				c.status === "False",
		);
		if (failed) {
			return {
				state: "rejected",
				reason: failed.reason ?? failed.type,
				message: failed.message ?? "",
			};
		}
		if (current.some((c) => c.type === "Accepted" && c.status === "True")) {
			return { state: "accepted" };
		}
		if (Date.now() >= deadline) return { state: "unknown" };
		await new Promise((r) => setTimeout(r, intervalMs));
	}
};

export const applyGatewayRoutes = async ({
	client,
	application,
	domains,
	namespace,
	gateway,
	log,
	acceptanceTimeoutMs,
}: {
	client: KubernetesClient;
	application: Pick<
		ApplicationNested,
		"appName" | "applicationId" | "redirects" | "security"
	>;
	domains: Domain[];
	namespace: string;
	gateway: GatewayRef;
	log: Log;
	acceptanceTimeoutMs?: number;
}): Promise<void> => {
	const gatewayLabel = `${gateway.namespace}/${gateway.name}`;
	try {
		const removed = await pruneHttpRoutes(
			client,
			application.appName,
			domains,
			namespace,
		);
		for (const name of removed) {
			await log(`🧹 Removed stale HTTPRoute '${name}'`);
		}
	} catch (err) {
		await log(
			`⚠️  Stale-HTTPRoute cleanup skipped: ${err instanceof Error ? err.message : String(err)}`,
		);
	}

	if (domains.length === 0) {
		await log("ℹ️  No domains attached — skipping HTTPRoute");
		return;
	}

	if ((application.redirects ?? []).length > 0) {
		await log(
			"⚠️  Redirects aren't applied on the Gateway: the Gateway API has no regex redirects.",
		);
	}
	if ((application.security ?? []).length > 0) {
		await log(
			"⚠️  Basic auth isn't applied on the Gateway yet; these routes are open.",
		);
	}

	const routes: { domain: Domain; name: string }[] = [];
	for (const domain of domains) {
		const body = buildHttpRouteManifest({
			application,
			domain,
			namespace,
			gateway,
		});
		await applyHttpRoute(client, body);
		routes.push({ domain, name: body.metadata.name });
		await log(
			`✅ HTTPRoute for '${domain.host}${domain.path ?? "/"}' (port ${domain.port ?? 3000}) applied to Gateway '${gatewayLabel}'`,
		);
		if (domain.https && domain.certificateType === "custom") {
			await log(
				`ℹ️  '${domain.host}' uses the Gateway listener's certificate; the custom certificate only applies to an Ingress.`,
			);
		}
	}

	for (const { domain, name } of routes) {
		let result: RouteAcceptance;
		try {
			result = await waitForHttpRouteAcceptance(
				client,
				name,
				namespace,
				gateway,
				{ timeoutMs: acceptanceTimeoutMs },
			);
		} catch (err) {
			await log(
				`⚠️  Couldn't read the status of the route for '${domain.host}': ${err instanceof Error ? err.message : String(err)}`,
			);
			continue;
		}
		if (result.state === "accepted") {
			await log(
				`✅ Gateway '${gatewayLabel}' accepted the route for '${domain.host}'`,
			);
		} else if (result.state === "rejected") {
			await log(
				`⚠️  Gateway '${gatewayLabel}' rejected the route for '${domain.host}': ${result.reason}${result.message ? ` — ${result.message}` : ""}`,
			);
		} else if (result.state === "unknown") {
			await log(
				`⚠️  Gateway '${gatewayLabel}' hasn't reported on the route for '${domain.host}'. Check that the Gateway exists and its controller is running.`,
			);
		}
	}
};
