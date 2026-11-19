import type {
	ApplicationNested,
	Domain,
	KubernetesClient,
} from "@dokploy/server";
import {
	applyGatewayRoutes,
	buildHttpRouteManifest,
	ingressName,
	pruneHttpRoutes,
	resolveRouting,
} from "@dokploy/server";
import { describe, expect, test, vi } from "vitest";

const app = {
	appName: "test-app-abc123",
	applicationId: "app-1",
	redirects: [],
	security: [],
} as unknown as Pick<
	ApplicationNested,
	"appName" | "applicationId" | "redirects" | "security"
>;

const domain: Domain = {
	applicationId: "app-1",
	certificateType: "letsencrypt",
	createdAt: "",
	domainId: "dom-1",
	host: "crystal.agent.certu.ai",
	https: true,
	path: "/",
	port: 3000,
	customEntrypoint: null,
	serviceName: null,
	composeId: null,
	customCertResolver: null,
	domainType: "application",
	uniqueConfigKey: 1,
	previewDeploymentId: null,
	internalPath: "/",
	stripPath: false,
	middlewares: null,
	enabled: true,
	forwardAuthEnabled: false,
};

const gateway = { name: "certu-gateway", namespace: "kgateway-system" };

const build = (overrides: Partial<Domain> = {}) =>
	buildHttpRouteManifest({
		application: app,
		domain: { ...domain, ...overrides },
		namespace: "dokploy-test",
		gateway,
	});

const rewriteOf = (route: ReturnType<typeof build>) =>
	(
		route.spec.rules[0] as {
			filters?: {
				urlRewrite: { path: { replacePrefixMatch: string } };
			}[];
		}
	).filters?.[0]?.urlRewrite.path.replacePrefixMatch;

describe("resolveRouting", () => {
	const cluster = {
		name: "gke",
		routingMode: "ingress" as const,
		gatewayName: null,
		gatewayNamespace: null,
	};

	test("ingress mode ignores any Gateway settings", () => {
		expect(
			resolveRouting({ ...cluster, gatewayName: "certu-gateway" }),
		).toEqual({ ingress: true, gateway: null });
	});

	test("gateway mode needs both the Gateway's name and namespace", () => {
		expect(() =>
			resolveRouting({
				...cluster,
				routingMode: "gateway",
				gatewayName: "certu-gateway",
			}),
		).toThrow(/no Gateway name and namespace/);
	});

	test("both mode keeps the Ingress alongside the Gateway", () => {
		expect(
			resolveRouting({
				...cluster,
				routingMode: "both",
				gatewayName: "certu-gateway",
				gatewayNamespace: "kgateway-system",
			}),
		).toEqual({ ingress: true, gateway });
	});
});

describe("buildHttpRouteManifest", () => {
	test("routes the domain's host to the app's Service through the Gateway", () => {
		const route = build();
		expect(route).toEqual({
			apiVersion: "gateway.networking.k8s.io/v1",
			kind: "HTTPRoute",
			metadata: {
				name: ingressName("test-app-abc123", 1),
				namespace: "dokploy-test",
				labels: {
					"app.kubernetes.io/managed-by": "dokploy",
					"app.kubernetes.io/name": "test-app-abc123",
					"dokploy.io/application-id": "app-1",
					"dokploy.io/domain-id": "dom-1",
				},
			},
			spec: {
				parentRefs: [
					{
						group: "gateway.networking.k8s.io",
						kind: "Gateway",
						name: "certu-gateway",
						namespace: "kgateway-system",
					},
				],
				hostnames: ["crystal.agent.certu.ai"],
				rules: [
					{
						matches: [{ path: { type: "PathPrefix", value: "/" } }],
						backendRefs: [
							{
								group: "",
								kind: "Service",
								name: "test-app-abc123",
								port: 3000,
							},
						],
						timeouts: { request: "0s" },
					},
				],
			},
		});
	});

	test.each([
		["strip only", { path: "/api", stripPath: true }, "/"],
		["internal path only", { internalPath: "/v1" }, "/v1"],
		[
			"internal path under a public path",
			{ path: "/api", internalPath: "/v1" },
			"/v1/api",
		],
		[
			"strip, then internal path",
			{ path: "/api", stripPath: true, internalPath: "/v1/" },
			"/v1",
		],
	])("rewrites the path like Traefik does: %s", (_, overrides, expected) => {
		expect(rewriteOf(build(overrides))).toBe(expected);
	});

	test("no rewrite when the upstream path is unchanged", () => {
		expect(rewriteOf(build({ path: "/api" }))).toBeUndefined();
		expect(
			rewriteOf(build({ path: "/api", internalPath: "/api" })),
		).toBeUndefined();
	});
});

const httpError = (code: number) =>
	Object.assign(new Error(`HTTP ${code}`), { code });

type Conditions = {
	type: string;
	status: string;
	reason?: string;
	observedGeneration?: number;
}[];

