import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, type Page, test } from "@playwright/test";

const repoRoot = resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const dockerPath = process.env.FRC_DOCKER_PATH ?? "docker";
const image =
	process.env.CODE_IMAGE ??
	`${process.env.CODERUNNER_IMAGE_NS ?? "ghcr.io/mathewdunne"}/coderunner-workspace:${process.env.CODERUNNER_TAG ?? "latest"}`;
const javaReadyTimeout = 180_000;

interface DockerResult {
	exitCode: number;
	stdout: string;
	stderr: string;
}

interface WorkspaceContainer {
	name: string;
	root: string;
	url: string;
}

async function docker(
	args: string[],
	options: { allowFailure?: boolean; timeoutMs?: number } = {},
): Promise<DockerResult> {
	const subprocess = Bun.spawn([dockerPath, ...args], {
		cwd: repoRoot,
		stdout: "pipe",
		stderr: "pipe",
	});
	const timeout = setTimeout(
		() => subprocess.kill(),
		options.timeoutMs ?? 180_000,
	);
	const [exitCode, stdout, stderr] = await Promise.all([
		subprocess.exited,
		new Response(subprocess.stdout).text(),
		new Response(subprocess.stderr).text(),
	]);
	clearTimeout(timeout);
	if (exitCode !== 0 && !options.allowFailure) {
		throw new Error(
			`docker ${args.join(" ")} failed (${exitCode})\n${stdout}\n${stderr}`,
		);
	}
	return { exitCode, stdout, stderr };
}

async function waitFor<T>(
	label: string,
	read: () => Promise<T>,
	accept: (value: T) => boolean,
	timeoutMs = 120_000,
): Promise<T> {
	const deadline = Date.now() + timeoutMs;
	let lastValue: T;
	do {
		lastValue = await read();
		if (accept(lastValue)) return lastValue;
		await Bun.sleep(500);
	} while (Date.now() < deadline);
	throw new Error(
		`Timed out waiting for ${label}; last value: ${String(lastValue)}`,
	);
}

async function startWorkspace(
	moduleId: string,
	initialMachineSettings?: Record<string, unknown>,
): Promise<WorkspaceContainer> {
	const root = await mkdtemp(join(tmpdir(), `coderunner-${moduleId}-`));
	const project = join(root, "project");
	const config = join(root, "config");
	await mkdir(config);
	await cp(join(repoRoot, "catalog/modules", moduleId), project, {
		recursive: true,
	});
	await Promise.all([
		rm(join(project, "build"), { force: true, recursive: true }),
		rm(join(project, ".gradle"), { force: true, recursive: true }),
		rm(join(project, "src/main/java/frc/robot/BuildConstants.java"), {
			force: true,
		}),
	]);
	if (initialMachineSettings) {
		const machineSettingsDirectory = join(config, "data/Machine");
		await mkdir(machineSettingsDirectory, { recursive: true });
		await writeFile(
			join(machineSettingsDirectory, "settings.json"),
			`${JSON.stringify(initialMachineSettings)}\n`,
		);
	}

	const name = `coderunner-java-smoke-${moduleId}-${crypto.randomUUID().slice(0, 8)}`;
	try {
		await docker([
			"run",
			"--detach",
			"--name",
			name,
			"--memory",
			"4096m",
			"--env",
			`PUID=${process.getuid?.() ?? 1000}`,
			"--env",
			`PGID=${process.getgid?.() ?? 1000}`,
			"--publish",
			"127.0.0.1::3000",
			"--publish",
			"127.0.0.1::3300",
			"--volume",
			`${project}:/workspace/project`,
			"--volume",
			`${config}:/config`,
			image,
		]);

		const port = await waitFor(
			`${name} editor port`,
			async () => (await docker(["port", name, "3000/tcp"])).stdout.trim(),
			(value) => /^127\.0\.0\.1:\d+$/.test(value),
		);
		const url = `http://${port}/?folder=/workspace/project`;
		await waitFor(
			`${name} editor HTTP endpoint`,
			async () => {
				try {
					return (await fetch(url)).status;
				} catch {
					return 0;
				}
			},
			(status) => status >= 200 && status < 500,
		);
		return { name, root, url };
	} catch (error) {
		await docker(["rm", "--force", name], { allowFailure: true });
		await rm(root, { recursive: true });
		throw error;
	}
}

