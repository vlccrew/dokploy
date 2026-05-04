import type http from "node:http";
import { PassThrough } from "node:stream";
import {
	Exec,
	findKubernetesClusterById,
	getKubernetesClient,
	k8sName,
	validateRequest,
} from "@dokploy/server";
import { db } from "@dokploy/server/db";
import { applications } from "@dokploy/server/db/schema";
import { eq } from "drizzle-orm";
import { WebSocketServer } from "ws";

interface ExecStatus {
	status?: string;
	message?: string;
}

const ALLOWED_SHELLS = new Set(["/bin/sh", "/bin/bash", "sh", "bash"]);

const resolveFromApplication = async (applicationId: string) => {
	const app = await db.query.applications.findFirst({
		where: eq(applications.applicationId, applicationId),
		with: { environment: { with: { project: true } } },
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
		const applicationId = url.searchParams.get("applicationId");
		const requestedShell = url.searchParams.get("activeWay") ?? "/bin/sh";
		const command = ALLOWED_SHELLS.has(requestedShell)
			? requestedShell.startsWith("/")
				? requestedShell
				: `/bin/${requestedShell}`
			: "/bin/sh";

		const { user, session } = await validateRequest(req);
		if (!user || !session) {
			ws.close();
			return;
		}
		if (!applicationId) {
			ws.close(4000, "applicationId is required");
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
				ws.send("No running pod found for this application yet.");
				ws.close(4004, "No matching pods");
				return;
			}
			const containerName =
				podsResp.items?.[0]?.spec?.containers?.[0]?.name ?? "";

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
				target.namespace,
				podName,
				containerName,
				[command],
				stdout,
				stderr,
				stdin,
				true,
				(status: ExecStatus) => {
					if (ws.readyState === ws.OPEN && status.status === "Failure") {
						ws.send(`\nProcess exited: ${status.message ?? "failure"}`);
					}
					if (ws.readyState === ws.OPEN) ws.close();
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
