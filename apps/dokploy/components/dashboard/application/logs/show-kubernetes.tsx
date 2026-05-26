import copy from "copy-to-clipboard";
import {
	Check,
	Copy,
	Download as DownloadIcon,
	Loader2,
	Pause,
	Play,
} from "lucide-react";
import React, { useEffect, useRef } from "react";
import { priorities } from "@/components/dashboard/docker/logs/docker-logs-id";
import { LineCountFilter } from "@/components/dashboard/docker/logs/line-count-filter";
import { StatusLogsFilter } from "@/components/dashboard/docker/logs/status-logs-filter";
import { TerminalLine } from "@/components/dashboard/docker/logs/terminal-line";
import {
	getLogType,
	type LogLine,
	parseLogs,
} from "@/components/dashboard/docker/logs/utils";
import { AlertBlock } from "@/components/shared/alert-block";
import { Button } from "@/components/ui/button";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";

type ServiceType = "postgres" | "redis" | "mysql" | "mariadb" | "mongo";

interface Props {
	/** Applications use `applicationId`; databases pass `serviceType`+`serviceId`. */
	applicationId?: string;
	serviceType?: ServiceType;
	serviceId?: string;
}

export const ShowKubernetesPodLogs: React.FC<Props> = ({
	applicationId,
	serviceType,
	serviceId,
}) => {
	// The effect depends on a stable value; serialize the target so a parent
	// switching between application/database modes triggers a fresh connection.
	const target =
		applicationId ??
		(serviceType && serviceId ? `${serviceType}:${serviceId}` : "");
	const [rawLogs, setRawLogs] = React.useState("");
	const [filteredLogs, setFilteredLogs] = React.useState<LogLine[]>([]);
	const [autoScroll, setAutoScroll] = React.useState(true);
	const [lines, setLines] = React.useState<number>(100);
	const [search, setSearch] = React.useState<string>("");
	const [showTimestamp, setShowTimestamp] = React.useState(true);
	const [typeFilter, setTypeFilter] = React.useState<string[]>([]);
	const [isPaused, setIsPaused] = React.useState(false);
	const [messageBuffer, setMessageBuffer] = React.useState<string[]>([]);
	const isPausedRef = useRef(false);
	const scrollRef = useRef<HTMLDivElement>(null);
	const [isLoading, setIsLoading] = React.useState(false);
	const [copied, setCopied] = React.useState(false);

	const handleScroll = () => {
		if (!scrollRef.current) return;
		const { scrollTop, scrollHeight, clientHeight } = scrollRef.current;
		const isAtBottom = Math.abs(scrollHeight - scrollTop - clientHeight) < 10;
		setAutoScroll(isAtBottom);
	};

	const handleLines = (l: number) => {
		setRawLogs("");
		setFilteredLogs([]);
		setMessageBuffer([]);
		setLines(l);
	};

	const handlePauseResume = () => {
		if (isPaused && messageBuffer.length > 0) {
			const buffered = messageBuffer.join("");
			setRawLogs((prev) => {
				const updated = prev + buffered;
				const split = updated.split("\n");
				return split.length > lines ? split.slice(-lines).join("\n") : updated;
			});
			setMessageBuffer([]);
		}
		const next = !isPaused;
		setIsPaused(next);
		isPausedRef.current = next;
	};

	useEffect(() => {
		if (!target) return;

		let isCurrent = true;
		let noDataTimeout: ReturnType<typeof setTimeout> | undefined;
		setIsLoading(true);
		setRawLogs("");
		setFilteredLogs([]);
		setMessageBuffer([]);
		setIsPaused(false);
		isPausedRef.current = false;

		const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
		const params = new globalThis.URLSearchParams({
			tail: lines.toString(),
		});
		if (applicationId) {
			params.set("applicationId", applicationId);
		} else if (serviceType && serviceId) {
			params.set("serviceType", serviceType);
			params.set("serviceId", serviceId);
		}
		const wsUrl = `${protocol}//${window.location.host}/kubernetes-pod-logs?${params.toString()}`;
		const ws = new WebSocket(wsUrl);

		const resetNoDataTimeout = () => {
			if (noDataTimeout) clearTimeout(noDataTimeout);
			noDataTimeout = setTimeout(() => {
				if (isCurrent) setIsLoading(false);
			}, 2000);
		};

		ws.onopen = () => {
			if (!isCurrent) {
				ws.close();
				return;
			}
			resetNoDataTimeout();
		};
		ws.onmessage = (e) => {
			if (!isCurrent) return;
			if (isPausedRef.current) {
				setMessageBuffer((prev) => [...prev, e.data]);
			} else {
				setRawLogs((prev) => {
					const updated = prev + e.data;
					const split = updated.split("\n");
					return split.length > lines
						? split.slice(-lines).join("\n")
						: updated;
				});
			}
			setIsLoading(false);
			if (noDataTimeout) clearTimeout(noDataTimeout);
		};
		ws.onerror = () => {
			if (!isCurrent) return;
			setIsLoading(false);
			if (noDataTimeout) clearTimeout(noDataTimeout);
		};
		ws.onclose = () => {
			if (!isCurrent) return;
			setIsLoading(false);
			if (noDataTimeout) clearTimeout(noDataTimeout);
		};

		return () => {
			isCurrent = false;
			if (noDataTimeout) clearTimeout(noDataTimeout);
			if (ws.readyState === WebSocket.OPEN) ws.close();
		};
	}, [target, lines, applicationId, serviceType, serviceId]);

	useEffect(() => {
		const parsed = parseLogs(rawLogs);
		const filtered = parsed.filter((log) => {
			const t = getLogType(log.message).type;
			return typeFilter.length === 0 || typeFilter.includes(t);
		});
		setFilteredLogs(filtered);
	}, [rawLogs, typeFilter]);

	useEffect(() => {
		if (autoScroll && scrollRef.current) {
			scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
		}
	}, [filteredLogs, autoScroll]);

	const handleCopy = () => {
		const text = filteredLogs
			.map(({ timestamp, message }) =>
				showTimestamp
					? `${timestamp?.toISOString() || ""} ${message}`
					: message,
			)
			.join("\n");
		if (copy(text)) {
			setCopied(true);
			setTimeout(() => setCopied(false), 2000);
		}
	};

	const handleDownload = () => {
		const text = filteredLogs
			.map(
				({ timestamp, message }) =>
					`${timestamp?.toISOString() || "No timestamp"} ${message}`,
			)
			.join("\n");
		const blob = new Blob([text], { type: "text/plain" });
		const url = URL.createObjectURL(blob);
		const a = document.createElement("a");
		const isoDate = new Date().toISOString();
		a.href = url;
		a.download = `pod-${isoDate.slice(0, 10).replace(/-/g, "")}_${isoDate
			.slice(11, 19)
			.replace(/:/g, "")}.log.txt`;
		document.body.appendChild(a);
		a.click();
		document.body.removeChild(a);
		URL.revokeObjectURL(url);
	};

	return (
		<Card className="bg-background">
			<CardHeader>
				<CardTitle className="text-xl">Pod Logs</CardTitle>
				<CardDescription>
					Live logs streamed from the matching Kubernetes pod.
				</CardDescription>
			</CardHeader>
			<CardContent className="flex flex-col gap-4">
				<div className="flex flex-wrap justify-between items-start sm:items-center gap-4">
					<div className="flex flex-wrap gap-4">
						<LineCountFilter value={lines} onValueChange={handleLines} />
						<StatusLogsFilter
							value={typeFilter}
							setValue={setTypeFilter}
							title="Log type"
							options={priorities}
						/>
						<Input
							type="search"
							placeholder="Search logs..."
							value={search}
							onChange={(e) => setSearch(e.target.value || "")}
							className="inline-flex h-9 text-sm placeholder-gray-400 w-full sm:w-auto"
						/>
						<label className="flex items-center gap-2 text-sm">
							<input
								type="checkbox"
								checked={showTimestamp}
								onChange={(e) => setShowTimestamp(e.target.checked)}
							/>
							Show timestamps
						</label>
					</div>
					<div className="flex gap-2">
						<Button
							variant="outline"
							size="sm"
							className="h-9"
							onClick={handlePauseResume}
							title={isPaused ? "Resume logs" : "Pause logs"}
						>
							{isPaused ? (
								<Play className="mr-2 h-4 w-4" />
							) : (
								<Pause className="mr-2 h-4 w-4" />
							)}
							{isPaused ? "Resume" : "Pause"}
						</Button>
						<Button
							variant="outline"
							size="sm"
							className="h-9"
							onClick={handleCopy}
							disabled={filteredLogs.length === 0}
						>
							{copied ? (
								<Check className="mr-2 h-4 w-4" />
							) : (
								<Copy className="mr-2 h-4 w-4" />
							)}
							Copy
						</Button>
						<Button
							variant="outline"
							size="sm"
							className="h-9 sm:w-auto w-full"
							onClick={handleDownload}
							disabled={filteredLogs.length === 0}
						>
							<DownloadIcon className="mr-2 h-4 w-4" />
							Download
						</Button>
					</div>
				</div>
				{isPaused && (
					<AlertBlock type="warning">
						<div className="flex items-center gap-2">
							<Pause className="h-4 w-4" />
							<span>
								Logs paused
								{messageBuffer.length > 0 && (
									<span className="ml-1 font-medium">
										({messageBuffer.length} messages buffered)
									</span>
								)}
							</span>
						</div>
					</AlertBlock>
				)}
				<div
					ref={scrollRef}
					onScroll={handleScroll}
					className="h-[720px] overflow-y-auto space-y-0 border p-4 bg-[#fafafa] dark:bg-[#050506] rounded custom-logs-scrollbar"
				>
					{filteredLogs.length > 0 ? (
						filteredLogs.map((line, i) => (
							<TerminalLine
								key={`${line.rawTimestamp ?? ""}-${i}`}
								log={line}
								searchTerm={search}
								noTimestamp={!showTimestamp}
							/>
						))
					) : isLoading ? (
						<div className="flex justify-center items-center h-full text-muted-foreground">
							<Loader2 className="h-6 w-6 animate-spin" />
						</div>
					) : (
						<div className="flex justify-center items-center h-full text-muted-foreground">
							No logs found
						</div>
					)}
				</div>
			</CardContent>
		</Card>
	);
};