async function stopWorkspace(workspace: WorkspaceContainer | undefined) {
	if (!workspace) return;
	await docker(["rm", "--force", workspace.name], { allowFailure: true });
	await rm(workspace.root, { recursive: true });
}

async function openJavaFile(
	page: Page,
	workspace: WorkspaceContainer,
	path: string,
	waitForJavaReady = true,
	dismissWpilibHelp = false,
) {
	await page.goto(workspace.url, { waitUntil: "domcontentloaded" });
	await page.locator(".monaco-workbench").waitFor({ timeout: 120_000 });
	if (dismissWpilibHelp) {
		const helpTab = page.getByRole("tab", { name: /WPILib Help/ });
		await helpTab.waitFor({ timeout: 60_000 });
		await helpTab.getByRole("button", { name: /Close/ }).click();
	}
	await page.keyboard.press("Control+P");
	const quickOpen = page.locator(".quick-input-widget");
	await quickOpen.locator("input").fill(path);
	await quickOpen
		.locator(".monaco-list-row")
		.filter({ hasText: path.split("/").at(-1) ?? path })
		.first()
		.click({ timeout: 30_000 });
	await expect(page.locator(".tabs-container")).toContainText(
		path.split("/").at(-1) ?? path,
		{ timeout: 30_000 },
	);
	if (waitForJavaReady) {
		await expect(page.getByText("Java: Ready", { exact: false })).toBeVisible({
			timeout: javaReadyTimeout,
		});
	}
}

async function runCommand(page: Page, label: string) {
	await page.keyboard.press("Control+Shift+P");
	const palette = page.locator(".quick-input-widget");
	await palette.locator("input").fill(`>${label}`);
	await palette
		.locator(".monaco-list-row")
		.filter({ hasText: label })
		.first()
		.click({ timeout: 15_000 });
}

async function toolingLogs(name: string): Promise<string> {
	const serverLogs = await docker(["logs", name], { allowFailure: true });
	const fileLogs = await docker(
		[
			"exec",
			name,
			"bash",
			"-lc",
			"find /config/data/User/workspaceStorage -type f -path '*/redhat.java/*' -size -8M -print0 2>/dev/null | xargs -0 grep -I -h -E 'resolveMainMethod|delegateCommandHandler|Non-Static Commands|Duplicate bundle|duplicate.*bundle' 2>/dev/null || true",
		],
		{ allowFailure: true },
	);
	return `${serverLogs.stdout}\n${serverLogs.stderr}\n${fileLogs.stdout}\n${fileLogs.stderr}`;
}

async function waitForDebugHandler(name: string): Promise<string> {
	return waitFor(
		"Java Debug resolveMainMethod handler registration",
		() => toolingLogs(name),
		(logs) => /Non-Static Commands:[^\n]*resolveMainMethod/.test(logs),
		javaReadyTimeout,
	);
}

async function waitForJavaWorkspaceImport(name: string) {
	await waitFor(
		"JDT LS workspace import",
		async () =>
			(
				await docker(
					[
						"exec",
						name,
						"bash",
						"-lc",
						"log=$(find /config/data/User/workspaceStorage -type f -path '*/redhat.java/jdt_ws/.metadata/.log' -print -quit); test -n \"$log\" && grep -q 'Workspace initialized' \"$log\" && grep -q 'build jobs finished' \"$log\"",
					],
					{ allowFailure: true },
				)
			).exitCode,
		(exitCode) => exitCode === 0,
		javaReadyTimeout,
	);
}

