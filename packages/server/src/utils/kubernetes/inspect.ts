import { execAsync, execAsyncRemote } from "../process/execAsync";

/**
 * Inspect the locally-built image's `Config.ExposedPorts` on the build host and
 * return the numeric ports it declares (e.g. `[8080]`). This captures both an
 * explicit `EXPOSE` in the app's Dockerfile and ports inherited from base
 * images (e.g. `FROM nginx` → `80`).
 *
 * Runs on the build host: pass `buildServerId || serverId` so it shells out in
 * the same place the build did (local `execAsync` vs SSH `execAsyncRemote`).
 *
 * Best-effort — returns `[]` if the image is absent, declares no ports, or
 * inspect/parse fails. Callers must never fail a deploy because of this.
 */
export const detectExposedPorts = async (
	imageName: string,
	serverId: string | null,
): Promise<number[]> => {
	const cmd = `docker inspect --format '{{json .Config.ExposedPorts}}' ${imageName}`;
	try {
		const { stdout } = serverId
			? await execAsyncRemote(serverId, cmd)
			: await execAsync(cmd);
		const parsed = JSON.parse(stdout.trim() || "null");
		if (!parsed || typeof parsed !== "object") return [];
		return Object.keys(parsed)
			.map((key) => Number.parseInt(key.split("/")[0] ?? "", 10))
			.filter((n) => Number.isFinite(n) && n > 0);
	} catch {
		return [];
	}
};
