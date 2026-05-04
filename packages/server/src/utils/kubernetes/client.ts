import {
	AppsV1Api,
	CoreV1Api,
	Exec,
	KubeConfig,
	Log,
	NetworkingV1Api,
	VersionApi,
} from "@kubernetes/client-node";
import { findKubernetesClusterById } from "../../services/kubernetes";

export { Exec, Log };

export interface KubernetesClient {
	kubeConfig: KubeConfig;
	core: CoreV1Api;
	apps: AppsV1Api;
	networking: NetworkingV1Api;
	version: VersionApi;
}

export const buildKubeConfigFromString = (
	kubeconfig: string,
	context?: string | null,
): KubeConfig => {
	const kc = new KubeConfig();
	kc.loadFromString(kubeconfig);
	if (context) kc.setCurrentContext(context);
	return kc;
};

export const buildKubernetesClient = (
	kubeConfig: KubeConfig,
): KubernetesClient => ({
	kubeConfig,
	core: kubeConfig.makeApiClient(CoreV1Api),
	apps: kubeConfig.makeApiClient(AppsV1Api),
	networking: kubeConfig.makeApiClient(NetworkingV1Api),
	version: kubeConfig.makeApiClient(VersionApi),
});

export const getKubernetesClient = async (
	kubernetesId: string,
): Promise<KubernetesClient> => {
	const cluster = await findKubernetesClusterById(kubernetesId);
	const kc = buildKubeConfigFromString(cluster.kubeconfig, cluster.context);
	return buildKubernetesClient(kc);
};
