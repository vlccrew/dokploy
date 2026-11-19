import { describe, expect, it, vi } from "vitest";

// registry.forSelect and kubernetes.all are open to members (they back the
// pickers in the create-app and project dialogs), so they must stay scoped to
// the caller's org and never return credentials.

const registries = [
	{
		registryId: "reg-a",
		registryName: "Registry A",
		registryUrl: "registry.a.example",
		imagePrefix: "team-a",
		username: "user-a",
		password: "secret-a",
		organizationId: "org-a",
	},
	{
		registryId: "reg-b",
		registryName: "Registry B",
		registryUrl: "registry.b.example",
		imagePrefix: null,
		username: "user-b",
		password: "secret-b",
		organizationId: "org-b",
	},
];

const clusters = [
	{
		kubernetesId: "k8s-a",
		name: "Cluster A",
		kubeconfig: "apiVersion: v1\nusers: [{token: secret-a}]",
		organizationId: "org-a",
	},
	{
		kubernetesId: "k8s-b",
		name: "Cluster B",
		kubeconfig: "apiVersion: v1\nusers: [{token: secret-b}]",
		organizationId: "org-b",
	},
];

// Pulls the bound value out of a drizzle eq() expression.
const valueFromWhere = (where: unknown) => {
	const chunks = (where as { queryChunks?: unknown[] })?.queryChunks ?? [];
	const param = chunks.find(
		(c) => typeof (c as { value?: unknown })?.value === "string",
	) as { value: string } | undefined;
	return param?.value;
};

// Applies drizzle's `columns` option the way the relational query API does.
const project = (
	row: Record<string, unknown>,
	columns?: Record<string, boolean>,
) => {
	if (!columns) return row;
	const includeMode = Object.values(columns).some(Boolean);
	return Object.fromEntries(
		Object.entries(row).filter(([key]) =>
			includeMode ? columns[key] === true : columns[key] !== false,
		),
	);
};

const findManyOver =
	(rows: Record<string, unknown>[]) =>
	async ({
		columns,
		where,
	}: {
		columns?: Record<string, boolean>;
		where: unknown;
	}) =>
		rows
			.filter((row) => row.organizationId === valueFromWhere(where))
			.map((row) => project(row, columns));

vi.mock("@dokploy/server/db", () => ({
	db: {
		query: {
			registry: { findMany: vi.fn(findManyOver(registries)) },
			kubernetesClusters: { findMany: vi.fn(findManyOver(clusters)) },
		},
	},
}));
vi.mock("@dokploy/server", () => ({}));
vi.mock("@dokploy/server/lib/auth", () => ({ validateRequest: vi.fn() }));
vi.mock("@dokploy/server/services/permission", () => ({
	checkPermission: vi.fn(async () => undefined),
}));
vi.mock("@/server/api/utils/audit", () => ({
	audit: vi.fn(async () => undefined),
}));

const { registryRouter } = await import("@/server/api/routers/registry");
const { findKubernetesClustersByOrganization } = await import(
	"@dokploy/server/services/kubernetes"
);

const memberCaller = registryRouter.createCaller({
	user: { id: "u1", role: "member" },
	session: { userId: "u1", activeOrganizationId: "org-a" },
} as never);

describe("registry.forSelect", () => {
	it("returns the caller's org registries without credentials", async () => {
		const result = await memberCaller.forSelect();
		expect(result).toEqual([
			{
				registryId: "reg-a",
				registryName: "Registry A",
				registryUrl: "registry.a.example",
				imagePrefix: "team-a",
			},
		]);
	});
});

describe("findKubernetesClustersByOrganization (kubernetes.all)", () => {
	it("returns the org's clusters without the kubeconfig", async () => {
		const result = await findKubernetesClustersByOrganization("org-a");
		expect(result).toEqual([
			{ kubernetesId: "k8s-a", name: "Cluster A", organizationId: "org-a" },
		]);
	});
});
