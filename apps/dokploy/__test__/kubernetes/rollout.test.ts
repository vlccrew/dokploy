import type { KubernetesClient } from "@dokploy/server";
import {
	buildDatabaseManifest,
	buildDeploymentManifest,
	buildReadinessProbe,
	rolloutStatus,
	supportsSleepAction,
	waitForRollout,
} from "@dokploy/server";
import type { V1Deployment, V1Pod } from "@kubernetes/client-node";
import { describe, expect, test, vi } from "vitest";

const deployment = (
	status: V1Deployment["status"],
	{ generation = 2, replicas = 1 } = {},
): V1Deployment => ({
	metadata: { name: "web", generation },
	spec: {
		replicas,
		progressDeadlineSeconds: 300,
		selector: {},
		template: {},
	},
	status: { observedGeneration: generation, ...status },
});

describe("rolloutStatus", () => {
	test("a new pod alongside the old, still-available one isn't done", () => {
		// What the old check passed on: availableReplicas counts the old pod and
		// updatedReplicas the new one, ready or not.
		expect(
			rolloutStatus(
				deployment({ replicas: 2, updatedReplicas: 1, availableReplicas: 1 }),
			),
		).toEqual({ state: "progressing", message: "1 old pod(s) still running" });
	});

	test("waits for the new pods to become available", () => {
		expect(
			rolloutStatus(
				deployment({
					replicas: 1,
					updatedReplicas: 1,
					availableReplicas: 0,
					unavailableReplicas: 1,
				}),
			),
		).toEqual({ state: "progressing", message: "0 of 1 new pod(s) available" });
	});

	test("waits for the controller to see the new spec", () => {
		expect(
			rolloutStatus(
				deployment({
					observedGeneration: 1,
					replicas: 1,
					updatedReplicas: 1,
					availableReplicas: 1,
				}),
			).state,
		).toBe("progressing");
	});

	test("done once only new pods are left and all are available", () => {
		expect(
			rolloutStatus(
				deployment(
					{ replicas: 2, updatedReplicas: 2, availableReplicas: 2 },
					{ replicas: 2 },
				),
			),
		).toEqual({ state: "complete" });
	});

	test("fails when the controller reports the progress deadline passed", () => {
		expect(
			rolloutStatus(
				deployment({
					replicas: 2,
					updatedReplicas: 1,
					availableReplicas: 1,
					conditions: [
						{
							type: "Progressing",
							status: "False",
							reason: "ProgressDeadlineExceeded",
						},
					],
				}),
			),
		).toEqual({ state: "failed", message: "no progress for 300s" });
	});
});

const crashingPod: V1Pod = {
	metadata: { name: "web-new-abc" },
	status: {
		phase: "Running",
		conditions: [{ type: "Ready", status: "False" }],
		containerStatuses: [
			{
				name: "web",
				image: "img",
				imageID: "",
				ready: false,
				restartCount: 4,
				state: { waiting: { reason: "CrashLoopBackOff" } },
				lastState: { terminated: { exitCode: 1, containerID: "" } },
			},
		],
	},
};
const servingPod: V1Pod = {
	metadata: { name: "web-old-xyz" },
	status: { conditions: [{ type: "Ready", status: "True" }] },
};

const fakeClient = (statuses: V1Deployment["status"][], pods: V1Pod[] = []) => {
	let i = 0;
	const client = {
		apps: {
			readNamespacedDeployment: vi.fn(async () =>
				deployment(statuses[Math.min(i++, statuses.length - 1)]),
			),
		},
		core: {
			listNamespacedPod: vi.fn(async () => ({ items: pods })),
		},
	};
	return client as unknown as KubernetesClient;
};

describe("waitForRollout", () => {
	test("returns once the old pod is gone and the new one is available, reporting each step once", async () => {
		const client = fakeClient([
			{ replicas: 2, updatedReplicas: 1, availableReplicas: 1 },
			{ replicas: 2, updatedReplicas: 1, availableReplicas: 1 },
			{ replicas: 1, updatedReplicas: 1, availableReplicas: 1 },
		]);
		const progress: string[] = [];
		const result = await waitForRollout(client, "web", "ns", {
			intervalMs: 0,
			onProgress: async (m) => {
				progress.push(m);
			},
		});
		expect(result).toEqual({ ready: true });
		expect(progress).toEqual(["1 old pod(s) still running"]);
	});

	test("a failed rollout names what's wrong with the new pods", async () => {
		const client = fakeClient(
			[
				{
					replicas: 2,
					updatedReplicas: 1,
					availableReplicas: 1,
					conditions: [
						{
							type: "Progressing",
							status: "False",
							reason: "ProgressDeadlineExceeded",
						},
					],
				},
			],
			[crashingPod, servingPod],
		);
		expect(
			await waitForRollout(client, "web", "ns", { intervalMs: 0 }),
		).toEqual({
			ready: false,
			message:
				"Rollout of 'web' failed: no progress for 300s (web-new-abc: CrashLoopBackOff, last exit code 1, 4 restarts)",
		});
	});

	test("gives up at the timeout if the controller never reports", async () => {
		const client = fakeClient([
			{ replicas: 1, updatedReplicas: 1, availableReplicas: 0 },
		]);
		const result = await waitForRollout(client, "web", "ns", {
			intervalMs: 0,
			timeoutMs: 0,
		});
		expect(result.ready).toBe(false);
		expect(result.message).toContain("0 of 1 new pod(s) available");
	});
});

const probeApp = (
	overrides: Partial<Parameters<typeof buildReadinessProbe>[0]> = {},
) =>
	({
		kubernetesProbes: null,
		ports: [],
		domains: [{ port: 8080, enabled: true }],
		...overrides,
	}) as Parameters<typeof buildReadinessProbe>[0];

