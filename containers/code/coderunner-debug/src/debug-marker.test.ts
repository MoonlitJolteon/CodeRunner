import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	claimDebugRun,
	isProcessAlive,
	parseDebugMarker,
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
