import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	assertServiceCredentialAccess: vi.fn(),
	createApplication: vi.fn(),
}));

vi.mock("@dokploy/server/services/permission", () => ({
	checkServiceAccess: vi.fn(async () => undefined),
	addNewService: vi.fn(async () => undefined),
}));

vi.mock("@dokploy/server/index", () => ({
	IS_CLOUD: false,
	findEnvironmentById: vi.fn(async () => ({ projectId: "project-a" })),
	findProjectById: vi.fn(async () => ({
		projectId: "project-a",
		organizationId: "org-a",
	})),
	getWebServerSettings: vi.fn(async () => ({ remoteServersOnly: false })),
	getAccessibleServerIds: vi.fn(async () => new Set()),
	assertServiceCredentialAccess: mocks.assertServiceCredentialAccess,
	createApplication: mocks.createApplication,
}));

vi.mock("@dokploy/server/lib/auth", () => ({ validateRequest: vi.fn() }));
vi.mock("@/server/api/utils/audit", () => ({
	audit: vi.fn(async () => undefined),
}));

const { applicationRouter } = await import("@/server/api/routers/application");

const session = { userId: "u1", activeOrganizationId: "org-a" };
const caller = applicationRouter.createCaller({
	session,
	user: { id: "u1", role: "member" },
} as never);

const input = {
	name: "app v2",
	appName: "agent-aster-app-v2",
	environmentId: "env-a",
	deploymentEngine: "kubernetes" as const,
	registryId: "reg-b",
};

beforeEach(() => {
	vi.clearAllMocks();
	mocks.createApplication.mockResolvedValue({
		applicationId: "app-1",
		appName: "agent-aster-app-v2",
	});
});

describe("application.create — registry must belong to the caller's org", () => {
	it("checks the chosen registry before creating", async () => {
		mocks.assertServiceCredentialAccess.mockResolvedValue(undefined);
		await caller.create(input);
		expect(mocks.assertServiceCredentialAccess).toHaveBeenCalledWith(
			session,
			expect.objectContaining({ registryId: "reg-b" }),
		);
		expect(mocks.createApplication).toHaveBeenCalledTimes(1);
	});

	it("does not create the app when the registry is from another org", async () => {
		mocks.assertServiceCredentialAccess.mockRejectedValue(
			Object.assign(
				new Error("You are not authorized to use this credential"),
				{
					code: "UNAUTHORIZED",
				},
			),
		);
		await expect(caller.create(input)).rejects.toBeTruthy();
		expect(mocks.createApplication).not.toHaveBeenCalled();
	});
});
