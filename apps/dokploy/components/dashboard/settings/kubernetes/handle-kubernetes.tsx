import { zodResolver } from "@hookform/resolvers/zod";
import { Loader2, PlusIcon, Settings } from "lucide-react";
import { useEffect, useState } from "react";
import { useForm } from "react-hook-form";
import { toast } from "sonner";
import { z } from "zod";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
	DialogTrigger,
} from "@/components/ui/dialog";
import {
	Form,
	FormControl,
	FormDescription,
	FormField,
	FormItem,
	FormLabel,
	FormMessage,
} from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { api } from "@/utils/api";

const formSchema = z.object({
	name: z.string().min(1, "Name is required"),
	description: z.string().optional(),
	kubeconfig: z.string().min(1, "kubeconfig is required"),
	context: z.string().optional(),
	defaultNamespacePrefix: z.string().optional(),
	ingressClassName: z.string().optional(),
	tlsIssuerName: z.string().optional(),
	defaultRegistryId: z.string().optional(),
});

type FormValues = z.infer<typeof formSchema>;

interface Props {
	kubernetesId?: string;
}

export const HandleKubernetes = ({ kubernetesId }: Props) => {
	const utils = api.useUtils();
	const [open, setOpen] = useState(false);
	const [testResult, setTestResult] = useState<string | null>(null);
	const [testing, setTesting] = useState(false);

	const { data: existing } = api.kubernetes.one.useQuery(
		{ kubernetesId: kubernetesId ?? "" },
		{ enabled: !!kubernetesId && open },
	);
	const { data: registries } = api.registry.all.useQuery(undefined, {
		enabled: open,
	});

	const create = api.kubernetes.create.useMutation();
	const update = api.kubernetes.update.useMutation();
	const test = api.kubernetes.testConnection.useMutation();

	const form = useForm<FormValues>({
		resolver: zodResolver(formSchema),
		defaultValues: {
			name: "",
			description: "",
			kubeconfig: "",
			context: "",
			defaultNamespacePrefix: "dokploy",
			ingressClassName: "nginx",
			tlsIssuerName: "",
			defaultRegistryId: "",
		},
	});

	useEffect(() => {
		if (existing) {
			form.reset({
				name: existing.name,
				description: existing.description ?? "",
				kubeconfig: existing.kubeconfig,
				context: existing.context ?? "",
				defaultNamespacePrefix: existing.defaultNamespacePrefix,
				ingressClassName: existing.ingressClassName,
				tlsIssuerName: existing.tlsIssuerName ?? "",
				defaultRegistryId: existing.defaultRegistryId ?? "",
			});
		}
	}, [existing, form]);

	const onSubmit = form.handleSubmit(async (values) => {
		const payload = {
			...values,
			defaultRegistryId: values.defaultRegistryId || null,
			tlsIssuerName: values.tlsIssuerName || null,
			context: values.context || null,
		};
		try {
			if (kubernetesId) {
				await update.mutateAsync({ ...payload, kubernetesId });
				toast.success("Cluster updated");
			} else {
				await create.mutateAsync(payload);
				toast.success("Cluster created");
			}
			await utils.kubernetes.all.invalidate();
			setOpen(false);
			form.reset();
			setTestResult(null);
		} catch (err) {
			toast.error(
				err instanceof Error ? err.message : "Failed to save cluster",
			);
		}
	});

	const onTest = async () => {
		const values = form.getValues();
		if (!values.kubeconfig) {
			toast.error("Provide a kubeconfig first");
			return;
		}
		setTesting(true);
		setTestResult(null);
		try {
			const result = await test.mutateAsync({
				kubeconfig: values.kubeconfig,
				context: values.context || undefined,
			});
			if (result.ok) {
				const lines = [
					`✓ Connected (${result.serverVersion ?? "unknown version"})`,
					`Nodes: ${result.nodes ?? 0}`,
					`Ingress class present: ${result.ingressClassPresent ? "yes" : "no"}`,
					`cert-manager: ${result.certManagerPresent ? "yes" : "no"}`,
				];
				setTestResult(lines.join("\n"));
				toast.success("Connection successful");
			} else {
				setTestResult(`✗ ${result.error}`);
				toast.error("Connection failed");
			}
		} catch (err) {
			setTestResult(err instanceof Error ? err.message : String(err));
			toast.error("Test failed");
		} finally {
			setTesting(false);
		}
	};

	return (
		<Dialog open={open} onOpenChange={setOpen}>
			<DialogTrigger asChild>
				{kubernetesId ? (
					<Button variant="ghost" size="icon">
						<Settings className="size-4" />
					</Button>
				) : (
					<Button size="sm">
						<PlusIcon className="size-4 mr-1" />
						Add Cluster
					</Button>
				)}
			</DialogTrigger>
			<DialogContent className="sm:max-w-2xl max-h-[90vh] overflow-y-auto">
				<DialogHeader>
					<DialogTitle>
						{kubernetesId ? "Edit Cluster" : "Add Kubernetes Cluster"}
					</DialogTitle>
					<DialogDescription>
						Register a Kubernetes cluster by pasting its kubeconfig.
						nginx-ingress and (optionally) cert-manager must be installed in the
						cluster.
					</DialogDescription>
				</DialogHeader>
				<Form {...form}>
					<form onSubmit={onSubmit} className="space-y-4">
						<FormField
							control={form.control}
							name="name"
							render={({ field }) => (
								<FormItem>
									<FormLabel>Name</FormLabel>
									<FormControl>
										<Input placeholder="prod-cluster" {...field} />
									</FormControl>
									<FormMessage />
								</FormItem>
							)}
						/>
						<FormField
							control={form.control}
							name="description"
							render={({ field }) => (
								<FormItem>
									<FormLabel>Description</FormLabel>
									<FormControl>
										<Input {...field} />
									</FormControl>
								</FormItem>
							)}
						/>
						<FormField
							control={form.control}
							name="kubeconfig"
							render={({ field }) => (
								<FormItem>
									<FormLabel>kubeconfig</FormLabel>
									<FormControl>
										<Textarea
											rows={10}
											className="font-mono text-xs"
											placeholder="apiVersion: v1\nkind: Config\n..."
											{...field}
										/>
									</FormControl>
									<FormMessage />
								</FormItem>
							)}
						/>
						<div className="grid grid-cols-2 gap-3">
							<FormField
								control={form.control}
								name="context"
								render={({ field }) => (
									<FormItem>
										<FormLabel>Context (optional)</FormLabel>
										<FormControl>
											<Input
												placeholder="defaults to current-context"
												{...field}
											/>
										</FormControl>
									</FormItem>
								)}
							/>
							<FormField
								control={form.control}
								name="defaultNamespacePrefix"
								render={({ field }) => (
									<FormItem>
										<FormLabel>Namespace prefix</FormLabel>
										<FormControl>
											<Input {...field} />
										</FormControl>
										<FormDescription>
											Each project becomes {"{prefix}-{slug}-{shortId}"}.
										</FormDescription>
									</FormItem>
								)}
							/>
							<FormField
								control={form.control}
								name="ingressClassName"
								render={({ field }) => (
									<FormItem>
										<FormLabel>Ingress class</FormLabel>
										<FormControl>
											<Input {...field} />
										</FormControl>
									</FormItem>
								)}
							/>
							<FormField
								control={form.control}
								name="tlsIssuerName"
								render={({ field }) => (
									<FormItem>
										<FormLabel>cert-manager ClusterIssuer</FormLabel>
										<FormControl>
											<Input placeholder="letsencrypt-prod" {...field} />
										</FormControl>
										<FormDescription>
											Required if any domain uses Let's Encrypt.
										</FormDescription>
									</FormItem>
								)}
							/>
						</div>
						<FormField
							control={form.control}
							name="defaultRegistryId"
							render={({ field }) => (
								<FormItem>
									<FormLabel>Default registry</FormLabel>
									<FormControl>
										<select
											{...field}
											className="w-full rounded-md border bg-background px-3 py-2 text-sm"
										>
											<option value="">— None —</option>
											{registries?.map((r) => (
												<option key={r.registryId} value={r.registryId}>
													{r.registryName} ({r.registryUrl})
												</option>
											))}
										</select>
									</FormControl>
									<FormDescription>
										Registry to push built images to. Required for K8s
										deployments.
									</FormDescription>
								</FormItem>
							)}
						/>

						<div className="flex flex-col gap-2 pt-2">
							<Button
								type="button"
								variant="outline"
								onClick={onTest}
								disabled={testing}
							>
								{testing && <Loader2 className="size-4 mr-2 animate-spin" />}
								Test connection
							</Button>
							{testResult && (
								<pre className="rounded-md border bg-muted p-3 text-xs whitespace-pre-wrap">
									{testResult}
								</pre>
							)}
						</div>

						<DialogFooter>
							<Button
								type="button"
								variant="ghost"
								onClick={() => setOpen(false)}
							>
								Cancel
							</Button>
							<Button
								type="submit"
								isLoading={create.isPending || update.isPending}
							>
								{kubernetesId ? "Save" : "Create"}
							</Button>
						</DialogFooter>
					</form>
				</Form>
			</DialogContent>
		</Dialog>
	);
};
