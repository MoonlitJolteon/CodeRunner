import { unwatchFile, watchFile } from "node:fs";
import { join } from "node:path";
import * as vscode from "vscode";
import {
	claimDebugRun,
	DEBUG_SESSION_NAME,
	type DebugMarker,
	isProcessAlive,
	parseDebugMarker,
	readTextFile,
} from "./debug-marker";

const ATTACH_ATTEMPTS = 10;

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

async function attach(marker: DebugMarker): Promise<void> {
	for (let attempt = 0; attempt < ATTACH_ATTEMPTS; attempt += 1) {
		// The marker is written just before the JVM opens the JDWP port.
		await delay(attempt === 0 ? 300 : 1_000);
		if (!isProcessAlive(marker.pid)) return;
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
	}
}

export function activate(context: vscode.ExtensionContext): void {
	const home = process.env.HOME ?? "/config";
	const markerPath = join(home, "sim-debug.json");
	let handledPid: number | null = null;

	const check = () => {
		const marker = parseDebugMarker(readTextFile(markerPath));
		if (!marker || marker.pid === handledPid) return;
		handledPid = marker.pid;
		if (claimDebugRun(home, marker.pid)) {
			void attach(marker);
		}
	};

	// Polling: the marker lives outside the workspace folder, where VS Code's
	// file watchers don't reach.
	watchFile(markerPath, { interval: 500 }, check);
	context.subscriptions.push({ dispose: () => unwatchFile(markerPath, check) });
	check();
}

export function deactivate(): void {}
