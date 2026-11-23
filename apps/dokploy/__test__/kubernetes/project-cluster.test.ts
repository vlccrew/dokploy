import {
	findOrganizationKubernetesCluster,
	findProjectKubernetesServices,
} from "@dokploy/server";
import { db } from "@dokploy/server/db";
import { apiUpdateProject } from "@dokploy/server/db/schema";
import { describe, expect, test, vi } from "vitest";

const findFirst = vi.mocked(db.query.projects.findFirst);

describe("apiUpdateProject", () => {
	test("carries a cluster change through to the update", () => {
		expect(
			apiUpdateProject.parse({ projectId: "p", kubernetesId: "gke" }),
		).toEqual({ projectId: "p", kubernetesId: "gke" });
		expect(
			apiUpdateProject.parse({ projectId: "p", kubernetesId: null })
				.kubernetesId,
		).toBeNull();
	});

	test("rejects a field it can't save instead of dropping it", () => {
		expect(
			apiUpdateProject.safeParse({ projectId: "p", serverId: "s" }).success,
		).toBe(false);
	});
});

describe("findOrganizationKubernetesCluster", () => {
	test("a cluster of another organization is not found", async () => {
		findFirst.mockResolvedValueOnce({
			kubernetesId: "gke",
			organizationId: "other-org",
		} as never);
		await expect(
			findOrganizationKubernetesCluster("gke", "my-org"),
		).rejects.toThrow("Kubernetes cluster not found");
	});
});

const project = (kubernetesNamespace: string | null) =>
	({
		kubernetesNamespace,
		kubernetesCluster: { name: "certu-agent-cluster" },
		environments: [
			{
				name: "production",
				applications: [
					{
						name: "jennie",
						deploymentEngine: "kubernetes",
						domains: [{ host: "jennie.agent.certu.tech" }],
					},
					{ name: "legacy", deploymentEngine: "docker", domains: [] },
				],
				postgres: [{ name: "db", deploymentEngine: "kubernetes" }],
				mysql: [],
				mariadb: [],
				mongo: [],
				redis: [{ name: "cache", deploymentEngine: "docker" }],
			},
		],
	}) as never;

describe("findProjectKubernetesServices", () => {
	test("lists the services that deployed to the project's cluster", async () => {
		findFirst.mockResolvedValueOnce(project("dokploy-jennie-abc123"));
		expect(await findProjectKubernetesServices("p")).toEqual({
			cluster: "certu-agent-cluster",
			namespace: "dokploy-jennie-abc123",
			services: [
				{
					environment: "production",
					name: "jennie",
					type: "application",
					hosts: ["jennie.agent.certu.tech"],
				},
				{ environment: "production", name: "db", type: "postgres", hosts: [] },
			],
		});
	});

	test("nothing stays behind if nothing was ever deployed", async () => {
		findFirst.mockResolvedValueOnce(project(null));
		expect((await findProjectKubernetesServices("p")).services).toEqual([]);
	});
});
