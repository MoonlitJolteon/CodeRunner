import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const DEBUG_SESSION_NAME = "Debug Simulation";

/** Written by run-sim.sh just before it exec's the robot JVM in debug mode. */
export type DebugMarker = { port: number; pid: number };

function isPositiveInteger(value: unknown): value is number {
	return typeof value === "number" && Number.isInteger(value) && value > 0;
}

export function parseDebugMarker(text: string | null): DebugMarker | null {
	if (!text) return null;
	try {
		const value = JSON.parse(text) as { port?: unknown; pid?: unknown };
		if (isPositiveInteger(value.port) && isPositiveInteger(value.pid)) {
			return { port: value.port, pid: value.pid };
		}
	} catch {
		// Partially written or garbage marker: wait for the next poll.
	}
	return null;
}

export function readTextFile(path: string): string | null {
	try {
		return readFileSync(path, "utf8");
	} catch {
		return null;
	}
}

/**
 * Every open editor tab runs its own extension host. Creating the claim file
 * with O_EXCL lets exactly one of them attach to a given sim pid. stop-sim.sh
 * deletes claims, so a pid is never left claimed across runs.
 */
export function claimDebugRun(home: string, pid: number): boolean {
	try {
		writeFileSync(join(home, `sim-debug.${pid}.claim`), `${process.pid}\n`, {
			flag: "wx",
		});
		return true;
	} catch {
		return false;
	}
}

/** The sim runs as root and the editor as abc, so EPERM still means alive. */
export function isProcessAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

const TCP_LISTEN = "0A";

/**
 * Whether `/proc/net/tcp` shows a socket listening on `port`. Used to wait for
 * the JDWP agent before attaching: a connect probe would use up its single
 * accept.
 */
export function isPortListening(
	procNetTcp: string | null,
	port: number,
): boolean {
	if (!procNetTcp) return false;
	const hexPort = port.toString(16).toUpperCase().padStart(4, "0");
	return procNetTcp
		.split("\n")
		.slice(1)
		.some((line) => {
			const [, local, , state] = line.trim().split(/\s+/);
			return local?.endsWith(`:${hexPort}`) === true && state === TCP_LISTEN;
		});
}
