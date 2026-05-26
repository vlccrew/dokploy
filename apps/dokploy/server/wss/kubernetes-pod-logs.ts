import type http from "node:http";
import { PassThrough } from "node:stream";
import {
	findKubernetesClusterById,
	getKubernetesClient,
	k8sName,
	Log,
	validateRequest,
} from "@dokploy/server";
import { db } from "@dokploy/server/db";
import {
	applications,
	mariadb,
	mongo,
	mysql,
	postgres,
	redis,
} from "@dokploy/server/db/schema";
import { eq } from "drizzle-orm";
import { WebSocketServer } from "ws";

interface ResolvedTarget {
	kubernetesId: string;
	namespace: string;
	labelSelector: string;
	organizationId: string;
}

const buildTarget = (
	appName: string,
	kubernetesId: string | null,
	namespace: string | null,
	organizationId: string,
): ResolvedTarget | null => {
	if (!kubernetesId || !namespace) return null;
	return {
		kubernetesId,
		namespace,
		labelSelector: `app.kubernetes.io/name=${k8sName(appName)}`,
		organizationId,
	};
};

const resolveFromApplication = async (
	applicationId: string,
): Promise<ResolvedTarget | null> => {
	const app = await db.query.applications.findFirst({
		where: eq(applications.applicationId, applicationId),
		with: {
			environment: { with: { project: true } },
		},
	});
	if (!app) return null;
	return buildTarget(
		app.appName,
		app.environment.project.kubernetesId,
		app.environment.project.kubernetesNamespace,
		app.environment.project.organizationId,
	);
};

const resolveFromDatabase = async (
	serviceType: "postgres" | "redis" | "mysql" | "mariadb" | "mongo",
	serviceId: string,
): Promise<ResolvedTarget | null> => {
	const withProject = {
		environment: { with: { project: true } },
	} as const;
	if (serviceType === "postgres") {
		const row = await db.query.postgres.findFirst({
			where: eq(postgres.postgresId, serviceId),
			with: withProject,
		});
		if (!row) return null;
		return buildTarget(
			row.appName,
			row.environment.project.kubernetesId,
			row.environment.project.kubernetesNamespace,
			row.environment.project.organizationId,
		);
	}
	if (serviceType === "redis") {
		const row = await db.query.redis.findFirst({
			where: eq(redis.redisId, serviceId),
			with: withProject,
		});
		if (!row) return null;
		return buildTarget(
			row.appName,
			row.environment.project.kubernetesId,
			row.environment.project.kubernetesNamespace,
			row.environment.project.organizationId,
		);
	}
	if (serviceType === "mysql") {
		const row = await db.query.mysql.findFirst({
			where: eq(mysql.mysqlId, serviceId),
			with: withProject,
		});
		if (!row) return null;
		return buildTarget(
			row.appName,
			row.environment.project.kubernetesId,
			row.environment.project.kubernetesNamespace,
			row.environment.project.organizationId,
		);
	}
	if (serviceType === "mariadb") {
		const row = await db.query.mariadb.findFirst({
			where: eq(mariadb.mariadbId, serviceId),
			with: withProject,
		});
		if (!row) return null;
		return buildTarget(
			row.appName,
			row.environment.project.kubernetesId,
			row.environment.project.kubernetesNamespace,
			row.environment.project.organizationId,
		);
	}
	if (serviceType === "mongo") {
		const row = await db.query.mongo.findFirst({
			where: eq(mongo.mongoId, serviceId),
			with: withProject,
		});
		if (!row) return null;
		return buildTarget(
			row.appName,
			row.environment.project.kubernetesId,
			row.environment.project.kubernetesNamespace,
			row.environment.project.organizationId,
		);
	}
	return null;
};

const DATABASE_SERVICE_TYPES = [
	"postgres",
	"redis",
	"mysql",
	"mariadb",
	"mongo",
] as const;
type DatabaseServiceType = (typeof DATABASE_SERVICE_TYPES)[number];
const isDatabaseServiceType = (s: string): s is DatabaseServiceType =>
	(DATABASE_SERVICE_TYPES as readonly string[]).includes(s);

export const setupKubernetesPodLogsWebSocketServer = (
	server: http.Server<typeof http.IncomingMessage, typeof http.ServerResponse>,
) => {
	const wss = new WebSocketServer({
		noServer: true,
		path: "/kubernetes-pod-logs",
	});

	server.on("upgrade", (req, socket, head) => {
		const { pathname } = new URL(req.url || "", `http://${req.headers.host}`);
		if (pathname === "/kubernetes-pod-logs") {
			wss.handleUpgrade(req, socket, head, (ws) =>
				wss.emit("connection", ws, req),
			);
		}
	});

	wss.on("connection", async (ws, req) => {
		const url = new URL(req.url || "", `http://${req.headers.host}`);
		const applicationId = url.searchParams.get("applicationId");
		const serviceType = url.searchParams.get("serviceType");
		const serviceId = url.searchParams.get("serviceId");
		const tailParam = url.searchParams.get("tail") ?? "100";
		const tailLines = Number.parseInt(tailParam, 10);

		const { user, session } = await validateRequest(req);
		if (!user || !session) {
			ws.close();
			return;
		}
		if (!applicationId && !(serviceType && serviceId)) {
			ws.close(4000, "applicationId or serviceType+serviceId is required");
			return;
		}
		if (Number.isNaN(tailLines) || tailLines <= 0 || tailLines > 10_000) {
			ws.close(4000, "Invalid tail parameter");
			return;
		}

		let target: ResolvedTarget | null = null;
		if (applicationId) {
			target = await resolveFromApplication(applicationId);
		} else if (serviceType && serviceId) {
			if (!isDatabaseServiceType(serviceType)) {
				ws.close(4000, "Unsupported serviceType");
				return;
			}
			target = await resolveFromDatabase(serviceType, serviceId);
		}
		if (!target) {
			ws.send(
				"This service is not bound to a Kubernetes cluster yet. Deploy it first.",
			);
			ws.close(4004, "No k8s binding");
			return;
		}
		if (target.organizationId !== session.activeOrganizationId) {
			ws.close();
			return;
		}

		const cluster = await findKubernetesClusterById(target.kubernetesId);
		if (cluster.organizationId !== session.activeOrganizationId) {
			ws.close();
			return;
		}

		try {
			const client = await getKubernetesClient(target.kubernetesId);
			const podsResp = await client.core.listNamespacedPod({
				namespace: target.namespace,
				labelSelector: target.labelSelector,
				limit: 1,
			});
			const podName = podsResp.items?.[0]?.metadata?.name;
			if (!podName) {
				ws.send("No pods match yet — waiting for a running pod...");
				ws.close(4004, "No matching pods");
				return;
			}

			const log = new Log(client.kubeConfig);
			const stream = new PassThrough();
			stream.on("data", (chunk: Buffer) => {
				if (ws.readyState === ws.OPEN) ws.send(chunk.toString("utf8"));
			});

			const controller = await log.log(target.namespace, podName, "", stream, {
				follow: true,
				tailLines,
				timestamps: true,
			});

			ws.on("close", () => {
				controller.abort();
				stream.destroy();
			});
		} catch (err) {
			ws.send(err instanceof Error ? err.message : String(err));
			ws.close();
		}
	});
};
