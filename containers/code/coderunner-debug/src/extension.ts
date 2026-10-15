import { unwatchFile, watchFile } from "node:fs";
import { join } from "node:path";
import * as vscode from "vscode";
import {
	claimDebugRun,
	DEBUG_SESSION_NAME,
	type DebugMarker,
	isPortListening,
	isProcessAlive,
	parseDebugMarker,
	readTextFile,
	resolvesWithin,
} from "./debug-marker";

const ATTACH_ATTEMPTS = 3;
const LISTEN_POLL_MS = 250;
const WINDOW_CHECK_MS = 5_000;

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Resolves true once the JDWP port is listening, false if the JVM exits first. */
async function waitForListener(marker: DebugMarker): Promise<boolean> {
	// No deadline of our own: the JVM's JDWP timeout ends the wait.
	while (isProcessAlive(marker.pid)) {
		if (isPortListening(readTextFile("/proc/net/tcp"), marker.port)) {
			return true;
		}
		await delay(LISTEN_POLL_MS);
	}
	return false;
}

/**
 * Whether this extension host still has a browser window. An editor tab that
 * was reloaded or removed leaves its host running for codium-server's
 * reconnection grace; calls into its window then never answer. getCommands
 * round-trips to the window and has no side effects.
 */
function hasWindow(): Promise<boolean> {
	return resolvesWithin(
		Promise.resolve(vscode.commands.getCommands()),
		WINDOW_CHECK_MS,
	);
}

async function attach(marker: DebugMarker): Promise<void> {
	if (!(await waitForListener(marker))) return;
	for (let attempt = 0; attempt < ATTACH_ATTEMPTS; attempt += 1) {
		if (attempt > 0) await delay(1_000);
		if (!isProcessAlive(marker.pid)) return;
		try {
			const started = await vscode.debug.startDebugging(
				vscode.workspace.workspaceFolders?.[0],
				{
					type: "java",
					request: "attach",
					name: DEBUG_SESSION_NAME,
					hostName: "127.0.0.1",
					port: marker.port,
				},
			);
			if (started) return;
		} catch {
			// Treat a thrown start like a failed one and retry.
		}
	}
}

export function activate(context: vscode.ExtensionContext): void {
	const home = process.env.HOME ?? "/config";
	const markerPath = join(home, "sim-debug.json");
	let handledPid: number | null = null;

	const claimAndAttach = async (marker: DebugMarker) => {
		// A windowless host that won the claim would attach where no one sees it.
		if (!(await hasWindow())) return;
		if (claimDebugRun(home, marker.pid)) {
			await attach(marker);
		}
	};

	const check = () => {
		const marker = parseDebugMarker(readTextFile(markerPath));
		if (!marker || marker.pid === handledPid) return;
		handledPid = marker.pid;
		void claimAndAttach(marker);
	};

	// Polling: the marker lives outside the workspace folder, where VS Code's
	// file watchers don't reach.
	watchFile(markerPath, { interval: 500 }, check);
	context.subscriptions.push({ dispose: () => unwatchFile(markerPath, check) });
	check();
}

export function deactivate(): void {}
