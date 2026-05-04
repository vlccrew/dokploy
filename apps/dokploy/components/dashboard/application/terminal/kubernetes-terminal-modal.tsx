import dynamic from "next/dynamic";
import type React from "react";
import { useState } from "react";
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

const PodTerminal = dynamic(
	() =>
		import(
			"@/components/dashboard/application/terminal/kubernetes-pod-terminal"
		).then((m) => m.KubernetesPodTerminal),
	{ ssr: false },
);

interface Props {
	applicationId: string;
	children?: React.ReactNode;
}

export const KubernetesTerminalModal = ({ applicationId, children }: Props) => {
	const [mainOpen, setMainOpen] = useState(false);
	const [confirmOpen, setConfirmOpen] = useState(false);

	const handleOpenChange = (open: boolean) => {
		if (!open) setConfirmOpen(true);
		else setMainOpen(true);
	};

	return (
		<Dialog open={mainOpen} onOpenChange={handleOpenChange}>
			<DialogTrigger asChild>{children}</DialogTrigger>
			<DialogContent
				className="max-h-[85vh] sm:max-w-7xl"
				onEscapeKeyDown={(e) => e.preventDefault()}
			>
				<DialogHeader>
					<DialogTitle>Pod Terminal</DialogTitle>
					<DialogDescription>
						Interactive shell into the application's Kubernetes pod.
					</DialogDescription>
				</DialogHeader>
				<PodTerminal id="k8s-pod-terminal" applicationId={applicationId} />
				<Dialog open={confirmOpen} onOpenChange={setConfirmOpen}>
					<DialogContent onEscapeKeyDown={(e) => e.preventDefault()}>
						<DialogHeader>
							<DialogTitle>Close terminal?</DialogTitle>
							<DialogDescription>
								Closing the dialog will end the pod exec session.
							</DialogDescription>
						</DialogHeader>
						<DialogFooter>
							<Button variant="outline" onClick={() => setConfirmOpen(false)}>
								Cancel
							</Button>
							<Button
								onClick={() => {
									setConfirmOpen(false);
									setMainOpen(false);
								}}
							>
								Confirm
							</Button>
						</DialogFooter>
					</DialogContent>
				</Dialog>
			</DialogContent>
		</Dialog>
	);
};
