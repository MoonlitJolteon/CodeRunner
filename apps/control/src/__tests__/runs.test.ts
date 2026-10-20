import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ControlAppOptions, createApp } from "../app";
import { dockerRunScript, type RunCommandFactory } from "../runs";
import {
	cookieFrom,
	createAdvantageScopeDist,
	createCatalogDir,
	createFakeDocker,
	createWebDist,
	login,
	waitFor,
	withApp,
	workspaceBySlug,
} from "./helpers";

describe("run lifecycle and log streaming", () => {
	function createControlledRunCommands(options: { exitOnKill?: boolean } = {}) {
		const exitOnKill = options.exitOnKill ?? true;
		const encoder = new TextEncoder();
		const commands: Array<{
			context: Parameters<RunCommandFactory>[0];
			killed: boolean;
			writeStdout(line: string): void;
			writeStderr(line: string): void;
			exit(code: number | null, signal?: string | null): void;
		}> = [];

		const commandFactory: RunCommandFactory = (context) => {
			let stdoutController: ReadableStreamDefaultController<Uint8Array>;
			let stderrController: ReadableStreamDefaultController<Uint8Array>;
			let resolveExit: (exit: {
				code: number | null;
				signal: string | null;
			}) => void = () => {};
			let finished = false;
			const exited = new Promise<{
				code: number | null;
				signal: string | null;
			}>((resolve) => {
				resolveExit = resolve;
			});

			const command = {
				context,
				killed: false,
				writeStdout(line: string) {
					stdoutController.enqueue(encoder.encode(`${line}\n`));
				},
				writeStderr(line: string) {
					stderrController.enqueue(encoder.encode(`${line}\n`));
				},
				exit(code: number | null, signal: string | null = null) {
					if (finished) {
						return;
					}
					finished = true;
					stdoutController.close();
					stderrController.close();
					resolveExit({ code, signal });
				},
			};

			commands.push(command);
			return {
				stdout: new ReadableStream<Uint8Array>({
					start(controller) {
						stdoutController = controller;
					},
				}),
				stderr: new ReadableStream<Uint8Array>({
					start(controller) {
						stderrController = controller;
					},
				}),
				exited,
				kill() {
					command.killed = true;
					if (exitOnKill) {
						command.exit(null, "SIGTERM");
					}
				},
			};
		};

		return { commands, commandFactory };
	}

	test("streams logs, persists run jobs, and releases the build slot after readiness", async () => {
		const fakeDocker = createFakeDocker();
		const controlled = createControlledRunCommands();

		await withApp(
			async (app) => {
				const aliceLogin = await login(app, "alice");
				const bobLogin = await login(app, "bob");
				expect(aliceLogin.status).toBe(303);
				expect(bobLogin.status).toBe(303);

				const aliceWorkspace = workspaceBySlug(app, "alice");
				const bobWorkspace = workspaceBySlug(app, "bob");
				const aliceMessages: unknown[] = [];
				const bobMessages: unknown[] = [];
				const aliceConnection = app.runs.connect(aliceWorkspace, (message) =>
					aliceMessages.push(message),
				);
				const bobConnection = app.runs.connect(bobWorkspace, (message) =>
					bobMessages.push(message),
				);

				const aliceRunId = app.runs.start(aliceWorkspace, aliceConnection);
				const bobRunId = app.runs.start(bobWorkspace, bobConnection);

				await waitFor(() => controlled.commands.length === 2);
				expect(controlled.commands[0]?.context.workspace.slug).toBe("alice");
				expect(controlled.commands[1]?.context.workspace.slug).toBe("bob");
				expect(bobMessages).toContainEqual({
					type: "status",
					status: "building",
				});

				controlled.commands[0]?.writeStdout("NT4 listening on 5810");
				controlled.commands[0]?.writeStdout("robot periodic tick");
				await waitFor(() => JSON.stringify(aliceMessages).includes("running"));

				const aliceRun = app.storage.getRunJob(aliceRunId);
				expect(aliceRun).toMatchObject({
					state: "running",
					workspace_id: aliceWorkspace.id,
				});
				expect(await readFile(aliceRun?.log_path ?? "", "utf8")).toContain(
					"robot periodic tick",
				);
				expect(app.storage.getRunJob(bobRunId)).toMatchObject({
					state: "building",
				});
				expect(controlled.commands[0]?.killed).toBe(false);
				expect(app.runs.activeBuildCount()).toBe(1);

				app.runs.stopWorkspace(aliceWorkspace.id);
				expect(controlled.commands[0]?.killed).toBe(true);
				await waitFor(
					() => app.storage.getRunJob(aliceRunId)?.state === "stopped",
				);
				expect(app.storage.getRunJob(aliceRunId)).toMatchObject({
					state: "stopped",
					exit_code: null,
				});
				app.runs.stopWorkspace(bobWorkspace.id);
			},
			{
				dockerRunner: fakeDocker.runner,
				runCommandFactory: controlled.commandFactory,
				codeImage: "coderunner-workspace:test",
				simPortRange: { start: 25820, end: 25829 },
				vscodePortRange: { start: 33020, end: 33029 },
			},
		);
	});

	test("times out a run that never reaches simulator readiness", async () => {
		const fakeDocker = createFakeDocker();
		const controlled = createControlledRunCommands();

		await withApp(
			async (app) => {
				await login(app, "alice");
				await login(app, "bob");
				const aliceWorkspace = workspaceBySlug(app, "alice");
				const bobWorkspace = workspaceBySlug(app, "bob");
				const aliceMessages: unknown[] = [];
				const bobMessages: unknown[] = [];
				const aliceConnection = app.runs.connect(aliceWorkspace, (message) =>
					aliceMessages.push(message),
				);
				const bobConnection = app.runs.connect(bobWorkspace, (message) =>
					bobMessages.push(message),
				);

				const aliceRunId = app.runs.start(aliceWorkspace, aliceConnection);
				app.runs.start(bobWorkspace, bobConnection);

				await waitFor(() => controlled.commands.length === 2);
				await waitFor(() => controlled.commands[0]?.killed === true);
				expect(app.storage.getRunJob(aliceRunId)).toMatchObject({
					state: "failed",
					exit_code: null,
				});
				expect(JSON.stringify(aliceMessages)).toContain(
					"timed out before simulator readiness",
				);
				expect(controlled.commands[1]?.context.workspace.slug).toBe("bob");
				expect(bobMessages).toContainEqual({
					type: "status",
					status: "building",
				});
				app.runs.stopWorkspace(bobWorkspace.id);
			},
			{
				dockerRunner: fakeDocker.runner,
				runCommandFactory: controlled.commandFactory,
				runBuildTimeoutMs: 20,
				simStartupTimeoutMs: 20,
				codeImage: "coderunner-workspace:test",
				simPortRange: { start: 25840, end: 25849 },
				vscodePortRange: { start: 33040, end: 33049 },
			},
		);
	});

	test("replaces an active run for the same workspace", async () => {
		const fakeDocker = createFakeDocker();
		const controlled = createControlledRunCommands();

		await withApp(
			async (app) => {
				const response = await login(app, "alice");
				expect(response.status).toBe(303);
				const workspace = workspaceBySlug(app, "alice");
				const messages: unknown[] = [];
				const connection = app.runs.connect(workspace, (message) =>
					messages.push(message),
				);

				const firstRunId = app.runs.start(workspace, connection);
				await waitFor(() => controlled.commands.length === 1);
				const secondRunId = app.runs.start(workspace, connection);

				await waitFor(() => controlled.commands.length === 2);
				expect(firstRunId).not.toBe(secondRunId);
				expect(controlled.commands[0]?.context.workspace.slug).toBe("alice");
				expect(controlled.commands[0]?.killed).toBe(true);
				expect(controlled.commands[1]?.context.workspace.slug).toBe("alice");
				expect(app.storage.getRunJob(firstRunId)).toMatchObject({
					state: "stopped",
				});
				expect(app.storage.getRunJob(secondRunId)).toMatchObject({
					state: "building",
				});
			},
			{
				dockerRunner: fakeDocker.runner,
				runCommandFactory: controlled.commandFactory,
				codeImage: "coderunner-workspace:test",
				simPortRange: { start: 25830, end: 25839 },
				vscodePortRange: { start: 33030, end: 33039 },
			},
		);
	});

	test("a superseded run does not overwrite the current run's status", async () => {
		const fakeDocker = createFakeDocker();
		// kill() must NOT auto-resolve `exited`, so we can defer the old run's
		// terminal `finishJob` until after the new run has fully finished. That is
		// the race this guard protects against.
		const controlled = createControlledRunCommands({ exitOnKill: false });

		await withApp(
			async (app) => {
				expect((await login(app, "alice")).status).toBe(303);
				const workspace = workspaceBySlug(app, "alice");
				const connection = app.runs.connect(workspace, () => {});

				// Run A: started, command created, but its exit is held open.
				const runA = app.runs.start(workspace, connection);
				await waitFor(() => controlled.commands.length === 1);

				// Run B supersedes A on the same workspace. cancelWorkspace marks A
				// canceled and "kills" command 0 (no exit yet), then registers B.
				const runB = app.runs.start(workspace, connection);
				await waitFor(() => controlled.commands.length === 2);
				expect(runA).not.toBe(runB);
				expect(controlled.commands[0]?.killed).toBe(true);

				// Drive B to running, then stop it so B reaches its own terminal
				// status and leaves jobsByWorkspace with the correct snapshot.
				controlled.commands[1]?.writeStdout("NT4 listening on 5810");
				await waitFor(
					() =>
						app.runs.getWorkspaceSnapshot(workspace.id).status === "running",
				);
				app.runs.stopWorkspace(workspace.id);
				controlled.commands[1]?.exit(0, "SIGTERM");
				await waitFor(() => app.storage.getRunJob(runB)?.state === "stopped");
				expect(app.runs.getWorkspaceSnapshot(workspace.id)).toMatchObject({
					status: "stopped",
					runId: runB,
				});

				// Now the old run A finally exits. Its terminal finishJob must NOT
				// clobber the workspace snapshot that now belongs to run B.
				controlled.commands[0]?.exit(null, "SIGTERM");
				await waitFor(() => app.storage.getRunJob(runA)?.state === "stopped");

				// A's per-job row is still recorded as stopped (unguarded), but the
				// shared snapshot keeps B's identity.
				expect(app.storage.getRunJob(runA)).toMatchObject({ state: "stopped" });
				expect(app.runs.getWorkspaceSnapshot(workspace.id)).toMatchObject({
					status: "stopped",
					runId: runB,
				});
			},
			{
				dockerRunner: fakeDocker.runner,
				runCommandFactory: controlled.commandFactory,
				codeImage: "coderunner-workspace:test",
				simPortRange: { start: 25860, end: 25869 },
				vscodePortRange: { start: 33060, end: 33069 },
			},
		);
	});

	test("passes the requested mode to the run command and remembers it", async () => {
		const fakeDocker = createFakeDocker();
		const controlled = createControlledRunCommands();

		await withApp(
			async (app) => {
				await login(app, "alice");
				const workspace = workspaceBySlug(app, "alice");
				const connection = app.runs.connect(workspace, () => {});

				expect(app.runs.lastMode(workspace.id)).toBe("run");
				app.runs.start(workspace, connection);
				await waitFor(() => controlled.commands.length === 1);
				expect(controlled.commands[0]?.context.mode).toBe("run");

				app.runs.start(workspace, connection, "debug");
				await waitFor(() => controlled.commands.length === 2);
				expect(controlled.commands[1]?.context.mode).toBe("debug");
				expect(app.runs.lastMode(workspace.id)).toBe("debug");
				app.runs.stopWorkspace(workspace.id);
			},
			{
				dockerRunner: fakeDocker.runner,
				runCommandFactory: controlled.commandFactory,
				codeImage: "coderunner-workspace:test",
				simPortRange: { start: 25870, end: 25879 },
				vscodePortRange: { start: 33070, end: 33079 },
			},
		);
	});

	test("a successful build ends stopped and never reports running, even if output mentions NetworkTables", async () => {
		const fakeDocker = createFakeDocker();
		const controlled = createControlledRunCommands();

		await withApp(
			async (app) => {
				await login(app, "alice");
				const workspace = workspaceBySlug(app, "alice");
				const messages: unknown[] = [];
				const connection = app.runs.connect(workspace, (message) =>
					messages.push(message),
				);

				const runId = app.runs.start(workspace, connection, "build");
				await waitFor(() => controlled.commands.length === 1);
				controlled.commands[0]?.writeStdout(
					"Download https://frcmaven.wpi.edu/.../networktables-java.jar",
				);
				controlled.commands[0]?.writeStdout("NT4 listening on 5810");
				controlled.commands[0]?.writeStdout("BUILD SUCCESSFUL in 12s");
				controlled.commands[0]?.exit(0);

				await waitFor(() => app.storage.getRunJob(runId)?.state === "stopped");
				expect(messages).not.toContainEqual({
					type: "status",
					status: "running",
				});
			},
			{
				dockerRunner: fakeDocker.runner,
				runCommandFactory: controlled.commandFactory,
				codeImage: "coderunner-workspace:test",
				simPortRange: { start: 25880, end: 25889 },
				vscodePortRange: { start: 33080, end: 33089 },
			},
		);
	});

	test("a failed build ends failed", async () => {
		const fakeDocker = createFakeDocker();
		const controlled = createControlledRunCommands();

		await withApp(
			async (app) => {
				await login(app, "alice");
				const workspace = workspaceBySlug(app, "alice");
				const connection = app.runs.connect(workspace, () => {});
				const runId = app.runs.start(workspace, connection, "build");
				await waitFor(() => controlled.commands.length === 1);
				controlled.commands[0]?.writeStderr("BUILD FAILED in 3s");
				controlled.commands[0]?.exit(1);
				await waitFor(() => app.storage.getRunJob(runId)?.state === "failed");
			},
			{
				dockerRunner: fakeDocker.runner,
				runCommandFactory: controlled.commandFactory,
				codeImage: "coderunner-workspace:test",
				simPortRange: { start: 25890, end: 25899 },
				vscodePortRange: { start: 33090, end: 33099 },
			},
		);
	});

	test("build mode times out on the build timeout alone", async () => {
		const fakeDocker = createFakeDocker();
		const controlled = createControlledRunCommands();

		await withApp(
			async (app) => {
				await login(app, "alice");
				const workspace = workspaceBySlug(app, "alice");
				const messages: unknown[] = [];
				const connection = app.runs.connect(workspace, (message) =>
					messages.push(message),
				);
				const runId = app.runs.start(workspace, connection, "build");
				await waitFor(() => controlled.commands[0]?.killed === true);
				expect(app.storage.getRunJob(runId)).toMatchObject({ state: "failed" });
				expect(JSON.stringify(messages)).toContain("Build timed out");
			},
			{
				dockerRunner: fakeDocker.runner,
				runCommandFactory: controlled.commandFactory,
				runBuildTimeoutMs: 20,
				simStartupTimeoutMs: 600_000,
				codeImage: "coderunner-workspace:test",
				simPortRange: { start: 25900, end: 25909 },
				vscodePortRange: { start: 33160, end: 33169 },
			},
		);
	});

	test("a debug run waiting on the debugger is not failed by the readiness timeout", async () => {
		const fakeDocker = createFakeDocker();
		const controlled = createControlledRunCommands();

		await withApp(
			async (app) => {
				await login(app, "alice");
				const workspace = workspaceBySlug(app, "alice");
				const connection = app.runs.connect(workspace, () => {});
				const runId = app.runs.start(workspace, connection, "debug");
				await waitFor(() => controlled.commands.length === 1);
				controlled.commands[0]?.writeStdout(
					"Waiting up to 120s for the editor's debugger to attach on port 5005...",
				);
				// Well past runBuildTimeoutMs + simStartupTimeoutMs (40 ms).
				await Bun.sleep(150);
				expect(controlled.commands[0]?.killed).toBe(false);
				expect(app.storage.getRunJob(runId)).toMatchObject({
					state: "building",
				});
				expect(app.runs.activeBuildCount()).toBe(0);
				app.runs.stopWorkspace(workspace.id);
			},
			{
				dockerRunner: fakeDocker.runner,
				runCommandFactory: controlled.commandFactory,
				runBuildTimeoutMs: 20,
				simStartupTimeoutMs: 20,
				codeImage: "coderunner-workspace:test",
				simPortRange: { start: 25780, end: 25789 },
				vscodePortRange: { start: 33170, end: 33179 },
			},
		);
	});

	test("the run script passes the mode to start-sim", () => {
		expect(dockerRunScript("run")).toContain(
			"SIM_MODE=run /usr/local/bin/start-sim.sh",
		);
		expect(dockerRunScript("debug")).toContain(
			"SIM_MODE=debug /usr/local/bin/start-sim.sh",
		);
		expect(dockerRunScript("build")).toContain(
			"SIM_MODE=build /usr/local/bin/start-sim.sh",
		);
	});

	test("control-plane startup marks persisted active runs as stopped", async () => {
		const root = await mkdtemp(join(tmpdir(), "frc-v2-control-restart-"));
		const fakeDocker = createFakeDocker();
		const catalogDir = await createCatalogDir(root);
		const webDistDir = await createWebDist(root);
		const advantageScopeDistDir = await createAdvantageScopeDist(root);
		const dataDir = join(root, "data");
		const baseOptions: ControlAppOptions = {
			dataDir,
			catalogDir,
			webDistDir,
			advantageScopeDistDir,
			sessionSecret: "test-session-secret",
			baseUrl: "http://localhost:4000",
			containerAutoStart: false,
			dockerRunner: fakeDocker.runner,
			portAvailable: async () => true,
			codeImage: "coderunner-workspace:test",
			simPortRange: { start: 25850, end: 25859 },
			vscodePortRange: { start: 33050, end: 33059 },
			halsimPortRange: { start: 34050, end: 34059 },
		};

		let app = await createApp(baseOptions);
		try {
			const loginResponse = await login(app, "alice");
			const cookie = cookieFrom(loginResponse);
			const workspace = workspaceBySlug(app, "alice");
			const run = app.storage.createRunJob({
				id: "run_orphaned",
				workspaceId: workspace.id,
				logPath: join(root, "orphaned.log"),
			});
			app.storage.updateRunJob({ id: run.id, state: "running", started: true });
			app.close();

			app = await createApp(baseOptions);
			expect(app.storage.getRunJob(run.id)).toMatchObject({
				state: "stopped",
				exit_code: null,
			});
			expect(app.storage.getRunJob(run.id)?.finished_at).toBeTruthy();

			const response = await app.fetch(
				new Request("http://localhost/u/alice/api/sim/status", {
					headers: { cookie },
				}),
			);
			expect(response.status).toBe(200);
			expect(await response.json()).toMatchObject({
				run: { status: "stopped", runId: run.id },
			});
		} finally {
			app.close();
			await rm(root, { recursive: true, force: true });
		}
	});
});