async function wpilibBuildEvidence(name: string): Promise<string> {
	return (
		await docker(
			[
				"exec",
				name,
				"bash",
				"-lc",
				"cat /config/wpilib/2026/logs/wpilibtoollog.txt 2>/dev/null || true; find /config/.gradle/daemon -type f -name '*.out.log' -exec cat {} + 2>/dev/null || true; test -f /workspace/project/build/classes/java/main/frc/robot/Main.class && echo CODERUNNER_ROBOT_CLASS_PRESENT || true; pgrep -af '[o]rg.gradle.wrapper.GradleWrapperMain build' >/dev/null || echo CODERUNNER_WPILIB_BUILD_IDLE",
			],
			{ allowFailure: true },
		)
	).stdout;
}

async function waitForWpilibEditorBuild(name: string): Promise<string> {
	return waitFor(
		"WPILib editor Java 17 build",
		() => wpilibBuildEvidence(name),
		(evidence) =>
			/_commandLine.*\.\/gradlew build.*org\.gradle\.java\.home=\\?"\/usr\/lib\/jvm\/jdk-17\\?"/.test(
				evidence,
			) &&
			/javaHome=\/usr\/lib\/jvm\/jdk-17[^,]*/.test(evidence) &&
			evidence.includes("BUILD SUCCESSFUL") &&
			evidence.includes("CODERUNNER_ROBOT_CLASS_PRESENT") &&
			evidence.includes("CODERUNNER_WPILIB_BUILD_IDLE"),
		240_000,
	);
}

