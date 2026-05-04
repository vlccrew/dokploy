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
import { applications } from "@dokploy/server/db/schema";
import { eq } from "drizzle-orm";
import { WebSocketServer } from "ws";

interface ResolvedTarget {
	kubernetesId: string;
	namespace: string;
	labelSelector: string;
	organizationId: string;
}

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
	const kubernetesId = app.environment.project.kubernetesId;
	const namespace = app.environment.project.kubernetesNamespace;
	if (!kubernetesId || !namespace) return null;
	return {
		kubernetesId,
		namespace,
		labelSelector: `app.kubernetes.io/name=${k8sName(app.appName)}`,
		organizationId: app.environment.project.organizationId,
	};
};

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
		const tailParam = url.searchParams.get("tail") ?? "100";
		const tailLines = Number.parseInt(tailParam, 10);

		const { user, session } = await validateRequest(req);
		if (!user || !session) {
			ws.close();
			return;
		}
		if (!applicationId) {
			ws.close(4000, "applicationId is required");
			return;
		}
		if (Number.isNaN(tailLines) || tailLines <= 0 || tailLines > 10_000) {
			ws.close(4000, "Invalid tail parameter");
			return;
		}

		const target = await resolveFromApplication(applicationId);
		if (!target) {
			ws.send(
				"This application is not bound to a Kubernetes cluster yet. Deploy it first.",
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
