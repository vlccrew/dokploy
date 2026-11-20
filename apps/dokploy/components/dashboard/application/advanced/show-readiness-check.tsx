import { standardSchemaResolver as zodResolver } from "@hookform/resolvers/standard-schema";
import { useEffect } from "react";
import { useForm } from "react-hook-form";
import { toast } from "sonner";
import { z } from "zod";
import { Button } from "@/components/ui/button";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "@/components/ui/card";
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
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { api } from "@/utils/api";

const schema = z
	.object({
		mode: z.enum(["auto", "http", "tcp", "none"]),
		path: z.string(),
		port: z.string().regex(/^\d*$/, "Port must be a number"),
	})
	.superRefine((value, ctx) => {
		if (value.mode === "http" && !value.path.startsWith("/")) {
			ctx.addIssue({
				code: "custom",
				path: ["path"],
				message: "Path must start with /",
			});
		}
		const port = Number(value.port);
		if (value.port && (port < 1 || port > 65535)) {
			ctx.addIssue({
				code: "custom",
				path: ["port"],
				message: "Port must be between 1 and 65535",
			});
		}
	});

type FormValues = z.infer<typeof schema>;

interface Props {
	applicationId: string;
}

export const ShowReadinessCheck = ({ applicationId }: Props) => {
	const { data } = api.application.one.useQuery(
		{ applicationId },
		{ enabled: !!applicationId },
	);
	const utils = api.useUtils();
	const { mutateAsync, isPending } = api.application.update.useMutation();

	const form = useForm<FormValues>({
		defaultValues: { mode: "auto", path: "", port: "" },
		resolver: zodResolver(schema),
	});
	const mode = form.watch("mode");

	useEffect(() => {
		if (!data) return;
		const readiness = data.kubernetesProbes?.readiness;
		form.reset({
			mode: readiness?.type ?? "auto",
			path: readiness?.type === "http" ? readiness.path : "",
			port:
				readiness && readiness.type !== "none" && readiness.port
					? String(readiness.port)
					: "",
		});
	}, [data, form]);

	const domain = data?.domains?.find((d) => d.enabled);
	const domainPort = domain ? (domain.port ?? 3000) : undefined;
	const defaultPort =
		domainPort ??
		data?.ports?.find((p) => p.protocol !== "udp")?.targetPort ??
		3000;

	const onSubmit = async (values: FormValues) => {
		const port = values.port ? Number(values.port) : undefined;
		const readiness =
			values.mode === "auto"
				? null
				: values.mode === "http"
					? { type: "http" as const, path: values.path, port }
					: values.mode === "tcp"
						? { type: "tcp" as const, port }
						: { type: "none" as const };
		await mutateAsync({
			applicationId,
			kubernetesProbes: readiness ? { readiness } : null,
		})
			.then(async () => {
				toast.success("Readiness check updated");
				await utils.application.one.invalidate({ applicationId });
			})
			.catch(() => {
				toast.error("Error updating the readiness check");
			});
	};

	return (
		<Card className="bg-background">
			<CardHeader>
				<CardTitle className="text-xl">Readiness Check</CardTitle>
				<CardDescription>
					A new pod gets traffic, and replaces an old one, only after this check
					passes. A deploy whose pods never pass it fails after 5 minutes and
					leaves the previous pods serving. Applies on the next deploy.
				</CardDescription>
			</CardHeader>
			<CardContent>
				<Form {...form}>
					<form
						onSubmit={form.handleSubmit(onSubmit)}
						className="grid w-full gap-4"
					>
						<FormField
							control={form.control}
							name="mode"
							render={({ field }) => (
								<FormItem>
									<FormLabel>Check</FormLabel>
									<Select onValueChange={field.onChange} value={field.value}>
										<FormControl>
											<SelectTrigger>
												<SelectValue />
											</SelectTrigger>
										</FormControl>
										<SelectContent>
											<SelectItem value="auto">Automatic</SelectItem>
											<SelectItem value="http">HTTP request</SelectItem>
											<SelectItem value="tcp">TCP connection</SelectItem>
											<SelectItem value="none">Off</SelectItem>
										</SelectContent>
									</Select>
									<FormDescription>
										{mode === "auto" &&
											(domainPort
												? `Checks that the app accepts connections on port ${domainPort}, the port its domain routes to.`
												: "No check: the app has no domain. Choose HTTP or TCP to check a worker.")}
										{mode === "http" &&
											"Passes when a GET request returns a status from 200 to 399."}
										{mode === "tcp" &&
											"Passes when the app accepts a connection on the port."}
										{mode === "none" &&
											"A pod counts as ready as soon as its container starts."}
									</FormDescription>
									<FormMessage />
								</FormItem>
							)}
						/>
						{mode === "http" && (
							<FormField
								control={form.control}
								name="path"
								render={({ field }) => (
									<FormItem>
										<FormLabel>Path</FormLabel>
										<FormControl>
											<Input placeholder="/healthz" {...field} />
										</FormControl>
										<FormMessage />
									</FormItem>
								)}
							/>
						)}
						{(mode === "http" || mode === "tcp") && (
							<FormField
								control={form.control}
								name="port"
								render={({ field }) => (
									<FormItem>
										<FormLabel>Port</FormLabel>
										<FormControl>
											<Input placeholder={String(defaultPort)} {...field} />
										</FormControl>
										<FormDescription>
											Defaults to the port of the app's first domain, or else
											its first port.
										</FormDescription>
										<FormMessage />
									</FormItem>
								)}
							/>
						)}
						<div className="flex justify-end">
							<Button isLoading={isPending} type="submit" className="w-fit">
								Save
							</Button>
						</div>
					</form>
				</Form>
			</CardContent>
		</Card>
	);
};
