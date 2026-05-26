import {
	buildDatabaseManifest,
	type DatabaseDeploymentInput,
	ENV_CHECKSUM_ANNOTATION,
	FILES_CHECKSUM_ANNOTATION,
} from "@dokploy/server";
import { describe, expect, test } from "vitest";

const NAMESPACE = "dokploy-proj-abc123";

const baseEnvironment = {
	env: null,
	project: {
		projectId: "proj-1",
		name: "demo",
		kubernetesId: "k8s-1",
		kubernetesNamespace: NAMESPACE,
		organizationId: "org-1",
		env: null,
	},
};

const makeInput = (
	overrides: Partial<DatabaseDeploymentInput> = {},
): DatabaseDeploymentInput => ({
	kind: "postgres",
	databaseId: "db-pg-1",
	appName: "demo-postgres-abc",
	image: "postgres:18",
	env: null,
	command: null,
	args: null,
	containerPort: 5432,
	externalPort: null,
	dataDir: "/var/lib/postgresql/data",
	memoryLimit: null,
	memoryReservation: null,
	cpuLimit: null,
	cpuReservation: null,
	mounts: [],
	environment: baseEnvironment,
	...overrides,
});

describe("buildDatabaseManifest", () => {
	test("postgres: minimal manifest shape", () => {
		const bundle = buildDatabaseManifest(makeInput(), {}, NAMESPACE, null);

		expect(bundle.appName).toBe("demo-postgres-abc");
		expect(bundle.deployment.spec?.replicas).toBe(1);
		expect(bundle.deployment.spec?.strategy?.type).toBe("Recreate");
		expect(bundle.deployment.metadata?.labels).toMatchObject({
			"app.kubernetes.io/managed-by": "dokploy",
			"app.kubernetes.io/name": "demo-postgres-abc",
			"dokploy.io/database-id": "db-pg-1",
			"dokploy.io/database-kind": "postgres",
		});

		const container = bundle.deployment.spec?.template.spec?.containers[0];
		expect(container?.image).toBe("postgres:18");
		expect(container?.ports?.[0]?.containerPort).toBe(5432);
		expect(container?.volumeMounts).toContainEqual({
			name: "data",
			mountPath: "/var/lib/postgresql/data",
		});

		expect(bundle.dataPvc.metadata?.name).toBe("demo-postgres-abc-data");
		expect(bundle.dataPvc.spec?.accessModes).toEqual(["ReadWriteOnce"]);

		expect(bundle.service.spec?.type).toBe("ClusterIP");
		expect(bundle.service.spec?.ports?.[0]?.port).toBe(5432);
	});

	test.each([
		["redis", 6379, "/data"],
		["mysql", 3306, "/var/lib/mysql"],
		["mariadb", 3306, "/var/lib/mysql"],
		["mongo", 27017, "/data/db"],
	] as const)(
		"%s: container port and data dir flow through to manifest",
		(kind, port, dir) => {
			const bundle = buildDatabaseManifest(
				makeInput({
					kind,
					containerPort: port,
					dataDir: dir,
					appName: `demo-${kind}-abc`,
					databaseId: `db-${kind}-1`,
				}),
				{},
				NAMESPACE,
				null,
			);
			expect(
				bundle.deployment.spec?.template.spec?.containers[0]?.ports?.[0]
					?.containerPort,
			).toBe(port);
			expect(
				bundle.deployment.spec?.template.spec?.containers[0]?.volumeMounts?.[0]
					?.mountPath,
			).toBe(dir);
			expect(
				bundle.deployment.metadata?.labels?.["dokploy.io/database-kind"],
			).toBe(kind);
			expect(bundle.service.spec?.ports?.[0]?.port).toBe(port);
		},
	);

	test("externalPort produces a NodePort Service with the right nodePort", () => {
		const bundle = buildDatabaseManifest(
			makeInput({ externalPort: 30543 }),
			{},
			NAMESPACE,
			null,
		);
		expect(bundle.service.spec?.type).toBe("NodePort");
		expect(bundle.service.spec?.ports?.[0]?.nodePort).toBe(30543);
		expect(bundle.service.spec?.ports?.[0]?.port).toBe(5432);
	});

	test("env vars produce envFrom + env-checksum annotation that rolls the pod", () => {
		const envObj = { POSTGRES_PASSWORD: "secret", POSTGRES_USER: "alice" };
		const bundle = buildDatabaseManifest(
			makeInput(),
			envObj,
			NAMESPACE,
			"demo-postgres-abc-env",
		);
		const container = bundle.deployment.spec?.template.spec?.containers[0];
		expect(container?.envFrom).toEqual([
			{ secretRef: { name: "demo-postgres-abc-env" } },
		]);
		const annotations =
			bundle.deployment.spec?.template.metadata?.annotations ?? {};
		expect(annotations[ENV_CHECKSUM_ANNOTATION]).toMatch(/^[a-f0-9]{64}$/);
	});

	test("file mount creates a ConfigMap and files-checksum annotation", () => {
		const bundle = buildDatabaseManifest(
			makeInput({
				mounts: [
					{
						mountId: "mountid01",
						type: "file",
						mountPath: "/etc/postgres/postgres.conf",
						content: "shared_buffers = 256MB",
					},
				],
			}),
			{},
			NAMESPACE,
			null,
		);
		expect(bundle.configMaps).toHaveLength(1);
		expect(bundle.configMaps[0]?.metadata?.name).toBe(
			"demo-postgres-abc-files-1",
		);
		const annotations =
			bundle.deployment.spec?.template.metadata?.annotations ?? {};
		expect(annotations[FILES_CHECKSUM_ANNOTATION]).toMatch(/^[a-f0-9]{64}$/);
	});

	test("user volume mount produces a PVC alongside the data PVC", () => {
		const bundle = buildDatabaseManifest(
			makeInput({
				mounts: [
					{
						mountId: "mountid02",
						type: "volume",
						mountPath: "/extra",
					},
				],
			}),
			{},
			NAMESPACE,
			null,
		);
		expect(bundle.userPvcs).toHaveLength(1);
		expect(bundle.dataPvc.metadata?.name).toBe("demo-postgres-abc-data");
		// Pod must mount both the data dir and the user volume.
		const mounts =
			bundle.deployment.spec?.template.spec?.containers[0]?.volumeMounts ?? [];
		expect(mounts.map((m) => m.mountPath)).toEqual([
			"/var/lib/postgresql/data",
			"/extra",
		]);
	});

	test("memory and CPU map docker bytes/nanocpus into k8s Mi/m units", () => {
		const bundle = buildDatabaseManifest(
			makeInput({
				memoryLimit: `${512 * 1024 * 1024}`,
				cpuLimit: "500000000",
			}),
			{},
			NAMESPACE,
			null,
		);
		const resources =
			bundle.deployment.spec?.template.spec?.containers[0]?.resources;
		expect(resources?.limits?.memory).toBe("512Mi");
		expect(resources?.limits?.cpu).toBe("500m");
	});
});