test.describe("real workspace Java tooling", () => {
	test.describe.configure({ mode: "serial" });

	test("runs plain Java and imports/builds/simulates a Java 17 robot", async ({
		page,
	}) => {
		test.setTimeout(600_000);
		await docker(["image", "inspect", image]);

		let helloWorkspace: WorkspaceContainer | undefined;
		let robotWorkspace: WorkspaceContainer | undefined;
		try {
			console.log("[java-smoke] starting hello-world workspace");
			helloWorkspace = await startWorkspace("hello-world");
			await openJavaFile(page, helloWorkspace, "src/Main.java");
			const jdtProcess = await docker([
				"exec",
				helloWorkspace.name,
				"bash",
				"-lc",
				"ps -eo args= | grep '[o]rg.eclipse.jdt.ls.core'",
			]);
			expect(jdtProcess.stdout).toMatch(
				/\/usr\/lib\/jvm\/jdk-21(?:[.0-9+_-]+)?\/bin\/java/,
			);
			expect(jdtProcess.stdout).not.toContain("/usr/lib/jvm/jdk-17");
			console.log("[java-smoke] Java ready; launching Run Main");
			await page.keyboard.press("F5");
			await waitFor(
				"hello-world compilation",
				async () =>
					(
						await docker(
							[
								"exec",
								helloWorkspace.name,
								"test",
								"-f",
								"/workspace/project/bin/Main.class",
							],
							{ allowFailure: true },
						)
					).exitCode,
				(exitCode) => exitCode === 0,
			);
			const terminal = page.getByRole("textbox", { name: /Terminal 1/ });
			await terminal.click();
			await runCommand(page, "Terminal: Accessible Buffer");
			await expect(
				page.getByText("Hello, World!", { exact: false }),
			).toBeVisible({
				timeout: 30_000,
			});
			await page.keyboard.press("Escape");

			const helloLogs = await waitForDebugHandler(helloWorkspace.name);
			expect(helloLogs).toMatch(/vscode\.java\.resolveMainMethod/);
			expect(helloLogs).not.toMatch(/No delegateCommandHandler/);

			await stopWorkspace(helloWorkspace);
			helloWorkspace = undefined;

			console.log("[java-smoke] starting robot-starter workspace");
			robotWorkspace = await startWorkspace("robot-starter", {
				"java.jdt.ls.java.home": "/usr/lib/jvm/jdk-21",
				"student.preserved.setting": true,
			});
			await openJavaFile(
				page,
				robotWorkspace,
				"src/main/java/frc/robot/Robot.java",
				false,
				true,
			);
			console.log("[java-smoke] robot source open; waiting for Gradle import");
			await waitForJavaWorkspaceImport(robotWorkspace.name);
			const migratedSettings = JSON.parse(
				(
					await docker([
						"exec",
						robotWorkspace.name,
						"cat",
						"/config/data/Machine/settings.json",
					])
				).stdout,
			);
			expect(migratedSettings["java.jdt.ls.java.home"]).toBeUndefined();
			expect(migratedSettings["student.preserved.setting"]).toBe(true);
			console.log(
				"[java-smoke] Gradle import complete; running WPILib: Build Robot Code",
			);
			await runCommand(page, "WPILib: Build Robot Code");
			const build = await waitForWpilibEditorBuild(robotWorkspace.name);
			expect(build).not.toContain(
				'-Dorg.gradle.java.home=\\"/usr/lib/jvm/jdk-21\\"',
			);
			expect(build).not.toContain("BUILD FAILED");
			expect(build).not.toMatch(/google-java-format.*found problem/i);
			expect(build).not.toContain("NoSuchMethodError");
			console.log(
				"[java-smoke] WPILib editor build succeeded on Java 17; starting simulation",
			);

			const classVersion = await docker([
				"exec",
				robotWorkspace.name,
				"bash",
				"-lc",
				"/usr/lib/jvm/jdk-17/bin/javap -verbose /workspace/project/build/classes/java/main/frc/robot/Main.class | grep 'major version'",
			]);
			expect(classVersion.stdout).toContain("major version: 61");

			await docker([
				"exec",
				"--user",
				"abc",
				"--env",
				"HOME=/config",
				robotWorkspace.name,
				"/usr/local/bin/start-sim.sh",
			]);
			const simulationLog = await waitFor(
				"robot simulation startup",
				async () =>
					(
						await docker(
							["exec", robotWorkspace.name, "cat", "/config/sim.log"],
							{ allowFailure: true },
						)
					).stdout,
				(log) => /HALSim|NT4|NetworkTables/i.test(log),
				180_000,
			);
			expect(simulationLog).toContain("BUILD SUCCESSFUL");
			console.log("[java-smoke] simulation started; stopping it");
			await docker([
				"exec",
				"--user",
				"abc",
				"--env",
				"HOME=/config",
				robotWorkspace.name,
				"/usr/local/bin/stop-sim.sh",
			]);

			console.log(
				"[java-smoke] starting a Debug run; coderunner-debug should attach",
			);
			await docker([
				"exec",
				"--user",
				"abc",
				"--env",
				"HOME=/config",
				"--env",
				"SIM_MODE=debug",
				robotWorkspace.name,
				"/usr/local/bin/start-sim.sh",
			]);
			// suspend=y: robot code only runs once the debugger has attached.
			const debugLog = await waitFor(
				"debugger attach and robot startup",
				async () =>
					(
						await docker(
							["exec", robotWorkspace.name, "cat", "/config/sim.log"],
							{ allowFailure: true },
						)
					).stdout,
				(log) => /Robot program startup complete/.test(log),
				180_000,
			);
			expect(debugLog).toContain(
				"Waiting up to 120s for the editor's debugger to attach on port 5005...",
			);
			expect(debugLog).not.toMatch(/ERROR: JDWP|transport error/);
			await expect(page.locator(".debug-toolbar")).toBeVisible();
			await docker([
				"exec",
				"--user",
				"abc",
				"--env",
				"HOME=/config",
				robotWorkspace.name,
				"/usr/local/bin/stop-sim.sh",
			]);

			const robotLogs = await toolingLogs(robotWorkspace.name);
			expect(robotLogs).not.toMatch(/No delegateCommandHandler/);
		} finally {
			await stopWorkspace(helloWorkspace);
			await stopWorkspace(robotWorkspace);
		}
	});
});
