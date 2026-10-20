import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	claimDebugRun,
	isPortListening,
	isProcessAlive,
	parseDebugMarker,
	resolvesWithin,
} from "./debug-marker";

describe("parseDebugMarker", () => {
	test("reads the marker written by run-sim.sh", () => {
		expect(parseDebugMarker('{"port":5005,"pid":1234}\n')).toEqual({
			port: 5005,
			pid: 1234,
		});
	});

	test("rejects missing, partial or malformed markers", () => {
		expect(parseDebugMarker(null)).toBeNull();
		expect(parseDebugMarker("")).toBeNull();
		expect(parseDebugMarker('{"port":5005')).toBeNull();
		expect(parseDebugMarker('{"port":5005}')).toBeNull();
		expect(parseDebugMarker('{"port":"5005","pid":1}')).toBeNull();
		expect(parseDebugMarker('{"port":0,"pid":1}')).toBeNull();
	});
});

describe("claimDebugRun", () => {
	test("exactly one claim per sim pid succeeds (two editor tabs)", async () => {
		const home = await mkdtemp(join(tmpdir(), "coderunner-debug-claim-"));
		try {
			expect(claimDebugRun(home, 4242)).toBe(true);
			expect(claimDebugRun(home, 4242)).toBe(false);
			// A new run (new pid) can be claimed again.
			expect(claimDebugRun(home, 4343)).toBe(true);
		} finally {
			await rm(home, { recursive: true, force: true });
		}
	});
});

describe("isProcessAlive", () => {
	test("is true for this process and false for an unused pid", () => {
		expect(isProcessAlive(process.pid)).toBe(true);
		expect(isProcessAlive(2_147_483_646)).toBe(false);
	});
});

describe("isPortListening", () => {
	const header =
		"  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode\n";
	const row = (local: string, state: string) =>
		`   0: ${local} 00000000:0000 ${state} 00000000:00000000 00:00000000 00000000     0        0 12345 1 0000000000000000 100 0 0 10 0\n`;

	test("finds the JDWP port in LISTEN state on loopback", () => {
		expect(isPortListening(header + row("0100007F:138D", "0A"), 5005)).toBe(
			true,
		);
	});

	test("ignores other ports, non-listening sockets and missing data", () => {
		expect(isPortListening(header + row("0100007F:16AA", "0A"), 5005)).toBe(
			false,
		);
		// 01 = ESTABLISHED, e.g. a connection whose local port happens to match.
		expect(isPortListening(header + row("0100007F:138D", "01"), 5005)).toBe(
			false,
		);
		expect(isPortListening(header, 5005)).toBe(false);
		expect(isPortListening(null, 5005)).toBe(false);
	});
});

describe("resolvesWithin", () => {
	test("is true when the promise resolves in time", async () => {
		expect(await resolvesWithin(Promise.resolve([]), 1_000)).toBe(true);
	});

	test("is false when the promise never settles", async () => {
		expect(await resolvesWithin(new Promise(() => {}), 20)).toBe(false);
	});

	test("is false when the promise rejects", async () => {
		expect(await resolvesWithin(Promise.reject(new Error("x")), 1_000)).toBe(
			false,
		);
	});
});
