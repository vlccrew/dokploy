import type http from "node:http";
import { PassThrough } from "node:stream";
import {
	Exec,
	findKubernetesClusterById,
	getKubernetesClient,
	validateRequest,
} from "@dokploy/server";
import { WebSocketServer } from "ws";

interface ExecStatus {
	status?: string;
	message?: string;
}

export const setupKubernetesPodExecWebSocketServer = (
	server: http.Server<typeof http.IncomingMessage, typeof http.ServerResponse>,
) => {
	const wss = new WebSocketServer({
		noServer: true,
		path: "/kubernetes-pod-exec",
	});

	server.on("upgrade", (req, socket, head) => {
		const { pathname } = new URL(req.url || "", `http://${req.headers.host}`);
		if (pathname === "/kubernetes-pod-exec") {
			wss.handleUpgrade(req, socket, head, (ws) =>
				wss.emit("connection", ws, req),
			);
		}
	});

	wss.on("connection", async (ws, req) => {
		const url = new URL(req.url || "", `http://${req.headers.host}`);
		const kubernetesId = url.searchParams.get("kubernetesId");
		const namespace = url.searchParams.get("namespace");
		const podName = url.searchParams.get("podName");
		const containerName = url.searchParams.get("containerName") ?? "";
		const command = url.searchParams.get("command") ?? "/bin/sh";

		const { user, session } = await validateRequest(req);
		if (!user || !session) {
			ws.close();
			return;
		}
		if (!kubernetesId || !namespace || !podName) {
			ws.close(4000, "kubernetesId, namespace, podName are required");
			return;
		}

		const cluster = await findKubernetesClusterById(kubernetesId);
		if (cluster.organizationId !== session.activeOrganizationId) {
			ws.close();
			return;
		}

		try {
			const client = await getKubernetesClient(kubernetesId);
			const exec = new Exec(client.kubeConfig);
			const stdout = new PassThrough();
			const stderr = new PassThrough();
			const stdin = new PassThrough();

			stdout.on("data", (chunk: Buffer) => {
				if (ws.readyState === ws.OPEN) ws.send(chunk.toString("utf8"));
			});
			stderr.on("data", (chunk: Buffer) => {
				if (ws.readyState === ws.OPEN) ws.send(chunk.toString("utf8"));
			});

			const wsHandle = await exec.exec(
				namespace,
				podName,
				containerName,
				[command],
				stdout,
				stderr,
				stdin,
				true,
				(status: ExecStatus) => {
					if (status.status === "Failure" && ws.readyState === ws.OPEN) {
						ws.send(`\nProcess exited: ${status.message ?? "failure"}`);
					}
					ws.close();
				},
			);

			ws.on("message", (msg) => {
				const text = Buffer.isBuffer(msg) ? msg.toString("utf8") : String(msg);
				stdin.write(text);
			});
			ws.on("close", () => {
				try {
					wsHandle?.close();
				} catch {
					// ignore
				}
				stdin.end();
			});
		} catch (err) {
			ws.send(err instanceof Error ? err.message : String(err));
			ws.close();
		}
	});
};
