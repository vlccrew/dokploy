import { findAllDeploymentsByApplicationId } from "@dokploy/server/services/deployment";
import type { Registry } from "@dokploy/server/services/registry";
import { createRollback } from "@dokploy/server/services/rollbacks";
import type { ApplicationNested } from "../builders";

export const uploadImageRemoteCommand = async (
	application: ApplicationNested,
	imageTag?: string,
) => {
	const registry = application.registry;
	const buildRegistry = application.buildRegistry;
	const rollbackRegistry = application.rollbackRegistry;

	if (!registry && !buildRegistry && !rollbackRegistry) {
		throw new Error("No registry found");
	}

	const { appName } = application;
	const imageName =
		application.sourceType === "docker"
			? application.dockerImage || ""
			: `${appName}:latest`;

	// For built sources on K8s we also push a unique, deploy-identifying tag
	// (e.g. short commit SHA) alongside `:latest`. K8s references the unique
	// tag so rollouts fire on every deploy, and the registry retains prior
	// versions for rollback. Swarm flows don't pass `imageTag` — behavior
	// there is unchanged.
	const extraTag =
		imageTag && application.sourceType !== "docker" ? imageTag : null;

	const commands: string[] = [];
	if (registry) {
		const registryTag = getRegistryTag(registry, imageName);
		if (registryTag) {
			commands.push(`echo "📦 [Enabled Registry Swarm]"`);
			commands.push(getRegistryCommands(registry, imageName, registryTag));
			if (extraTag) {
				const versionedTag = `${getRegistryTag(registry, appName)}:${extraTag}`;
				commands.push(
					getRegistryCommands(registry, imageName, versionedTag, {
						skipLogin: true,
					}),
				);
			}
		}
	}
	if (buildRegistry) {
		const buildRegistryTag = getRegistryTag(buildRegistry, imageName);
		if (buildRegistryTag) {
			commands.push(`echo "🔑 [Enabled Build Registry]"`);
			commands.push(
				getRegistryCommands(buildRegistry, imageName, buildRegistryTag),
			);
			if (extraTag) {
				const versionedTag = `${getRegistryTag(buildRegistry, appName)}:${extraTag}`;
				commands.push(
					getRegistryCommands(buildRegistry, imageName, versionedTag, {
						skipLogin: true,
					}),
				);
			}
			commands.push(
				`echo "⚠️ INFO: After the build is finished, you need to wait a few seconds for the server to download the image and run the container."`,
			);
			commands.push(
				`echo "📊 Check the Logs tab to see when the container starts running."`,
			);
		}
	}

	if (rollbackRegistry && application.rollbackActive) {
		const deployment = await findAllDeploymentsByApplicationId(
			application.applicationId,
		);
		if (!deployment || !deployment[0]) {
			throw new Error("Deployment not found");
		}
		const deploymentId = deployment[0].deploymentId;
		const rollback = await createRollback({
			appName: appName,
			deploymentId: deploymentId,
		});

		const rollbackRegistryTag = getRegistryTag(
			rollbackRegistry,
			rollback?.image || "",
		);
		if (rollbackRegistryTag) {
			commands.push(`echo "🔄 [Enabled Rollback Registry]"`);
			commands.push(
				getRegistryCommands(rollbackRegistry, imageName, rollbackRegistryTag),
			);
		}
	}
	try {
		return commands.join("\n");
	} catch (error) {
		throw error;
	}
};
/**
 * Extract the repository name from imageName by taking the last part after '/'
 * Examples:
 * - "nginx" -> "nginx"
 * - "nginx:latest" -> "nginx:latest"
 * - "myuser/myrepo" -> "myrepo"
 * - "myuser/myrepo:tag" -> "myrepo:tag"
 * - "docker.io/myuser/myrepo" -> "myrepo"
 */
const extractRepositoryName = (imageName: string): string => {
	const lastSlashIndex = imageName.lastIndexOf("/");

	// If no '/', return the imageName as is
	if (lastSlashIndex === -1) {
		return imageName;
	}

	// Extract everything after the last '/'
	return imageName.substring(lastSlashIndex + 1);
};

export const getRegistryTag = (registry: Registry, imageName: string) => {
	const { registryUrl, imagePrefix, username } = registry;

	// Extract the repository name (last part after '/')
	const repositoryName = extractRepositoryName(imageName);

	// Build the final tag using registry's username/prefix
	const targetPrefix = imagePrefix || username;
	const finalRegistry = registryUrl || "";

	return finalRegistry
		? `${finalRegistry}/${targetPrefix}/${repositoryName}`
		: `${targetPrefix}/${repositoryName}`;
};

const getRegistryCommands = (
	registry: Registry,
	imageName: string,
	registryTag: string,
	opts: { skipLogin?: boolean } = {},
): string => {
	const loginBlock = opts.skipLogin
		? ""
		: `echo "${registry.password}" | docker login ${registry.registryUrl} -u '${registry.username}' --password-stdin || {
	echo "❌ DockerHub Failed" ;
	exit 1;
}
echo "✅ Registry Login Success" ;
`;
	return `
echo "📦 [Enabled Registry] Uploading image to '${registry.registryType}' | '${registryTag}'" ;
${loginBlock}docker tag ${imageName} ${registryTag} || {
	echo "❌ Error tagging image" ;
	exit 1;
}
echo "✅ Image Tagged" ;
docker push ${registryTag} || {
	echo "❌ Error pushing image" ;
	exit 1;
}
	echo "✅ Image Pushed" ;
`;
};
