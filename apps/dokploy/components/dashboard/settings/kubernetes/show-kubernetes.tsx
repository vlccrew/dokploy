import { Boxes, Loader2, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { DialogAction } from "@/components/shared/dialog-action";
import { Button } from "@/components/ui/button";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "@/components/ui/card";
import { api } from "@/utils/api";
import { HandleKubernetes } from "./handle-kubernetes";

export const ShowKubernetes = () => {
	const { data, isPending, refetch } = api.kubernetes.all.useQuery();
	const { mutateAsync, isPending: isRemoving } =
		api.kubernetes.delete.useMutation();
	const { data: permissions } = api.user.getPermissions.useQuery();

	return (
		<div className="w-full">
			<Card className="h-full bg-sidebar p-2.5 rounded-xl max-w-5xl mx-auto">
				<div className="rounded-xl bg-background shadow-md">
					<CardHeader>
						<CardTitle className="text-xl flex flex-row gap-2">
							<Boxes className="size-6 text-muted-foreground self-center" />
							Kubernetes Clusters
						</CardTitle>
						<CardDescription>
							Register Kubernetes clusters to deploy applications onto. Each
							project gets its own namespace; domains map to nginx Ingress.
						</CardDescription>
					</CardHeader>
					<CardContent className="space-y-2 py-8 border-t">
						{isPending ? (
							<div className="flex flex-row gap-2 items-center justify-center text-sm text-muted-foreground min-h-[25vh]">
								<span>Loading...</span>
								<Loader2 className="animate-spin size-4" />
							</div>
						) : (
							<>
								{data?.length === 0 ? (
									<div className="flex flex-col items-center gap-3 min-h-[25vh] justify-center">
										<Boxes className="size-8 self-center text-muted-foreground" />
										<span className="text-base text-muted-foreground">
											No clusters yet. Add one to start deploying to Kubernetes.
										</span>
										{permissions?.kubernetes?.create && <HandleKubernetes />}
									</div>
								) : (
									<div className="flex flex-col gap-4 min-h-[25vh]">
										<div className="flex flex-col gap-4 rounded-lg">
											{data?.map((cluster, index) => (
												<div
													key={cluster.kubernetesId}
													className="flex items-center justify-between bg-sidebar p-1 w-full rounded-lg"
												>
													<div className="flex items-center justify-between p-3.5 rounded-lg bg-background border w-full">
														<div className="flex flex-col gap-1">
															<span className="text-sm">
																{index + 1}. {cluster.name}
															</span>
															<span className="text-xs text-muted-foreground">
																Ingress: {cluster.ingressClassName} · Issuer:{" "}
																{cluster.tlsIssuerName ?? "—"} · Created:{" "}
																{new Date(
																	cluster.createdAt,
																).toLocaleDateString()}
															</span>
														</div>
														<div className="flex flex-row gap-1">
															<HandleKubernetes
																kubernetesId={cluster.kubernetesId}
															/>
															{permissions?.kubernetes?.delete && (
																<DialogAction
																	title="Delete Cluster"
																	description="This removes the cluster from Dokploy. Workloads in the cluster are not deleted."
																	type="destructive"
																	onClick={async () => {
																		await mutateAsync({
																			kubernetesId: cluster.kubernetesId,
																		})
																			.then(() => {
																				toast.success("Cluster removed");
																				refetch();
																			})
																			.catch((err) => {
																				toast.error(
																					err instanceof Error
																						? err.message
																						: "Error removing cluster",
																				);
																			});
																	}}
																>
																	<Button
																		variant="ghost"
																		size="icon"
																		className="group hover:bg-red-500/10"
																		isLoading={isRemoving}
																	>
																		<Trash2 className="size-4 text-primary group-hover:text-red-500" />
																	</Button>
																</DialogAction>
															)}
														</div>
													</div>
												</div>
											))}
										</div>
										{permissions?.kubernetes?.create && (
											<div className="flex flex-row gap-2 flex-wrap w-full justify-end mr-4">
												<HandleKubernetes />
											</div>
										)}
									</div>
								)}
							</>
						)}
					</CardContent>
				</div>
			</Card>
		</div>
	);
};