describe("buildReadinessProbe", () => {
	const timing = { periodSeconds: 5, timeoutSeconds: 3, failureThreshold: 3 };

	test("defaults to a TCP check on the port the domain routes to", () => {
		expect(buildReadinessProbe(probeApp())).toEqual({
			tcpSocket: { port: 8080 },
			...timing,
		});
		expect(
			buildReadinessProbe(
				probeApp({ domains: [{ port: null, enabled: true }] }),
			),
		).toEqual({ tcpSocket: { port: 3000 }, ...timing });
	});

	test("no default probe without an enabled domain", () => {
		expect(buildReadinessProbe(probeApp({ domains: [] }))).toBeUndefined();
		expect(
			buildReadinessProbe(
				probeApp({ domains: [{ port: 8080, enabled: false }] }),
			),
		).toBeUndefined();
	});

	test("an HTTP check uses the domain's port unless one is set", () => {
		expect(
			buildReadinessProbe(
				probeApp({
					kubernetesProbes: { readiness: { type: "http", path: "/healthz" } },
				}),
			),
		).toEqual({ httpGet: { path: "/healthz", port: 8080 }, ...timing });
		expect(
			buildReadinessProbe(
				probeApp({
					kubernetesProbes: {
						readiness: { type: "http", path: "/healthz", port: 9000 },
					},
				}),
			)?.httpGet?.port,
		).toBe(9000);
	});

	test("a worker's TCP check falls back to its first TCP port", () => {
		expect(
			buildReadinessProbe(
				probeApp({
					domains: [],
					ports: [
						{ targetPort: 5353, protocol: "udp" },
						{ targetPort: 7000, protocol: "tcp" },
					] as Parameters<typeof buildReadinessProbe>[0]["ports"],
					kubernetesProbes: { readiness: { type: "tcp" } },
				}),
			)?.tcpSocket?.port,
		).toBe(7000);
	});

	test("turned off, there's no probe even with a domain", () => {
		expect(
			buildReadinessProbe(
				probeApp({ kubernetesProbes: { readiness: { type: "none" } } }),
			),
		).toBeUndefined();
	});
});

describe("rollout settings on the manifests", () => {
	test("app Deployments gate rollouts on readiness", () => {
		const { deployment } = buildDeploymentManifest({
			application: {
				appName: "web",
				applicationId: "app-1",
				mounts: [],
				ports: [],
				replicas: 1,
				kubernetesProbes: null,
				domains: [{ port: 3000, enabled: true }],
			} as unknown as Parameters<
				typeof buildDeploymentManifest
			>[0]["application"],
			image: "img:1",
			namespace: "ns",
			deploymentId: "d-1",
		});
		expect(deployment.spec?.minReadySeconds).toBe(10);
		expect(deployment.spec?.progressDeadlineSeconds).toBe(300);
		expect(
			deployment.spec?.template.spec?.containers[0]?.readinessProbe?.tcpSocket,
		).toEqual({ port: 3000 });
	});

	test("database Deployments are ready only once the port accepts connections", () => {
		const { deployment } = buildDatabaseManifest(
			{
				kind: "redis",
				databaseId: "db-1",
				appName: "cache",
				image: "redis:8",
				env: null,
				command: null,
				args: null,
				containerPort: 6379,
				externalPort: null,
				memoryLimit: null,
				memoryReservation: null,
				cpuLimit: null,
				cpuReservation: null,
				mounts: [],
				environment: {
					env: null,
					project: {
						projectId: "p",
						name: "p",
						kubernetesId: "k",
						kubernetesNamespace: "ns",
						organizationId: "o",
						env: null,
					},
				},
			},
			{},
			"ns",
			null,
		);
		expect(deployment.spec?.minReadySeconds).toBe(10);
		expect(deployment.spec?.progressDeadlineSeconds).toBe(300);
		expect(
			deployment.spec?.template.spec?.containers[0]?.readinessProbe?.tcpSocket,
		).toEqual({ port: 6379 });
	});
});

describe("preStop sleep", () => {
	const app = (domains: { port: number; enabled: boolean }[]) =>
		({
			appName: "web",
			applicationId: "app-1",
			mounts: [],
			ports: [],
			replicas: 1,
			kubernetesProbes: null,
			domains,
		}) as unknown as Parameters<
			typeof buildDeploymentManifest
		>[0]["application"];
	const lifecycleOf = (
		domains: { port: number; enabled: boolean }[],
		sleepAction: boolean,
	) =>
		buildDeploymentManifest({
			application: app(domains),
			image: "img:1",
			namespace: "ns",
			deploymentId: "d-1",
			sleepAction,
		}).deployment.spec?.template.spec?.containers[0]?.lifecycle;

	test("a routed app keeps serving briefly after it's told to stop", () => {
		expect(lifecycleOf([{ port: 3000, enabled: true }], true)).toEqual({
			preStop: { sleep: { seconds: 5 } },
		});
	});

	test("not on clusters without the sleep action, nor for apps without a domain", () => {
		expect(lifecycleOf([{ port: 3000, enabled: true }], false)).toBeUndefined();
		expect(lifecycleOf([], true)).toBeUndefined();
	});

	test.each([
		[{ major: "1", minor: "36" }, true],
		[{ major: "1", minor: "30+" }, true],
		[{ major: "1", minor: "29" }, false],
	])("sleep action support for %o", async (version, expected) => {
		const client = {
			version: { getCode: vi.fn(async () => version) },
		} as unknown as KubernetesClient;
		expect(await supportsSleepAction(client)).toBe(expected);
	});
});