/** In-memory HTTPRoute store; `report` plays the Gateway controller. */
const fakeCluster = (
	report: (name: string) => Conditions | undefined,
	existing: string[] = [],
) => {
	const routes = new Map<string, Record<string, any>>(
		existing.map((name) => [
			name,
			{ metadata: { name, generation: 1, resourceVersion: "41" } },
		]),
	);
	const custom = {
		getNamespacedCustomObject: vi.fn(async ({ name }: { name: string }) => {
			const route = routes.get(name);
			if (!route) throw httpError(404);
			const conditions = report(name);
			return conditions
				? {
						...route,
						status: {
							parents: [
								{
									parentRef: gateway,
									conditions: conditions.map((c) => ({
										observedGeneration: route.metadata.generation,
										...c,
									})),
								},
							],
						},
					}
				: route;
		}),
		createNamespacedCustomObject: vi.fn(
			async ({ body }: { body: Record<string, any> }) => {
				routes.set(body.metadata.name, {
					...body,
					metadata: { ...body.metadata, generation: 1 },
				});
			},
		),
		replaceNamespacedCustomObject: vi.fn(
			async ({ name, body }: { name: string; body: Record<string, any> }) => {
				const generation = routes.get(name)?.metadata.generation ?? 0;
				routes.set(name, {
					...body,
					metadata: { ...body.metadata, generation: generation + 1 },
				});
			},
		),
		listNamespacedCustomObject: vi.fn(async () => ({
			items: [...routes.values()],
		})),
		deleteNamespacedCustomObject: vi.fn(async ({ name }: { name: string }) => {
			routes.delete(name);
		}),
	};
	return { custom, routes, client: { custom } as unknown as KubernetesClient };
};

const run = async (
	client: KubernetesClient,
	overrides: Partial<Parameters<typeof applyGatewayRoutes>[0]> = {},
) => {
	const lines: string[] = [];
	await applyGatewayRoutes({
		client,
		application: app,
		domains: [domain],
		namespace: "dokploy-test",
		gateway,
		log: async (l) => {
			lines.push(l);
		},
		acceptanceTimeoutMs: 0,
		...overrides,
	});
	return lines;
};

describe("applyGatewayRoutes", () => {
	const accepted = () => [{ type: "Accepted", status: "True" }];

	test("creates the route and reports that the Gateway accepted it", async () => {
		const { custom, client } = fakeCluster(accepted);
		const lines = await run(client);
		expect(custom.createNamespacedCustomObject).toHaveBeenCalledOnce();
		expect(lines).toEqual([
			expect.stringContaining("HTTPRoute for 'crystal.agent.certu.ai/'"),
			"✅ Gateway 'kgateway-system/certu-gateway' accepted the route for 'crystal.agent.certu.ai'",
		]);
	});

	test("replacing an existing route keeps its resourceVersion", async () => {
		const name = ingressName("test-app-abc123", 1);
		const { custom, client } = fakeCluster(accepted, [name]);
		await run(client);
		expect(custom.replaceNamespacedCustomObject).toHaveBeenCalledWith(
			expect.objectContaining({
				name,
				body: expect.objectContaining({
					metadata: expect.objectContaining({ resourceVersion: "41" }),
				}),
			}),
		);
	});

	test("a hostname no listener covers is reported, not fatal", async () => {
		const { client } = fakeCluster(() => [
			{
				type: "Accepted",
				status: "False",
				reason: "NoMatchingListenerHostname",
			},
		]);
		const lines = await run(client);
		expect(lines.at(-1)).toBe(
			"⚠️  Gateway 'kgateway-system/certu-gateway' rejected the route for 'crystal.agent.certu.ai': NoMatchingListenerHostname",
		);
	});

	test("status from before the latest change doesn't count as accepted", async () => {
		const name = ingressName("test-app-abc123", 1);
		// The replace bumps the route to generation 2; the controller still
		// reports on generation 1.
		const { client } = fakeCluster(
			() => [{ type: "Accepted", status: "True", observedGeneration: 1 }],
			[name],
		);
		const lines = await run(client);
		expect(lines.at(-1)).toContain("hasn't reported on the route");
	});

	test("removes routes left over from deleted domains", async () => {
		const stale = ingressName("test-app-abc123", 7);
		const { routes, client } = fakeCluster(accepted, [stale]);
		const lines = await run(client);
		expect(routes.has(stale)).toBe(false);
		expect(lines[0]).toBe(`🧹 Removed stale HTTPRoute '${stale}'`);
	});

	test("warns that redirects and basic auth aren't carried over", async () => {
		const { client } = fakeCluster(accepted);
		const lines = await run(client, {
			application: {
				...app,
				redirects: [{}],
				security: [{}],
			} as unknown as typeof app,
		});
		expect(lines).toEqual(
			expect.arrayContaining([
				expect.stringContaining("Redirects aren't applied"),
				expect.stringContaining("Basic auth isn't applied"),
			]),
		);
	});
});

describe("pruneHttpRoutes", () => {
	test("a cluster without the Gateway API has nothing to prune", async () => {
		const custom = {
			listNamespacedCustomObject: vi.fn(async () => {
				throw httpError(404);
			}),
		};
		await expect(
			pruneHttpRoutes(
				{ custom } as unknown as KubernetesClient,
				"test-app-abc123",
				[],
				"dokploy-test",
			),
		).resolves.toEqual([]);
	});
});
