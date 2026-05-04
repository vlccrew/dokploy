import type { ApplicationNested, Domain } from "@dokploy/server";
import { buildDeploymentManifest, buildIngressManifest } from "@dokploy/server";
import { describe, expect, test } from "vitest";

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
	kubernetesId: "k8s-1",
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
};

describe("buildDeploymentManifest", () => {
	test("emits a Deployment with replicas, env, and image-pull secret", () => {
		const { deployment, appName, configMaps, pvcs } = buildDeploymentManifest({
			application: baseApp,
			image: "registry.example.com/test/test-app:latest",
			namespace: "dokploy-test",
		});

		expect(deployment.kind).toBe("Deployment");
		expect(deployment.spec?.replicas).toBe(2);
		expect(appName).toBe("test-app-abc123");
		const container = deployment.spec?.template.spec?.containers?.[0];
		expect(container?.image).toBe("registry.example.com/test/test-app:latest");
		expect(container?.env).toEqual([{ name: "FOO", value: "bar" }]);
		expect(deployment.spec?.template.spec?.imagePullSecrets).toEqual([
			{ name: "dokploy-registry" },
		]);
		expect(configMaps).toHaveLength(0);
		expect(pvcs).toHaveLength(0);
	});

	test("maps cpu/memory limits to Kubernetes units", () => {
		const { deployment } = buildDeploymentManifest({
			application: { ...baseApp, memoryLimit: String(512 * 1024 * 1024) },
			image: "img:1",
			namespace: "dokploy-test",
		});
		const container = deployment.spec?.template.spec?.containers?.[0];
		expect(container?.resources?.limits).toEqual({
			cpu: "1000m",
			memory: "512Mi",
		});
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
		expect(tls?.[0]!.secretName).toMatch(/-tls$/);
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
});
