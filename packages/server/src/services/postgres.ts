import { db } from "@dokploy/server/db";
import {
	type apiCreatePostgres,
	backups,
	buildAppName,
	postgres,
} from "@dokploy/server/db/schema";
import { generatePassword } from "@dokploy/server/templates";
import { buildPostgres } from "@dokploy/server/utils/databases/postgres";
import { pullImage } from "@dokploy/server/utils/docker/utils";
import { orchestrateKubernetesDatabaseDeploy } from "@dokploy/server/utils/kubernetes/database";
import { execAsyncRemote } from "@dokploy/server/utils/process/execAsync";
import { TRPCError } from "@trpc/server";
import { eq, getTableColumns } from "drizzle-orm";
import type { z } from "zod";
import { validUniqueServerAppName } from "./project";

export function getMountPath(dockerImage: string): string {
	const versionMatch = dockerImage.match(/postgres:(\d+)/);

	if (versionMatch?.[1]) {
		const version = Number.parseInt(versionMatch[1], 10);
		if (version >= 18) {
			// PostgreSQL 18+ uses /var/lib/postgresql/{version}/docker as the default PGDATA
			return `/var/lib/postgresql/${version}/docker`;
		}
	}
	return "/var/lib/postgresql/data";
}

export type Postgres = typeof postgres.$inferSelect;

export const createPostgres = async (
	input: z.infer<typeof apiCreatePostgres>,
) => {
	const appName = buildAppName("postgres", input.appName);

	const valid = await validUniqueServerAppName(appName);
	if (!valid) {
		throw new TRPCError({
			code: "CONFLICT",
			message: "Service with this 'AppName' already exists",
		});
	}

	const newPostgres = await db
		.insert(postgres)
		.values({
			...input,
			databasePassword: input.databasePassword
				? input.databasePassword
				: generatePassword(),
			appName,
		})
		.returning()
		.then((value) => value[0]);

	if (!newPostgres) {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message: "Error input: Inserting postgresql database",
		});
	}

	return newPostgres;
};
export const findPostgresById = async (postgresId: string) => {
	const result = await db.query.postgres.findFirst({
		where: eq(postgres.postgresId, postgresId),
		with: {
			environment: {
				with: {
					project: true,
				},
			},
			mounts: true,
			server: true,
			backups: {
				with: {
					destination: true,
					deployments: true,
				},
			},
		},
	});
	if (!result) {
		throw new TRPCError({
			code: "NOT_FOUND",
			message: "Postgres not found",
		});
	}
	return result;
};

export const findPostgresByBackupId = async (backupId: string) => {
	const result = await db
		.select({
			...getTableColumns(postgres),
		})
		.from(postgres)
		.innerJoin(backups, eq(postgres.postgresId, backups.postgresId))
		.where(eq(backups.backupId, backupId))
		.limit(1);

	if (!result || !result[0]) {
		throw new TRPCError({
			code: "NOT_FOUND",
			message: "Postgres not found",
		});
	}
	return result[0];
};

export const updatePostgresById = async (
	postgresId: string,
	postgresData: Partial<Postgres>,
) => {
	const { appName, ...rest } = postgresData;
	const result = await db
		.update(postgres)
		.set({
			...rest,
		})
		.where(eq(postgres.postgresId, postgresId))
		.returning();

	return result[0];
};

export const removePostgresById = async (postgresId: string) => {
	const result = await db
		.delete(postgres)
		.where(eq(postgres.postgresId, postgresId))
		.returning();

	return result[0];
};

export const deployPostgres = async (
	postgresId: string,
	onData?: (data: any) => void,
) => {
	const postgres = await findPostgresById(postgresId);
	try {
		await updatePostgresById(postgresId, {
			applicationStatus: "running",
		});

		onData?.("Starting postgres deployment...");

		if (postgres.deploymentEngine === "kubernetes") {
			// Mirror buildPostgres: postgres needs POSTGRES_DB/USER/PASSWORD
			// to initialize its data directory on first boot.
			//
			// PGDATA must point at a SUBDIRECTORY of the mounted PVC. Cloud
			// block-storage PVCs (EBS, Azure Disk, ext4 in general) ship a
			// `lost+found` directory at the FS root, and initdb refuses to
			// initialize a non-empty directory. Pointing PGDATA at a subdir
			// is Postgres' own recommended workaround for K8s/cloud volumes.
			const mountPath = getMountPath(postgres.dockerImage);
			const pgdata = `${mountPath}/pgdata`;
			const defaultEnv = `POSTGRES_DB="${postgres.databaseName}"\nPOSTGRES_USER="${postgres.databaseUser}"\nPOSTGRES_PASSWORD="${postgres.databasePassword}"\nPGDATA="${pgdata}"${
				postgres.env ? `\n${postgres.env}` : ""
			}`;
			await orchestrateKubernetesDatabaseDeploy({
				input: {
					kind: "postgres",
					databaseId: postgres.postgresId,
					appName: postgres.appName,
					image: postgres.dockerImage,
					env: defaultEnv,
					command: postgres.command,
					args: postgres.args,
					containerPort: 5432,
					externalPort: postgres.externalPort,
					memoryLimit: postgres.memoryLimit,
					memoryReservation: postgres.memoryReservation,
					cpuLimit: postgres.cpuLimit,
					cpuReservation: postgres.cpuReservation,
					mounts: postgres.mounts,
					environment: postgres.environment,
				},
			});
		} else {
			if (postgres.serverId) {
				await execAsyncRemote(
					postgres.serverId,
					`docker pull ${postgres.dockerImage}`,
					onData,
				);
			} else {
				await pullImage(postgres.dockerImage, onData);
			}

			await buildPostgres(postgres);
		}

		await updatePostgresById(postgresId, {
			applicationStatus: "done",
		});

		onData?.("Deployment completed successfully!");
	} catch (error) {
		onData?.(`Error: ${error}`);
		await updatePostgresById(postgresId, {
			applicationStatus: "error",
		});
		throw new TRPCError({
			code: "INTERNAL_SERVER_ERROR",
			message: `Error on deploy postgres${error}`,
		});
	}
	return postgres;
};
