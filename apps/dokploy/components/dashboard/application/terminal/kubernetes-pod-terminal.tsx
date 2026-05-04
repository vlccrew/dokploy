import { AttachAddon } from "@xterm/addon-attach";
import { Terminal } from "@xterm/xterm";
import { useTheme } from "next-themes";
import React, { useEffect, useRef } from "react";
import { FitAddon } from "xterm-addon-fit";
import "@xterm/xterm/css/xterm.css";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";

interface Props {
	id: string;
	applicationId: string;
}

export const KubernetesPodTerminal: React.FC<Props> = ({
	id,
	applicationId,
}) => {
	const termRef = useRef<HTMLDivElement | null>(null);
	const [activeWay, setActiveWay] = React.useState<string>("/bin/sh");
	const { resolvedTheme } = useTheme();

	useEffect(() => {
		if (!applicationId) return;

		const container = document.getElementById(id);
		if (container) container.innerHTML = "";

		const term = new Terminal({
			cursorBlink: true,
			lineHeight: 1.4,
			convertEol: true,
			theme: {
				cursor: resolvedTheme === "light" ? "#000000" : "transparent",
				background: "rgba(0, 0, 0, 0)",
				foreground: "currentColor",
			},
		});
		const fit = new FitAddon();
		const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
		const wsUrl = `${protocol}//${window.location.host}/kubernetes-pod-exec?applicationId=${encodeURIComponent(applicationId)}&activeWay=${encodeURIComponent(activeWay)}`;
		const ws = new WebSocket(wsUrl);
		const attach = new AttachAddon(ws);

		// @ts-ignore
		term.open(termRef.current);
		term.loadAddon(fit);
		term.loadAddon(attach);
		fit.fit();

		return () => {
			if (ws.readyState === WebSocket.OPEN) ws.close();
		};
	}, [applicationId, activeWay, id, resolvedTheme]);

	return (
		<div className="flex flex-col gap-4">
			<div className="flex flex-col gap-2 mt-4">
				<span>
					Connect to the pod for <b>{applicationId.slice(0, 12)}...</b>
				</span>
				<Tabs value={activeWay} onValueChange={setActiveWay}>
					<TabsList>
						<TabsTrigger value="/bin/sh">/bin/sh</TabsTrigger>
						<TabsTrigger value="/bin/bash">/bin/bash</TabsTrigger>
					</TabsList>
				</Tabs>
			</div>
			<div className="w-full h-full rounded-lg p-2 bg-transparent border">
				<div id={id} ref={termRef} />
			</div>
		</div>
	);
};
