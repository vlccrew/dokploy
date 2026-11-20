import type {
	ApplicationNested,
	Domain,
	KubernetesClient,
} from "@dokploy/server";
import {
	applyPodDisruptionBudget,
	buildDeploymentManifest,
	buildIngressManifest,
	buildPodDisruptionBudget,
	buildServiceManifest,
	DEPLOYMENT_ID_ANNOTATION,
	ENV_CHECKSUM_ANNOTATION,
	FILES_CHECKSUM_ANNOTATION,
	ingressName,
	staleIngressNames,
	tlsSecretName,
	tryApplyPodDisruptionBudget,
} from "@dokploy/server";
import { describe, expect, test, vi } from "vitest";

const TEST_DEPLOYMENT_ID = "deploy-test-0001";

const baseApp: ApplicationNested = {
	railpackVersion: "0.15.4",
	rollbackActive: false,
	applicationId: "app-1",
	previewLabels: [],
	createEnvFile: true,
	bitbucketRepositorySlug: "",
	herokuVersion: "",
	giteaBranch: "",
	buildServerId: "",
	previewBuildArgs: "",
	previewBuildSecrets: "",
	previewWildcard: "",
	previewLimit: 3,
	previewHttps: false,
	previewPath: "/",
	previewCertificateType: "none",
	previewCustomCertResolver: null,
	previewRequireCollaboratorPermissions: true,
	isPreviewDeploymentsActive: false,
	previewPort: 3000,
	previewEnv: "",
	gitlabPathNamespace: "",
	dockerBuildStage: null,
	dockerContextPath: null,
	icon: null,
	cleanCache: false,
	enableSubmodules: false,
	dropBuildPath: null,
	publishDirectory: null,
	isStaticSpa: null,
	refreshToken: null,
	owner: "",
	dockerImage: null,
	registryUrl: null,
	customGitUrl: null,
	customGitBranch: null,
	customGitBuildPath: null,
	customGitSSHKeyId: null,
	dockerfile: "Dockerfile",
	command: null,
	args: null,
	title: null,
	enabled: null,
	subtitle: null,
	memoryReservation: null,
	memoryLimit: null,
	cpuReservation: null,
	cpuLimit: "1000000000",
	buildArgs: null,
	buildSecrets: null,
	healthCheckSwarm: null,
	restartPolicySwarm: null,
	placementSwarm: null,
	updateConfigSwarm: null,
	rollbackConfigSwarm: null,
	modeSwarm: null,
	labelsSwarm: null,
	networkSwarm: null,
	endpointSpecSwarm: null,
	stopGracePeriodSwarm: null,
	ulimitsSwarm: null,
	replicas: 2,
	applicationStatus: "idle",
	buildType: "dockerfile",
	createdAt: "2025-01-01T00:00:00.000Z",
	registryId: null,
	rollbackRegistryId: null,
	environmentId: "env-1",
	githubId: null,
	gitlabId: null,
	giteaId: null,
	bitbucketId: null,
	gitlabRepository: null,
	gitlabOwner: null,
	gitlabBranch: null,
	gitlabBuildPath: null,
	gitlabProjectId: null,
	giteaRepository: null,
	giteaOwner: null,
	giteaBuildPath: null,
	bitbucketRepository: null,
	bitbucketOwner: null,
	bitbucketBranch: null,
	bitbucketBuildPath: null,
	repository: null,
	branch: null,
	buildPath: "/",
	triggerType: "push",
	autoDeploy: true,
	username: null,
	password: null,
	serverId: null,
	buildRegistryId: null,
	deploymentEngine: "kubernetes",
	previewDeployments: [],
	patches: [],
	rollbackRegistry: null,
	buildRegistry: null,
	registry: null,
	server: null,
	buildServer: null,
	bitbucket: null,
	gitea: null,
	github: null,
	gitlab: null,
	customGitSSHKey: null,
	deployments: [],
	mounts: [],
	redirects: [],
	security: [],
	ports: [],
	domains: [],
	name: "test-app",
	appName: "test-app-abc123",
	description: null,
	env: "FOO=bar",
	previewDomains: undefined as never,
	watchPaths: null,
	environment: {
		environmentId: "env-1",
		name: "production",
		isDefault: true,
		createdAt: "2025-01-01T00:00:00.000Z",
		description: null,
		env: "",
		projectId: "proj-1",
		project: {
			projectId: "proj-1",
			name: "Test Project",
			description: null,
			createdAt: "2025-01-01T00:00:00.000Z",
			env: "",
			organizationId: "org-1",
			kubernetesNamespace: "dokploy-test-proj1",
			kubernetesId: "k8s-1",
		},
	},
} as unknown as ApplicationNested;

