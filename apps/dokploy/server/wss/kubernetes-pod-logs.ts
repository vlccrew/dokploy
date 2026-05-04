import type http from "node:http";
import { PassThrough } from "node:stream";
import {
	findKubernetesClusterById,
	getKubernetesClient,
	Log,
	validateRequest,
} from "@dokploy/server";
import { WebSocketServer } from "ws";

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
		const kubernetesId = url.searchParams.get("kubernetesId");
		const namespace = url.searchParams.get("namespace");
		const labelSelector = url.searchParams.get("labelSelector");
		const tailParam = url.searchParams.get("tail") ?? "100";
		const tailLines = Number.parseInt(tailParam, 10);

		const { user, session } = await validateRequest(req);
		if (!user || !session) {
			ws.close();
			return;
		}
		if (!kubernetesId || !namespace || !labelSelector) {
			ws.close(4000, "kubernetesId, namespace, and labelSelector are required");
			return;
		}
		if (Number.isNaN(tailLines) || tailLines <= 0 || tailLines > 10_000) {
			ws.close(4000, "Invalid tail parameter");
			return;
		}

		const cluster = await findKubernetesClusterById(kubernetesId);
		if (cluster.organizationId !== session.activeOrganizationId) {
			ws.close();
			return;
		}

		try {
			const client = await getKubernetesClient(kubernetesId);
			const podsResp = await client.core.listNamespacedPod({
				namespace,
				labelSelector,
				limit: 1,
			});
			const podName = podsResp.items?.[0]?.metadata?.name;
			if (!podName) {
				ws.send("No pods match the selector yet — waiting...");
				ws.close(4004, "No matching pods");
				return;
			}

			const log = new Log(client.kubeConfig);
			const stream = new PassThrough();
			stream.on("data", (chunk: Buffer) => {
				if (ws.readyState === ws.OPEN) ws.send(chunk.toString("utf8"));
			});

			const controller = await log.log(namespace, podName, "", stream, {
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
