import {
	Bug,
	ChevronDown,
	Hammer,
	Play,
	RotateCcw,
	Square,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { SimRunMode, SimRunStatus } from "@/lib/contracts";
import { cn } from "@/lib/utils";

interface SimControlsBlockProps {
	runStatus: SimRunStatus;
	sessionReady: boolean;
	onStart: (mode: SimRunMode) => void;
	onStop: () => void;
	onRestart: () => void;
}

interface SimButtonProps {
	label: string;
	Icon: typeof Play;
	onClick: () => void;
	disabled: boolean;
	tone: "start" | "stop" | "restart";
	testId?: string;
	className?: string;
}

const TONE_CLASSES: Record<SimButtonProps["tone"], string> = {
	start: "text-emerald-300 [&_svg]:text-emerald-400",
	stop: "text-red-300 [&_svg]:text-red-400",
	restart: "text-muted-foreground [&_svg]:text-muted-foreground",
};

function SimButton({
	label,
	Icon,
	onClick,
	disabled,
	tone,
	testId,
	className,
}: SimButtonProps) {
	return (
		<Button
			type="button"
			onClick={onClick}
			disabled={disabled}
			data-testid={testId}
			variant="outline"
			className={cn(
				"flex h-full min-h-0 flex-1 flex-row items-center justify-center gap-1.5 rounded-md border-border bg-card/40 px-2 py-1.5 text-[11px] font-semibold uppercase tracking-[0.12em] transition-colors hover:bg-white/[0.05] disabled:opacity-40",
				TONE_CLASSES[tone],
				className,
			)}
		>
			<Icon className="size-4" />
			{label}
		</Button>
	);
}

export function SimControlsBlock({
	runStatus,
	sessionReady,
	onStart,
	onStop,
	onRestart,
}: SimControlsBlockProps) {
	const runBusy = ["building", "running", "stopping"].includes(runStatus);
	const canRestart = runStatus === "running";
	const startDisabled = runBusy || !sessionReady;

	return (
		<div className="flex h-full min-h-0 flex-col gap-1.5 overflow-hidden rounded-lg border border-border bg-card p-1.5">
			<span className="px-1 pt-0.5 text-[9.5px] font-medium uppercase tracking-[0.14em] text-muted-foreground">
				Sim Controls
			</span>
			<div className="flex min-h-0 flex-1 items-stretch gap-1.5">
				<div className="flex min-h-0 flex-1 items-stretch">
					<SimButton
						label="Start"
						Icon={Play}
						onClick={() => onStart("run")}
						disabled={startDisabled}
						tone="start"
						testId="run-button"
						className="rounded-r-none"
					/>
					<DropdownMenu>
						<DropdownMenuTrigger
							disabled={startDisabled}
							render={
								<Button
									type="button"
									variant="outline"
									aria-label="More ways to start"
									data-testid="run-mode-menu"
									className="h-full min-h-0 rounded-l-none border-l-0 border-border bg-card/40 px-1 text-emerald-300 hover:bg-white/[0.05] disabled:opacity-40"
								/>
							}
						>
							<ChevronDown className="size-3.5" />
						</DropdownMenuTrigger>
						<DropdownMenuContent align="end" className="min-w-40">
							<DropdownMenuItem onClick={() => onStart("debug")}>
								<Bug />
								Debug
							</DropdownMenuItem>
							<DropdownMenuItem onClick={() => onStart("build")}>
								<Hammer />
								Build
							</DropdownMenuItem>
						</DropdownMenuContent>
					</DropdownMenu>
				</div>
				<SimButton
					label="Stop"
					Icon={Square}
					onClick={onStop}
					disabled={!runBusy}
					tone="stop"
					testId="stop-button"
				/>
				<SimButton
					label="Restart"
					Icon={RotateCcw}
					onClick={onRestart}
					disabled={!canRestart || !sessionReady}
					tone="restart"
					testId="restart-button"
				/>
			</div>
		</div>
	);
}