const baseDomain: Domain = {
	applicationId: "app-1",
	certificateType: "none",
	createdAt: "",
	domainId: "dom-1",
	host: "test.example.com",
	https: false,
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

describe("buildDeploymentManifest", () => {
	test("emits a Deployment with replicas and image-pull secret; no inline env", () => {
		const { deployment, appName, configMaps, pvcs } = buildDeploymentManifest({
			application: baseApp,
			image: "registry.example.com/test/test-app:latest",
			namespace: "dokploy-test",
			deploymentId: TEST_DEPLOYMENT_ID,
		});

		expect(deployment.kind).toBe("Deployment");
		expect(deployment.spec?.replicas).toBe(2);
		expect(appName).toBe("test-app-abc123");
		const container = deployment.spec?.template.spec?.containers?.[0];
		expect(container?.image).toBe("registry.example.com/test/test-app:latest");
		// env is now sourced from a Secret via envFrom; no inline env at all.
		expect(container?.env).toBeUndefined();
		expect(container?.envFrom).toBeUndefined();
		expect(deployment.spec?.template.spec?.imagePullSecrets).toEqual([
			{ name: "dokploy-registry" },
		]);
		expect(configMaps).toHaveLength(0);
		expect(pvcs).toHaveLength(0);
		// No RWO volume: keep the default RollingUpdate.
		expect(deployment.spec?.strategy).toBeUndefined();
	});

	test("uses envFrom secretRef when envFromSecretName is set", () => {
		const { deployment } = buildDeploymentManifest({
			application: baseApp,
			image: "img:1",
			namespace: "dokploy-test",
			deploymentId: TEST_DEPLOYMENT_ID,
			envFromSecretName: "test-app-abc123-env",
		});
		const container = deployment.spec?.template.spec?.containers?.[0];
		expect(container?.envFrom).toEqual([
			{ secretRef: { name: "test-app-abc123-env" } },
		]);
		expect(container?.env).toBeUndefined();
	});

	test("env-checksum annotation flips when env content changes", () => {
		const a = buildDeploymentManifest({
			application: baseApp,
			image: "img:1",
			namespace: "dokploy-test",
			deploymentId: TEST_DEPLOYMENT_ID,
			envFromSecretName: "test-app-abc123-env",
			env: { FOO: "bar", BAZ: "1" },
		});
		const b = buildDeploymentManifest({
			application: baseApp,
			image: "img:1",
			namespace: "dokploy-test",
			deploymentId: TEST_DEPLOYMENT_ID,
			envFromSecretName: "test-app-abc123-env",
			env: { FOO: "bar", BAZ: "2" },
		});
		const sumA =
			a.deployment.spec?.template.metadata?.annotations?.[
				ENV_CHECKSUM_ANNOTATION
			];
		const sumB =
			b.deployment.spec?.template.metadata?.annotations?.[
				ENV_CHECKSUM_ANNOTATION
			];
		expect(sumA).toBeTruthy();
		expect(sumB).toBeTruthy();
		expect(sumA).not.toBe(sumB);
	});

	test("env-checksum is stable across key ordering", () => {
		const a = buildDeploymentManifest({
			application: baseApp,
			image: "img:1",
			namespace: "dokploy-test",
			deploymentId: TEST_DEPLOYMENT_ID,
			env: { FOO: "bar", BAZ: "1" },
		});
		const b = buildDeploymentManifest({
			application: baseApp,
			image: "img:1",
			namespace: "dokploy-test",
			deploymentId: TEST_DEPLOYMENT_ID,
			env: { BAZ: "1", FOO: "bar" },
		});
		expect(
			a.deployment.spec?.template.metadata?.annotations?.[
				ENV_CHECKSUM_ANNOTATION
			],
		).toBe(
			b.deployment.spec?.template.metadata?.annotations?.[
				ENV_CHECKSUM_ANNOTATION
			],
		);
	});

	test("only the deployment-id annotation is set when env is empty and no file mounts", () => {
		const { deployment } = buildDeploymentManifest({
			application: baseApp,
			image: "img:1",
			namespace: "dokploy-test",
			deploymentId: TEST_DEPLOYMENT_ID,
		});
		const annotations = deployment.spec?.template.metadata?.annotations;
		expect(annotations).toEqual({
			[DEPLOYMENT_ID_ANNOTATION]: TEST_DEPLOYMENT_ID,
		});
	});

	test("deployment-id annotation flips between deploys to force a rollout", () => {
		const a = buildDeploymentManifest({
			application: baseApp,
			image: "img:1",
			namespace: "dokploy-test",
			deploymentId: "deploy-alpha",
		});
		const b = buildDeploymentManifest({
			application: baseApp,
			image: "img:1",
			namespace: "dokploy-test",
			deploymentId: "deploy-beta",
		});
		const idA =
			a.deployment.spec?.template.metadata?.annotations?.[
				DEPLOYMENT_ID_ANNOTATION
			];
		const idB =
			b.deployment.spec?.template.metadata?.annotations?.[
				DEPLOYMENT_ID_ANNOTATION
			];
		expect(idA).toBe("deploy-alpha");
		expect(idB).toBe("deploy-beta");
	});

	test("files-checksum annotation flips when file mount content changes", () => {
		const makeFileApp = (content: string) =>
			({
				...baseApp,
				mounts: [
					{
						mountId: "mount0001",
						type: "file",
						hostPath: null,
						volumeName: null,
						filePath: null,
						content,
						mountPath: "/etc/welcome.conf",
						serviceType: "application",
						applicationId: "app-1",
						composeId: null,
						libsqlId: null,
						mariadbId: null,
						mongoId: null,
						mysqlId: null,
						postgresId: null,
						redisId: null,
					},
				],
			}) as unknown as typeof baseApp;

		const a = buildDeploymentManifest({
			application: makeFileApp("hello v1"),
			image: "img:1",
			namespace: "dokploy-test",
			deploymentId: TEST_DEPLOYMENT_ID,
		});
		const b = buildDeploymentManifest({
			application: makeFileApp("hello v2"),
			image: "img:1",
			namespace: "dokploy-test",
			deploymentId: TEST_DEPLOYMENT_ID,
		});
		const sumA =
			a.deployment.spec?.template.metadata?.annotations?.[
				FILES_CHECKSUM_ANNOTATION
			];
		const sumB =
			b.deployment.spec?.template.metadata?.annotations?.[
				FILES_CHECKSUM_ANNOTATION
			];
		expect(sumA).toBeTruthy();
		expect(sumB).toBeTruthy();
		expect(sumA).not.toBe(sumB);
	});

	test("maps cpu/memory limits to Kubernetes units", () => {
		const { deployment } = buildDeploymentManifest({
			application: { ...baseApp, memoryLimit: String(512 * 1024 * 1024) },
			image: "img:1",
			namespace: "dokploy-test",
			deploymentId: TEST_DEPLOYMENT_ID,
		});
		const container = deployment.spec?.template.spec?.containers?.[0];
		expect(container?.resources?.limits).toEqual({
			cpu: "1000m",
			memory: "512Mi",
		});
	});

	const resourcesOf = (overrides: Partial<ApplicationNested>) =>
		buildDeploymentManifest({
			application: {
				...baseApp,
				cpuLimit: null,
				cpuReservation: null,
				memoryLimit: null,
				memoryReservation: null,
				...overrides,
			},
			image: "img:1",
			namespace: "dokploy-test",
			deploymentId: TEST_DEPLOYMENT_ID,
		}).deployment.spec?.template.spec?.containers?.[0]?.resources;

	test("blank resources get small requests and a bounded limit", () => {
		// Without requests GKE Autopilot reserves 500m / 2Gi per container.
		expect(resourcesOf({})).toEqual({
			requests: { cpu: "100m", memory: "256Mi" },
			limits: { cpu: "1000m", memory: "1024Mi" },
		});
	});

	test("user-set resources win over the defaults", () => {
		expect(
			resourcesOf({
				cpuReservation: "250000000",
				memoryReservation: String(512 * 1024 * 1024),
				cpuLimit: "2000000000",
				memoryLimit: String(2048 * 1024 * 1024),
			}),
		).toEqual({
			requests: { cpu: "250m", memory: "512Mi" },
			limits: { cpu: "2000m", memory: "2048Mi" },
		});
	});

	test("a default never ends up on the wrong side of a user value", () => {
		// A reservation above the default limit raises the limit...
		expect(
			resourcesOf({
				cpuReservation: "1500000000",
				memoryReservation: String(2048 * 1024 * 1024),
			})?.limits,
		).toEqual({ cpu: "1500m", memory: "2048Mi" });
		// ...and a limit below the default request lowers the request.
		expect(
			resourcesOf({
				cpuLimit: "50000000",
				memoryLimit: String(128 * 1024 * 1024),
			})?.requests,
		).toEqual({ cpu: "50m", memory: "128Mi" });
	});

	test("multiple replicas are spread one per node", () => {
		const { deployment } = buildDeploymentManifest({
			application: { ...baseApp, replicas: 3 },
			image: "img:1",
			namespace: "dokploy-test",
			deploymentId: TEST_DEPLOYMENT_ID,
		});
		const pod = deployment.spec?.template.spec;
		expect(pod?.topologySpreadConstraints).toEqual([
			{
				maxSkew: 1,
				topologyKey: "kubernetes.io/hostname",
				whenUnsatisfiable: "DoNotSchedule",
				labelSelector: {
					matchLabels: { "app.kubernetes.io/name": "test-app-abc123" },
				},
				matchLabelKeys: ["pod-template-hash"],
				nodeTaintsPolicy: "Honor",
			},
		]);
		// GKE Autopilot forces a 500m CPU request on pods using anti-affinity.
		expect(pod?.affinity).toBeUndefined();
	});

	test("a single replica has no spread constraint", () => {
		const { deployment } = buildDeploymentManifest({
			application: { ...baseApp, replicas: 1 },
			image: "img:1",
			namespace: "dokploy-test",
			deploymentId: TEST_DEPLOYMENT_ID,
		});
		expect(
			deployment.spec?.template.spec?.topologySpreadConstraints,
		).toBeUndefined();
	});

	test("file mount: ConfigMap created, container volumeMount uses subPath", () => {
		const fileApp = {
			...baseApp,
			mounts: [
				{
					mountId: "mount0001",
					type: "file",
					hostPath: null,
					volumeName: null,
					filePath: null,
					content: "hello world",
					mountPath: "/etc/welcome.conf",
					serviceType: "application",
					applicationId: "app-1",
					composeId: null,
					libsqlId: null,
					mariadbId: null,
					mongoId: null,
					mysqlId: null,
					postgresId: null,
					redisId: null,
				},
			],
		} as unknown as typeof baseApp;

		const { deployment, configMaps } = buildDeploymentManifest({
			application: fileApp,
			image: "img:1",
			namespace: "dokploy-test",
			deploymentId: TEST_DEPLOYMENT_ID,
		});

		expect(configMaps).toHaveLength(1);
		expect(configMaps[0]!.data).toEqual({ "welcome.conf": "hello world" });

		const container = deployment.spec?.template.spec?.containers?.[0];
		const mount = container?.volumeMounts?.[0];
		expect(mount?.mountPath).toBe("/etc/welcome.conf");
		expect(mount?.subPath).toBe("welcome.conf");
		// ConfigMap mounts can be shared across nodes, so rolling stays safe.
		expect(deployment.spec?.strategy).toBeUndefined();
	});

	test("volume mount: emits a 1Gi RWO PVC labeled with the app slug and uses Recreate", () => {
		const volApp = {
			...baseApp,
			mounts: [
				{
					mountId: "vol0001ab",
					type: "volume",
					hostPath: null,
					volumeName: "data",
					filePath: null,
					content: null,
					mountPath: "/data",
					serviceType: "application",
					applicationId: "app-1",
					composeId: null,
					libsqlId: null,
					mariadbId: null,
					mongoId: null,
					mysqlId: null,
					postgresId: null,
					redisId: null,
				},
			],
		} as unknown as typeof baseApp;

		const { pvcs, deployment } = buildDeploymentManifest({
			application: volApp,
			image: "img:1",
			namespace: "dokploy-test",
			deploymentId: TEST_DEPLOYMENT_ID,
		});
		expect(pvcs).toHaveLength(1);
		expect(pvcs[0]!.spec?.accessModes).toEqual(["ReadWriteOnce"]);
		expect(pvcs[0]!.metadata?.labels?.["app.kubernetes.io/name"]).toBe(
			"test-app-abc123",
		);
		const container = deployment.spec?.template.spec?.containers?.[0];
		expect(container?.volumeMounts?.[0]?.mountPath).toBe("/data");
		expect(container?.volumeMounts?.[0]?.subPath).toBeUndefined();
		// RWO PVC: the old pod must release it before the new one can attach.
		expect(deployment.spec?.strategy).toEqual({ type: "Recreate" });
		// baseApp has 2 replicas, but they all need the node holding the PVC.
		expect(
			deployment.spec?.template.spec?.topologySpreadConstraints,
		).toBeUndefined();
	});
});

describe("PodDisruptionBudget", () => {
	test("multi-replica apps may lose at most one pod to a voluntary disruption", () => {
		expect(buildPodDisruptionBudget(baseApp, "dokploy-test")).toEqual({
			apiVersion: "policy/v1",
			kind: "PodDisruptionBudget",
			metadata: {
				name: "test-app-abc123",
				namespace: "dokploy-test",
				labels: {
					"app.kubernetes.io/managed-by": "dokploy",
					"app.kubernetes.io/name": "test-app-abc123",
				},
			},
			spec: {
				maxUnavailable: 1,
				selector: {
					matchLabels: { "app.kubernetes.io/name": "test-app-abc123" },
				},
				unhealthyPodEvictionPolicy: "AlwaysAllow",
			},
		});
	});

	test("a single replica may not be evicted at all", () => {
		// Keeps the cluster autoscaler from draining the node out from under it.
		expect(
			buildPodDisruptionBudget({ ...baseApp, replicas: 1 }, "dokploy-test").spec
				?.maxUnavailable,
		).toBe(0);
	});

	const httpError = (code: number) =>
		Object.assign(new Error(`HTTP ${code}`), { code });
	const fakeClient = (read: () => Promise<unknown>) => {
		const policy = {
			readNamespacedPodDisruptionBudget: vi.fn(read),
			replaceNamespacedPodDisruptionBudget: vi.fn(async () => ({})),
			createNamespacedPodDisruptionBudget: vi.fn(async () => ({})),
		};
		return { policy, client: { policy } as unknown as KubernetesClient };
	};

	test("apply creates the budget when it is missing", async () => {
		const { policy, client } = fakeClient(async () => {
			throw httpError(404);
		});
		await applyPodDisruptionBudget(client, baseApp, "ns");
		expect(policy.createNamespacedPodDisruptionBudget).toHaveBeenCalledTimes(1);
		expect(policy.replaceNamespacedPodDisruptionBudget).not.toHaveBeenCalled();
	});

	test("apply replaces an existing budget, e.g. after a replica change", async () => {
		const { policy, client } = fakeClient(async () => ({
			metadata: { resourceVersion: "41" },
		}));
		await applyPodDisruptionBudget(client, { ...baseApp, replicas: 1 }, "ns");
		expect(policy.replaceNamespacedPodDisruptionBudget).toHaveBeenCalledWith(
			expect.objectContaining({
				name: "test-app-abc123",
				body: expect.objectContaining({
					// The API server rejects a PDB update without it.
					metadata: expect.objectContaining({ resourceVersion: "41" }),
					spec: expect.objectContaining({ maxUnavailable: 0 }),
				}),
			}),
		);
		expect(policy.createNamespacedPodDisruptionBudget).not.toHaveBeenCalled();
	});

	test("a cluster that forbids budgets only gets a warning in the deploy log", async () => {
		const { client } = fakeClient(async () => {
			throw httpError(403);
		});
		const lines: string[] = [];
		await expect(
			tryApplyPodDisruptionBudget(client, baseApp, "ns", async (l) => {
				lines.push(l);
			}),
		).resolves.toBeUndefined();
		expect(lines).toEqual([
			expect.stringContaining("PodDisruptionBudget not applied"),
		]);
	});
});

describe("buildIngressManifest", () => {
	test("HTTP ingress without TLS when https=false", () => {
		const ing = buildIngressManifest({
			application: baseApp,
			domain: baseDomain,
			namespace: "dokploy-test",
			context: { ingressClassName: "nginx", tlsIssuerName: null },
		});
		expect(ing.kind).toBe("Ingress");
		expect(ing.spec.ingressClassName).toBe("nginx");
		const rule = ing.spec.rules[0]!;
		expect(rule.host).toBe("test.example.com");
		expect(rule.http.paths[0]!.backend.service.name).toBe("test-app-abc123");
		expect("tls" in ing.spec).toBe(false);
	});

	test("Let's Encrypt domain emits cert-manager annotation and TLS section", () => {
		const ing = buildIngressManifest({
			application: baseApp,
			domain: { ...baseDomain, https: true, certificateType: "letsencrypt" },
			namespace: "dokploy-test",
			context: {
				ingressClassName: "nginx",
				tlsIssuerName: "letsencrypt-prod",
			},
		});
		expect(ing.metadata.annotations["cert-manager.io/cluster-issuer"]).toBe(
			"letsencrypt-prod",
		);
		const tls = (ing.spec as { tls?: unknown[] }).tls;
		expect(tls).toBeDefined();
		expect(tls?.[0]).toMatchObject({ hosts: ["test.example.com"] });
	});

	test("Custom TLS domain references a kubernetes.io/tls Secret", () => {
		const ing = buildIngressManifest({
			application: baseApp,
			domain: {
				...baseDomain,
				https: true,
				certificateType: "custom",
				customCertResolver: "my-cert",
			},
			namespace: "dokploy-test",
			context: { ingressClassName: "nginx", tlsIssuerName: null },
		});
		const tls = (ing.spec as { tls?: { secretName: string }[] }).tls;
		expect(tls?.[0]?.secretName).toMatch(/-tls$/);
		expect(
			ing.metadata.annotations["cert-manager.io/cluster-issuer"],
		).toBeUndefined();
	});

	test("rewrite-target annotation when internalPath is set", () => {
		const ing = buildIngressManifest({
			application: baseApp,
			domain: { ...baseDomain, internalPath: "/api" },
			namespace: "dokploy-test",
			context: { ingressClassName: "nginx", tlsIssuerName: null },
		});
		expect(
			ing.metadata.annotations["nginx.ingress.kubernetes.io/rewrite-target"],
		).toBe("/api$1");
	});

	test("Let's Encrypt paths on one host share a Secret and keep the issuer", () => {
		const le = {
			...baseDomain,
			https: true,
			certificateType: "letsencrypt" as const,
		};
		const domains: Domain[] = [
			{ ...le, domainId: "dom-api", uniqueConfigKey: 9, path: "/api" },
			{ ...le, domainId: "dom-root", uniqueConfigKey: 8, path: "/" },
		];
		for (const domain of domains) {
			const ing = buildIngressManifest({
				application: baseApp,
				domain,
				domains,
				namespace: "dokploy-test",
				context: {
					ingressClassName: "nginx",
					tlsIssuerName: "letsencrypt-prod",
				},
			});
			expect(ing.metadata.name).toBe(
				ingressName("test-app-abc123", domain.uniqueConfigKey),
			);
			expect(ing.metadata.annotations["cert-manager.io/cluster-issuer"]).toBe(
				"letsencrypt-prod",
			);
			const tls = (ing.spec as { tls?: { secretName: string }[] }).tls;
			expect(tls?.[0]?.secretName).toBe("test-app-abc123-8-tls");
		}
	});
});

describe("tlsSecretName", () => {
	const appName = "test-app-abc123";
	const le = {
		...baseDomain,
		https: true,
		certificateType: "letsencrypt" as const,
	};

	test("a lone domain keeps the Secret named after its own Ingress", () => {
		expect(tlsSecretName(appName, { ...le, uniqueConfigKey: 5 })).toBe(
			`${ingressName(appName, 5)}-tls`,
		);
	});

	test("Let's Encrypt domains on one host use the oldest domain's Secret", () => {
		const domains = [
			{ ...le, uniqueConfigKey: 113 },
			{ ...le, uniqueConfigKey: 108 },
			{ ...le, uniqueConfigKey: 110, host: "TEST.example.com" },
		];
		for (const domain of domains) {
			expect(tlsSecretName(appName, domain, domains)).toBe(
				`${ingressName(appName, 108)}-tls`,
			);
		}
	});

	test("other hosts, plain HTTP and other certificate types don't count", () => {
		const domain = { ...le, uniqueConfigKey: 20 };
		const domains = [
			domain,
			{ ...le, uniqueConfigKey: 1, host: "other.example.com" },
			{ ...le, uniqueConfigKey: 2, https: false },
			{ ...le, uniqueConfigKey: 3, certificateType: "custom" as const },
			{ ...le, uniqueConfigKey: 4, certificateType: "none" as const },
		];
		expect(tlsSecretName(appName, domain, domains)).toBe(
			`${ingressName(appName, 20)}-tls`,
		);
	});

	test("a custom certificate keeps a Secret per domain", () => {
		const custom = {
			...le,
			certificateType: "custom" as const,
			uniqueConfigKey: 7,
		};
		expect(
			tlsSecretName(appName, custom, [custom, { ...le, uniqueConfigKey: 1 }]),
		).toBe(`${ingressName(appName, 7)}-tls`);
	});
});

describe("staleIngressNames", () => {
	const appName = "test-app-abc123";

	test("returns Ingresses whose uniqueConfigKey has no backing domain", () => {
		// Current domain is key 4; key 3 was deleted + recreated, orphaning its
		// Ingress. The orphan is what collides at nginx's admission webhook.
		const existing = [ingressName(appName, 3), ingressName(appName, 4)];
		const stale = staleIngressNames(
			appName,
			[{ uniqueConfigKey: 4 }],
			existing,
		);
		expect(stale).toEqual([ingressName(appName, 3)]);
	});

	test("keeps every Ingress that maps to a current domain", () => {
		const existing = [ingressName(appName, 1), ingressName(appName, 2)];
		const stale = staleIngressNames(
			appName,
			[{ uniqueConfigKey: 1 }, { uniqueConfigKey: 2 }],
			existing,
		);
		expect(stale).toEqual([]);
	});

	test("with no domains, every existing Ingress is stale", () => {
		const existing = [ingressName(appName, 1), ingressName(appName, 7)];
		expect(staleIngressNames(appName, [], existing)).toEqual(existing);
	});
});

describe("buildServiceManifest", () => {
	type ServiceApp = Parameters<typeof buildServiceManifest>[0];
	const asServiceApp = (app: object) => app as unknown as ServiceApp;

	const portsOf = (manifest: ReturnType<typeof buildServiceManifest>) =>
		manifest.spec.ports.map((p) => p.port).sort((a, b) => a - b);

	const withPort = (targetPort: number) =>
		({ targetPort }) as unknown as ApplicationNested["ports"][number];

	test("explicit application ports win over fallbackPorts", () => {
		const app = asServiceApp({ ...baseApp, ports: [withPort(5000)] });
		const svc = buildServiceManifest(app, "dokploy-test", [8080]);
		expect(portsOf(svc)).toEqual([5000]);
	});

	test("domain ports win over fallbackPorts", () => {
		const app = asServiceApp({
			...baseApp,
			domains: [{ ...baseDomain, port: 4000 }],
		});
		const svc = buildServiceManifest(app, "dokploy-test", [8080]);
		expect(portsOf(svc)).toEqual([4000]);
	});

	test("fallbackPorts are used when no ports and no domains are configured", () => {
		const svc = buildServiceManifest(
			asServiceApp(baseApp),
			"dokploy-test",
			[8080],
		);
		expect(portsOf(svc)).toEqual([8080]);
		expect(svc.spec.ports[0]).toMatchObject({ targetPort: 8080 });
	});

	test("multiple fallbackPorts are all exposed", () => {
		const svc = buildServiceManifest(
			asServiceApp(baseApp),
			"dokploy-test",
			[80, 443],
		);
		expect(portsOf(svc)).toEqual([80, 443]);
	});

	test("falls back to 3000 when nothing is configured or detected", () => {
		expect(
			portsOf(buildServiceManifest(asServiceApp(baseApp), "dokploy-test", [])),
		).toEqual([3000]);
		// default arg omitted entirely
		expect(
			portsOf(buildServiceManifest(asServiceApp(baseApp), "dokploy-test")),
		).toEqual([3000]);
	});
});
