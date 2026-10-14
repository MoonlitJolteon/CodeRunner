# Sim Debugging and Run Modes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add **Debug** and **Build** run modes behind a split Start button. A Debug run's robot JVM waits for VSCodium's Java debugger, which a bundled CodeRunner extension attaches automatically.

**Architecture:** The web shell sends `mode` on `POST /api/sim/run`. `RunManager` stores it per run and passes `SIM_MODE` to `start-sim.sh` → `run-sim.sh`.
- In debug mode, `run-sim.sh` adds a JDWP agent on `127.0.0.1:5005` (`suspend=y`, 120 s attach timeout) and writes `$HOME/sim-debug.json` before `exec java`.
- A small workspace-side VS Code extension (`containers/code/coderunner-debug`) polls for that file, claims the run (one editor tab wins), and calls `vscode.debug.startDebugging` with a Java `attach` config.
- Build mode runs `./gradlew build` and exits.
- The debug toolbar's Stop just disconnects (VS Code's default for attach sessions); the sim is stopped with CodeRunner's Stop. *(Stopping the sim from the debugger was dropped after review: the sim runs as root and VSCodium as abc, so it needed a root-side relay that could race with Restart.)*

**Tech Stack:** Bun + TypeScript (control plane, contracts, tests), React + Vitest + Base UI menu (web), Bash (container scripts), VS Code extension API with esbuild + `@vscode/vsce` in a Docker build stage, Playwright (E2E).

**Spec:** `docs/superpowers/specs/2026-10-14-sim-debugging-design.md`

## Global Constraints

- JDWP agent string, verbatim: `-agentlib:jdwp=transport=dt_socket,server=y,suspend=y,address=127.0.0.1:5005,timeout=120000,quiet=y`. Never bind `0.0.0.0` or a bare port.
- Start (`mode: "run"`) must produce exactly today's Gradle task (`simulateExternalJavaRelease`) and the same robot JVM args (no agent, no marker file).
- No changes to student project files (`.vscode/launch.json`, `build.gradle`, …).
- Debug session name, verbatim: `Debug Simulation`.
- Console line, verbatim: `Waiting up to 120s for the editor's debugger to attach on port 5005...`
- Mode values, verbatim: `"run" | "debug" | "build"`; omitted means `"run"` (except `restart`, which reuses the last mode).
- File names under `$HOME` (`/config` in the image): `sim-debug.json`, `sim-debug.<pid>.claim`.
- Bump `containers/code/coderunner-debug/package.json` `version` (and the Dockerfile `CODERUNNER_DEBUG_VERSION` ARG) on every extension change. `reconcile-frc-extensions` only updates existing workspaces when `id@version` changes.
- Run `bun run check:fix` before every commit (Biome format + lint + import order).
- End every commit message with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. **Build output that mentions NetworkTables.** Gradle logs during a Build (dependency downloads like `networktables`, test output with `NT4`) must not flip the run to **running**. That is the readiness regex in `runs.ts`. Test in Task 3.
2. **A click event leaking in as the mode.** `SimButton`'s `onClick` passes a React event. If Start were wired as `onClick={onStart}` with `onStart(mode?)`, the event would be sent as `mode` and the request would 400. Test in Task 4 asserts `onStart` is called with exactly `"run"`.
3. **Two editor tabs open.** Each tab has its own extension host. Exactly one may claim a sim pid, and the loser must never attach or request a stop. Test in Task 6.
4. **A debug run paused at a startup breakpoint.** A breakpoint in `Main.java` or a static initializer pauses the JVM before the NT4 readiness line. The normal run/startup timeout must not kill an attached, paused JVM. In debug mode, the readiness timer is cancelled once the JVM prints the "Waiting up to 120s…" line; the JDWP `timeout` covers the attach wait. Test in Task 3.
5. **Gradle fails silently in Build mode.** If Gradle is killed or OOMs without printing `BUILD FAILED`, the run must still end **failed**, not **stopped**: `run-sim.sh` prints its own `BUILD FAILED` line on any non-zero Gradle exit. Test in Task 2.

---

## File Structure

| File | Responsibility |
|---|---|
| `packages/contracts/src/index.ts` | `simRunModeSchema`, `SimRunMode`, optional `mode` on `simRunCommandRequestSchema` |
| `containers/code/start-sim.sh` | Pass `SIM_MODE` to `run-sim.sh` |
| `containers/code/run-sim.sh` | Per-mode Gradle task; JDWP agent + marker in debug |
| `containers/code/stop-sim.sh` | Remove marker/claim/stop-request files; match Build's Gradle in the fallback |
| `containers/code/sim-scripts.test.ts` | Script behaviour per mode |
| `apps/control/src/runs.ts` | Mode on jobs, `SIM_MODE` in the run script, build terminal state/timeout, `lastMode()`, debug readiness-timer handling |
| `apps/control/src/app/workspace-routes.ts` | Resolve `mode` for `start`/`restart` |
| `apps/web/src/hooks/useSimulationState.ts` | `startRun(mode?)` |
| `apps/web/src/components/DriverStation/SimControlsBlock.tsx` | Split Start button + menu |
| `apps/web/src/components/DriverStation/{WorkbenchPanel,DriverStation}.tsx` | Prop type `onStartRun(mode)` |
| `containers/code/coderunner-debug/` (new) | VS Code extension: `src/debug-marker.ts` (pure, tested), `src/extension.ts` (wiring), manifest, build files |
| `containers/code/Dockerfile` | Build stage + install of the extension |
| `e2e/specs/run/run-modes.spec.ts` (new) | Menu sends the right request |
| `e2e/specs/smoke-docker/java-tooling.spec.ts` | Real-image debug attach check |
| `docs/using-coderunner.md`, `docs/decisions/045-sim-debugging.md`, `AGENTS.md` | Docs |

---

### Task 1: Contract — run modes

**Files:**
- Modify: `packages/contracts/src/index.ts:161` (next to `simRunCommandSchema`), `:177-179` (`simRunCommandRequestSchema`), and the type exports near `:309`
- Modify: `apps/web/src/lib/contracts.ts` (type re-export list, near `SimRunStatus` at line 24)
- Test: `packages/contracts/src/index.test.ts`

**Interfaces:**
- Produces: `simRunModeSchema = z.enum(["run", "debug", "build"])`, `type SimRunMode`, `simRunCommandRequestSchema` = `{ action: SimRunCommand; mode?: SimRunMode }`. Web code imports `SimRunMode` from `@/lib/contracts`.

- [ ] **Step 1: Write the failing test**

Add `simRunCommandRequestSchema` to the import list at the top of `packages/contracts/src/index.test.ts`, then append:

```ts
describe("sim run command request", () => {
	test("accepts each run mode and leaves mode out when omitted", () => {
		for (const mode of ["run", "debug", "build"] as const) {
			expect(
				simRunCommandRequestSchema.parse({ action: "start", mode }),
			).toEqual({ action: "start", mode });
		}
		expect(simRunCommandRequestSchema.parse({ action: "restart" })).toEqual({
			action: "restart",
		});
	});

	test("rejects unknown modes", () => {
		expect(() =>
			simRunCommandRequestSchema.parse({ action: "start", mode: "profile" }),
		).toThrow();
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/contracts/src/index.test.ts`
Expected: FAIL. `mode` is stripped by the current schema (first test), and `"profile"` is accepted (second test).

- [ ] **Step 3: Implement**

In `packages/contracts/src/index.ts`, after `export const simRunCommandSchema = ...`:

```ts
export const simRunModeSchema = z.enum(["run", "debug", "build"]);
```

Replace `simRunCommandRequestSchema`:

```ts
export const simRunCommandRequestSchema = z.object({
	action: simRunCommandSchema,
	mode: simRunModeSchema.optional(),
});
```

Next to `export type SimRunCommand = ...`:

```ts
export type SimRunMode = z.infer<typeof simRunModeSchema>;
```

In `apps/web/src/lib/contracts.ts`, add `SimRunMode,` to the `export type { ... }` list (alphabetical, next to `SimRunStatus`).

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/contracts && bun run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
bun run check:fix
git add packages/contracts/src/index.ts packages/contracts/src/index.test.ts apps/web/src/lib/contracts.ts
git commit -m "feat(contracts): add run/debug/build sim run modes (#27)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Container scripts — per-mode Gradle task, JDWP agent, marker cleanup

**Files:**
- Modify: `containers/code/start-sim.sh` (the `setsid "$RUN_SIM_SCRIPT"` call)
- Modify: `containers/code/run-sim.sh` (argument parsing, Gradle call, before `exec java`)
- Modify: `containers/code/stop-sim.sh` (`sim_candidate_pids` case, every `rm -f "$pid_file"`)
- Modify: `package.json` (`"test"` script)
- Test: `containers/code/sim-scripts.test.ts`

**Interfaces:**
- Consumes: `SIM_MODE` env (`run` | `debug` | `build`, default `run`) on `start-sim.sh`, set by Task 3.
- Produces: `run-sim.sh` 7th positional arg `<mode>`. In debug it writes `$HOME/sim-debug.json` = `{"port":5005,"pid":<jvm pid>}`. `stop-sim.sh` removes `$HOME/sim-debug.json` and `$HOME/sim-debug.*.claim`. Task 6 relies on these names.

- [ ] **Step 1: Write the failing tests**

Append a helper and four tests inside the existing `describe("sim container scripts", ...)` in `containers/code/sim-scripts.test.ts`:

```ts
	async function createRunSimFixture(gradlewBody: string[]) {
		const root = await mkdtemp(join(tmpdir(), "frc-run-sim-"));
		const home = join(root, "home");
		const projectRoot = join(root, "project");
		const binDir = join(root, "bin");
		const libDir = join(root, "lib");
		await mkdir(home, { recursive: true });
		await mkdir(projectRoot, { recursive: true });
		await mkdir(binDir, { recursive: true });
		await mkdir(libDir, { recursive: true });
		await writeFile(
			join(projectRoot, "gradlew"),
			["#!/usr/bin/env bash", ...gradlewBody].join("\n"),
			"utf8",
		);
		await chmod(join(projectRoot, "gradlew"), 0o755);
		// Fake `java`: records its args. run-sim.sh exec's it, so it keeps the script's pid.
		await writeFile(
			join(binDir, "java"),
			[
				"#!/usr/bin/env bash",
				'printf "%s\\n" "$@" > "$JAVA_ARGS_FILE"',
				'printf "%s\\n" "$$" > "$JAVA_PID_FILE"',
			].join("\n"),
			"utf8",
		);
		await chmod(join(binDir, "java"), 0o755);

		async function run(mode: string | null) {
			const args = [
				"bash",
				join(import.meta.dir, "run-sim.sh"),
				projectRoot,
				join(home, ".gradle-project-sim"),
				"2",
				"-Xmx64m",
				"-Xmx32m",
				join(root, "missing.init.gradle"),
			];
			if (mode !== null) args.push(mode);
			const proc = Bun.spawn(args, {
				env: {
					...Bun.env,
					HOME: home,
					PATH: `${binDir}:${Bun.env.PATH}`,
					JAVA_ARGS_FILE: join(root, "java.args"),
					JAVA_PID_FILE: join(root, "java.pid"),
				},
				stdin: "ignore",
				stdout: "pipe",
				stderr: "pipe",
			});
			const [exitCode, stdout, stderr] = await Promise.all([
				proc.exited,
				new Response(proc.stdout).text(),
				new Response(proc.stderr).text(),
			]);
			return { exitCode, stdout, stderr, pid: proc.pid };
		}

		return { root, home, projectRoot, libDir, run };
	}

	// gradlew that records its task and produces a runnable sim descriptor + jar.
	const simulatingGradlew = [
		'printf "%s\\n" "${@: -1}" > "$PWD/gradle.task"',
		"mkdir -p build/sim build/libs",
		'printf \'[{"libraryDir":"%s","extensions":[]}]\' "$PWD/../lib" > build/sim/release_java.json',
		": > build/libs/robot.jar",
	];

	test("run-sim run mode starts the robot without a debug agent or marker", async () => {
		const fixture = await createRunSimFixture(simulatingGradlew);
		try {
			const result = await fixture.run(null);
			expect(result.exitCode).toBe(0);
			expect(
				(await readFile(join(fixture.projectRoot, "gradle.task"), "utf8")).trim(),
			).toBe("simulateExternalJavaRelease");
			const javaArgs = await readFile(join(fixture.root, "java.args"), "utf8");
			expect(javaArgs).not.toContain("jdwp");
			expect(javaArgs).toContain("-jar");
			expect(
				await readFile(join(fixture.home, "sim-debug.json"), "utf8").catch(
					() => null,
				),
			).toBeNull();
		} finally {
			await rm(fixture.root, { recursive: true, force: true });
		}
	});

	test("run-sim debug mode adds a loopback JDWP agent and writes the marker with the JVM pid", async () => {
		const fixture = await createRunSimFixture(simulatingGradlew);
		try {
			const result = await fixture.run("debug");
			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain(
				"Waiting up to 120s for the editor's debugger to attach on port 5005...",
			);
			const javaArgs = (
				await readFile(join(fixture.root, "java.args"), "utf8")
			).split("\n");
			const agent =
				"-agentlib:jdwp=transport=dt_socket,server=y,suspend=y,address=127.0.0.1:5005,timeout=120000";
			expect(javaArgs).toContain(agent);
			expect(javaArgs.indexOf(agent)).toBeLessThan(javaArgs.indexOf("-jar"));
			const javaPid = Number(
				(await readFile(join(fixture.root, "java.pid"), "utf8")).trim(),
			);
			expect(javaPid).toBe(result.pid);
			expect(
				JSON.parse(await readFile(join(fixture.home, "sim-debug.json"), "utf8")),
			).toEqual({ port: 5005, pid: javaPid });
		} finally {
			await rm(fixture.root, { recursive: true, force: true });
		}
	});

	test("run-sim build mode runs gradle build and starts no JVM", async () => {
		const fixture = await createRunSimFixture([
			'printf "%s\\n" "${@: -1}" > "$PWD/gradle.task"',
		]);
		try {
			const result = await fixture.run("build");
			expect(result.exitCode).toBe(0);
			expect(
				(await readFile(join(fixture.projectRoot, "gradle.task"), "utf8")).trim(),
			).toBe("build");
			expect(
				await readFile(join(fixture.root, "java.args"), "utf8").catch(
					() => null,
				),
			).toBeNull();
		} finally {
			await rm(fixture.root, { recursive: true, force: true });
		}
	});

	test("run-sim reports BUILD FAILED when gradle exits non-zero without saying so", async () => {
		const fixture = await createRunSimFixture(["exit 3"]);
		try {
			const result = await fixture.run("build");
			expect(result.exitCode).toBe(3);
			expect(result.stderr).toContain("BUILD FAILED");
		} finally {
			await rm(fixture.root, { recursive: true, force: true });
		}
	});

	test("run-sim rejects an unknown mode", async () => {
		const fixture = await createRunSimFixture(simulatingGradlew);
		try {
			const result = await fixture.run("profile");
			expect(result.exitCode).toBe(64);
		} finally {
			await rm(fixture.root, { recursive: true, force: true });
		}
	});

	test("stop-sim removes the debug marker and claims", async () => {
		const root = await mkdtemp(join(tmpdir(), "frc-sim-debug-files-"));
		const home = join(root, "home");
		await mkdir(home, { recursive: true });
		for (const name of ["sim-debug.json", "sim-debug.4242.claim"]) {
			await writeFile(join(home, name), "x", "utf8");
		}
		try {
			const stop = Bun.spawn(["bash", join(import.meta.dir, "stop-sim.sh")], {
				env: {
					...Bun.env,
					HOME: home,
					SIM_PID_FILE: join(home, "sim.pid"),
					SIM_PROJECT_ROOT: join(root, "project"),
				},
				stdin: "ignore",
				stdout: "ignore",
				stderr: "ignore",
			});
			expect(await stop.exited).toBe(0);
			for (const name of ["sim-debug.json", "sim-debug.4242.claim"]) {
				expect(
					await readFile(join(home, name), "utf8").catch(() => null),
				).toBeNull();
			}
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	test("stop-sim cleans an orphaned Build gradle process without a pid file", async () => {
		const root = await mkdtemp(join(tmpdir(), "frc-sim-build-orphan-"));
		const home = join(root, "home");
		await mkdir(home, { recursive: true });
		const fakeArgs = `java -cp gradle-wrapper.jar org.gradle.wrapper.GradleWrapperMain --no-daemon --project-cache-dir ${home}/.gradle-project-sim build`;
		const sleeper = Bun.spawn(
			["bash", "-lc", 'exec -a "$FAKE_ARGS" sleep 60'],
			{
				env: { ...Bun.env, FAKE_ARGS: fakeArgs },
				stdin: "ignore",
				stdout: "ignore",
				stderr: "ignore",
			},
		);
		try {
			await waitFor(() => processArgs(sleeper.pid).includes("GradleWrapperMain"));
			const stop = Bun.spawn(["bash", join(import.meta.dir, "stop-sim.sh")], {
				env: {
					...Bun.env,
					HOME: home,
					SIM_PID_FILE: join(home, "sim.pid"),
					SIM_PROJECT_ROOT: join(root, "project"),
				},
				stdin: "ignore",
				stdout: "pipe",
				stderr: "ignore",
			});
			expect(await stop.exited).toBe(0);
			const sleeperExit = await Promise.race([
				sleeper.exited,
				new Promise<null>((resolve) => setTimeout(() => resolve(null), 5_000)),
			]);
			expect(sleeperExit).not.toBeNull();
		} finally {
			try {
				sleeper.kill("SIGKILL");
			} catch {
				// Already stopped by the script.
			}
			await rm(root, { recursive: true, force: true });
		}
	});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test containers/code/sim-scripts.test.ts`
Expected:
- The two original tests PASS.
- These new tests FAIL: debug (no agent), build (task is `simulateExternalJavaRelease`), BUILD FAILED (no message), unknown mode (exit 0), stop-sim file cleanup, and build-orphan (not matched).
- The run-mode test may already pass.

- [ ] **Step 3: Implement `run-sim.sh`**

Change the usage check and argument parsing at the top:

```bash
if [[ "$#" -lt 6 ]]; then
  echo "Usage: $0 <project_root> <gradle_cache_dir> <max_workers> <gradle_jvmargs> <robot_jvmargs> <init_script> [run|debug|build]" >&2
  exit 64
fi

project_root="$1"
gradle_cache="$2"
gradle_max_workers="$3"
gradle_jvmargs="$4"
robot_jvmargs="$5"
init_script="$6"
sim_mode="${7:-run}"

case "$sim_mode" in
  run|debug|build) ;;
  *)
    echo "Unknown sim mode: $sim_mode" >&2
    exit 64
    ;;
esac

debug_port=5005
debug_marker="$HOME/sim-debug.json"
```

Replace the `./gradlew ... simulateExternalJavaRelease` invocation with:

```bash
gradle_task="simulateExternalJavaRelease"
if [[ "$sim_mode" == "build" ]]; then
  gradle_task="build"
fi

# Gradle normally prints BUILD FAILED itself; say it explicitly so a killed or
# OOM'd Gradle still fails the run (the control plane greps for it).
./gradlew \
  --no-daemon \
  --no-watch-fs \
  "--max-workers=$gradle_max_workers" \
  --console=plain \
  --project-cache-dir "$gradle_cache" \
  "-Dorg.gradle.jvmargs=$gradle_jvmargs" \
  "${init_args[@]}" \
  "$gradle_task" || {
  gradle_status=$?
  echo "BUILD FAILED: Gradle exited with code $gradle_status" >&2
  exit "$gradle_status"
}

if [[ "$sim_mode" == "build" ]]; then
  exit 0
fi
```

Immediately before the final `exec java ...` line, add:

```bash
if [[ "$sim_mode" == "debug" ]]; then
  # Loopback only: in network mode workspaces share a Docker network, and an
  # attached debugger can run arbitrary code in this JVM.
  java_args+=("-agentlib:jdwp=transport=dt_socket,server=y,suspend=y,address=127.0.0.1:${debug_port},timeout=120000")
  echo "Waiting up to 120s for the editor's debugger to attach on port ${debug_port}..."
  # $$ survives exec, so this is the robot JVM's pid (and sim.pid's).
  printf '{"port":%s,"pid":%s}\n' "$debug_port" "$$" >"$debug_marker"
fi
```

Also add one line to the header comment block: `# Modes (7th arg): run (default), debug (JDWP agent + $HOME/sim-debug.json), build (gradle build only). See docs/decisions/045-sim-debugging.md.`

- [ ] **Step 4: Implement `start-sim.sh`**

Add `"${SIM_MODE:-run}"` as the last argument of the `setsid "$RUN_SIM_SCRIPT"` call (after `"$INIT_SCRIPT" \`):

```bash
setsid "$RUN_SIM_SCRIPT" \
  "$project_root" \
  "$GRADLE_PROJECT_CACHE_DIR" \
  "$GRADLE_MAX_WORKERS" \
  "$GRADLE_SIM_JVMARGS" \
  "$ROBOT_SIM_JVMARGS" \
  "$INIT_SCRIPT" \
  "${SIM_MODE:-run}" \
  >"$log_file" 2>&1 &
```

(`start-sim.sh` already calls `stop-sim.sh` first, which clears the debug files.)

- [ ] **Step 5: Implement `stop-sim.sh`**

After the `project_root=` line, add:

```bash
# Debug-run handshake files (see run-sim.sh and the coderunner-debug extension).
clear_sim_files() {
  rm -f "$pid_file" "$HOME/sim-debug.json" "$HOME"/sim-debug.*.claim
}
```

Replace all three occurrences of `rm -f "$pid_file"` with `clear_sim_files`.

In `sim_candidate_pids`, extend the `case`:

```bash
    case "$args" in
      *"org.gradle.wrapper.GradleWrapperMain"*simulate*|*"org.gradle.wrapper.GradleWrapperMain"*".gradle-project-sim"*|*"$project_root/build/libs/"*.jar*)
        echo "$pid"
        ;;
    esac
```

(Only `run-sim.sh` passes `--project-cache-dir …/.gradle-project-sim`, so this matches its Build-mode Gradle but never a student's own `./gradlew build` in the terminal. Don't anchor the pattern on a trailing ` build`: `ps` appends the real argv after `exec -a`, e.g. the test's `sleep 60` shows as `… build 60`.)

- [ ] **Step 6: Run tests to verify they pass**

Run: `bun test containers/code/sim-scripts.test.ts`
Expected: all PASS.

- [ ] **Step 7: Run the script tests in CI**

These script tests are not currently part of `bun run test`. In `package.json`, change the `"test"` script to include `containers/code`:

```json
"test": "bun test apps/control packages scripts containers/code apps/web/src/lib/keyboard-mapping.test.ts apps/web/src/lib/keyboard-mapping.property.test.ts",
```

Run: `bun run test`
Expected: PASS (control-plane suite plus `containers/code`).

- [ ] **Step 8: Commit**

```bash
bun run check:fix
git add containers/code/run-sim.sh containers/code/start-sim.sh containers/code/stop-sim.sh containers/code/sim-scripts.test.ts package.json
git commit -m "feat(sim): debug and build modes in the container sim scripts (#27)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Control plane — mode on runs, build terminal state, route

**Files:**
- Modify: `apps/control/src/runs.ts` (imports; `RunCommandContext` :23-31; `RunJob` :41-55; `dockerRunScript` :83-97; `defaultRunCommandFactory` :99-107; `RunManager` fields :148-155; `start` :260-307; exit handling :411-421; commandFactory call :378-384; `armReadinessTimeout`/`timeoutBeforeReadiness` :447-477; readiness in `recordLog` :498-503)
- Modify: `apps/control/src/app/workspace-routes.ts:371-385`
- Test: `apps/control/src/__tests__/runs.test.ts`, `apps/control/src/__tests__/sim-api.test.ts`

**Interfaces:**
- Consumes: `SimRunMode`, `simRunCommandRequestSchema` with optional `mode` (Task 1). `SIM_MODE` contract of `start-sim.sh` (Task 2).
- Produces:
  - `RunCommandContext.mode: SimRunMode`
  - `export function dockerRunScript(mode: SimRunMode): string`
  - `RunManager.start(workspace: WorkspaceRow, connection?: RunConnection | null, mode?: SimRunMode): string` (default `"run"`)
  - `RunManager.lastMode(workspaceId: WorkspaceId): SimRunMode`


- [ ] **Step 1: Write failing `runs.test.ts` tests**

Change the import `import type { RunCommandFactory } from "../runs";` to `import { dockerRunScript, type RunCommandFactory } from "../runs";`. Then add inside `describe("run lifecycle and log streaming", ...)`:

```ts
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
```

> Port ranges above were picked from blocks unused at plan time. If `withApp` reports a collision, list the used ones with `grep -rhoE "start: (2[5-6]|3[3-4])[0-9]{3}" apps/control/src/__tests__ e2e | sort -u` and pick a free 10-port block.

- [ ] **Step 2: Write failing `sim-api.test.ts` test**

Add inside `describe("simulation HTTP API", ...)`:

```ts
	test("HTTP run start honours mode, restart reuses it, and bad modes are rejected", async () => {
		const fakeDocker = createFakeDocker();
		const controlled = createControlledRunCommands();
		const modes: string[] = [];
		const recordingFactory: RunCommandFactory = (context) => {
			modes.push(context.mode);
			return controlled.commandFactory(context);
		};
		await withApp(
			async (app) => {
				const cookie = cookieFrom(await login(app, "alice"));
				const workspace = workspaceBySlug(app, "alice");
				const post = (body: unknown) =>
					app.fetch(
						new Request("http://localhost/u/alice/api/sim/run", {
							method: "POST",
							headers: { cookie, "content-type": "application/json" },
							body: JSON.stringify(body),
						}),
					);

				expect((await post({ action: "start", mode: "debug" })).status).toBe(202);
				await waitFor(() => modes.length === 1);
				expect((await post({ action: "restart" })).status).toBe(202);
				await waitFor(() => modes.length === 2);
				expect((await post({ action: "start" })).status).toBe(202);
				await waitFor(() => modes.length === 3);
				expect(modes).toEqual(["debug", "debug", "run"]);

				expect((await post({ action: "start", mode: "profile" })).status).toBe(400);
				app.runs.stopWorkspace(workspace.id);
			},
			{
				dockerRunner: fakeDocker.runner,
				runCommandFactory: recordingFactory,
				codeImage: "coderunner-workspace:test",
				simPortRange: { start: 26090, end: 26099 },
				vscodePortRange: { start: 33390, end: 33399 },
				halsimPortRange: { start: 34390, end: 34399 },
			},
		);
	});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `bun test apps/control/src/__tests__/runs.test.ts apps/control/src/__tests__/sim-api.test.ts`
Expected: new tests FAIL. Typecheck errors are also expected (`lastMode`, `context.mode`, `dockerRunScript` export don't exist yet), and Bun may run anyway.

- [ ] **Step 4: Implement in `runs.ts`**

1. Imports:

```ts
import type {
	RunServerMessage,
	SimRunMode,
	SimRunStatus,
	WorkspaceId,
} from "@frc-coderunner/contracts";
```

2. `RunCommandContext`: add `mode: SimRunMode;` after `runtimeProvider: WorkspaceRuntimeProvider;`.

3. `RunJob`: add `mode: SimRunMode;` after `workspace: WorkspaceRow;`.

4. Replace `dockerRunScript` and the factory:

```ts
export function dockerRunScript(mode: SimRunMode): string {
	return [
		"set -euo pipefail",
		// biome-ignore lint/suspicious/noTemplateCurlyInString: shell parameter expansion, not JS template literal
		'log_file="${SIM_LOG_FILE:-$HOME/sim.log}"',
		// biome-ignore lint/suspicious/noTemplateCurlyInString: shell parameter expansion, not JS template literal
		'pid_file="${SIM_PID_FILE:-$HOME/sim.pid}"',
		"trap '/usr/local/bin/stop-sim.sh >/dev/null 2>&1 || true' TERM INT",
		"/usr/local/bin/stop-sim.sh || true",
		// `mode` is a validated SimRunMode literal, safe to interpolate.
		`SIM_MODE=${mode} /usr/local/bin/start-sim.sh`,
		'pid="$(cat "$pid_file")"',
		'tail --pid="$pid" -n +1 -F "$log_file"',
		'if grep -q "BUILD FAILED" "$log_file" 2>/dev/null; then exit 1; fi',
	].join("\n");
}

export function defaultRunCommandFactory(
	context: RunCommandContext,
): RunCommand {
	return context.runtimeProvider.execStream(context.workspace.id, [
		"bash",
		"-lc",
		dockerRunScript(context.mode),
	]);
}
```

5. `RunManager` field, after `lastStatusByWorkspace`:

```ts
	private readonly lastModeByWorkspace = new Map<WorkspaceId, SimRunMode>();
```

and a method, after `activeBuildCount()`:

```ts
	/** Mode of the current or most recent run, used by `restart` with no mode. */
	lastMode(workspaceId: WorkspaceId): SimRunMode {
		return this.lastModeByWorkspace.get(workspaceId) ?? "run";
	}
```

6. `start`: change the signature to `start(workspace: WorkspaceRow, connection?: RunConnection | null, mode: SimRunMode = "run"): string`. Add `mode,` to the `job` literal (after `workspace,`). After `this.jobsByWorkspace.set(workspace.id, job);` add `this.lastModeByWorkspace.set(workspace.id, mode);`. Add `mode,` to the `log.info("run queued", {...})` fields.

7. In `runJob`, add `mode: job.mode,` to the `this.commandFactory({ ... })` argument (after `runtimeProvider: this.runtimeProvider,`).

8. Exit 0 branch: replace `const status = job.reportedRunning ? "stopped" : "failed";` with

```ts
				// A build never reports running; a clean exit is its success.
				const status =
					job.reportedRunning || job.mode === "build" ? "stopped" : "failed";
```

9. Timeouts:

```ts
	private armReadinessTimeout(job: RunJob): void {
		const timeoutMs =
			job.mode === "build"
				? this.storage.config.runBuildTimeoutMs
				: this.storage.config.runBuildTimeoutMs +
					this.storage.config.simStartupTimeoutMs;
		job.readinessTimer = setTimeout(() => {
			void this.timeoutBeforeReadiness(job, timeoutMs);
		}, timeoutMs);
	}
```

In `timeoutBeforeReadiness`, replace the `recordLog` message argument with

```ts
			job.mode === "build"
				? `Build timed out after ${Math.round(timeoutMs / 1000)} seconds.`
				: `Run timed out before simulator readiness after ${Math.round(timeoutMs / 1000)} seconds.`,
```

10. In `recordLog`, add `job.mode !== "build" &&` as the first readiness condition:

```ts
		if (
			job.mode !== "build" &&
			!job.finished &&
			!job.canceled &&
			!job.reportedRunning &&
			lineLooksReady(line)
		) {
```

11. Debug runs: once the JVM is up and waiting for the debugger, cancel the build/startup deadline (and free the build slot). A student paused at a breakpoint before the NT4 readiness line must not be failed; the JDWP `timeout` in `run-sim.sh` covers the attach wait. Add near the top of the file:

```ts
/** Printed by run-sim.sh in debug mode right before exec'ing the robot JVM. */
const DEBUG_WAITING_LINE = "for the editor's debugger to attach";
```

and in `recordLog`, directly before the readiness `if`:

```ts
		if (
			job.mode === "debug" &&
			!job.finished &&
			job.buildSlotHeld &&
			line.includes(DEBUG_WAITING_LINE)
		) {
			// The build is done and the JVM is waiting for (or paused in) the
			// debugger: no deadline from here on.
			this.releaseBuildSlot(job);
		}
```

(`releaseBuildSlot` already clears `readinessTimer`.)

- [ ] **Step 5: Implement the route**

In `apps/control/src/app/workspace-routes.ts`, inside the `/api/sim/run` handler's `else` branch, replace `runId = runs.start(auth.workspace);` with:

```ts
				const mode =
					parsed.mode ??
					(parsed.action === "restart"
						? runs.lastMode(auth.workspace.id)
						: "run");
				runId = runs.start(auth.workspace, null, mode);
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `bun test apps/control && bun run typecheck`
Expected: PASS. If typecheck flags other `RunCommandFactory` call sites that build a `RunCommandContext` by hand (for example `e2e` helpers), add `mode: "run"` there.

- [ ] **Step 7: Commit**

```bash
bun run check:fix
git add apps/control/src/runs.ts apps/control/src/app/workspace-routes.ts apps/control/src/__tests__/runs.test.ts apps/control/src/__tests__/sim-api.test.ts
git commit -m "feat(control): run modes on sim runs; build ends stopped; restart reuses mode (#27)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Web — split Start button with Debug and Build

**Files:**
- Modify: `apps/web/src/hooks/useSimulationState.ts`
- Modify: `apps/web/src/components/DriverStation/SimControlsBlock.tsx`
- Modify: `apps/web/src/components/DriverStation/WorkbenchPanel.tsx:21` (prop type) and its `import type {...} from "@/lib/contracts"`
- Modify: `apps/web/src/components/DriverStation/DriverStation.tsx:52` (prop type) and its contracts import
- Test: `apps/web/src/hooks/useSimulationState.test.ts`, `apps/web/src/components/DriverStation/SimControlsBlock.test.tsx`

**Interfaces:**
- Consumes: `SimRunMode` from `@/lib/contracts` (Task 1). Server accepts `{ action, mode? }` (Task 3).
- Produces:
  - `useSimulationState().startRun(mode?: SimRunMode): Promise<void>`
  - `SimControlsBlock` prop `onStart: (mode: SimRunMode) => void`
  - Test ids: `run-button` (unchanged), `run-mode-menu` (the ▾ trigger)
  - Menu items labelled `Debug` and `Build` (used by Task 5).

- [ ] **Step 1: Write failing hook tests**

In `apps/web/src/hooks/useSimulationState.test.ts`, next to the existing `startRun` test, add the following. The file's `beforeEach` already stubs `fetch` with `mockFetchOk()` and enables fake timers.

```ts
	test("startRun sends the mode only when one is given; restartRun sends none", async () => {
		const { result } = renderHook(() => useSimulationState("test-slug"));
		await act(async () => {
			await vi.advanceTimersByTimeAsync(0);
		});

		await act(async () => {
			await result.current.startRun("debug");
			await result.current.startRun();
			await result.current.restartRun();
		});

		const bodies = (fetch as ReturnType<typeof vi.fn>).mock.calls
			.filter((c: unknown[]) => c[0] === "/u/test-slug/api/sim/run")
			.map((c: unknown[]) => JSON.parse((c[1] as RequestInit).body as string));
		expect(bodies).toEqual([
			{ action: "start", mode: "debug" },
			{ action: "start" },
			{ action: "restart" },
		]);
	});
```

- [ ] **Step 2: Write failing component tests**

In `SimControlsBlock.test.tsx`, add `import userEvent from "@testing-library/user-event";`, then:

```ts
	test("Start calls onStart with exactly 'run' (not the click event)", () => {
		const onStart = vi.fn();
		render(
			<SimControlsBlock
				runStatus="idle"
				sessionReady={true}
				onStart={onStart}
				onStop={() => {}}
				onRestart={() => {}}
			/>,
		);
		fireEvent.click(screen.getByTestId("run-button"));
		expect(onStart).toHaveBeenCalledTimes(1);
		expect(onStart).toHaveBeenCalledWith("run");
	});

	test("the start menu offers Debug and Build", async () => {
		const user = userEvent.setup();
		const onStart = vi.fn();
		render(
			<SimControlsBlock
				runStatus="idle"
				sessionReady={true}
				onStart={onStart}
				onStop={() => {}}
				onRestart={() => {}}
			/>,
		);
		await user.click(screen.getByTestId("run-mode-menu"));
		await user.click(await screen.findByRole("menuitem", { name: /Debug/ }));
		expect(onStart).toHaveBeenLastCalledWith("debug");

		await user.click(screen.getByTestId("run-mode-menu"));
		await user.click(await screen.findByRole("menuitem", { name: /Build/ }));
		expect(onStart).toHaveBeenLastCalledWith("build");
	});

	test("the start menu is disabled while a run is busy", () => {
		render(
			<SimControlsBlock
				runStatus="running"
				sessionReady={true}
				onStart={() => {}}
				onStop={() => {}}
				onRestart={() => {}}
			/>,
		);
		expect(screen.getByTestId("run-mode-menu")).toBeDisabled();
	});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `bun run test:web -- SimControlsBlock useSimulationState`
Expected: new tests FAIL. There's no `run-mode-menu`, `onStart` receives the event, and the mode isn't sent.

- [ ] **Step 4: Implement the hook**

In `useSimulationState.ts`:
- Import `type SimRunMode` from `@/lib/contracts`.
- Change the `startRun` signature in `UseSimulationStateReturn` to `startRun: (mode?: SimRunMode) => Promise<void>;`.
- Change `runCommand`:

```ts
	const runCommand = useCallback(
		async (action: SimRunAction, mode?: SimRunMode) => {
			if (!workspaceSlug) return;
			const response = await fetch(`/u/${workspaceSlug}/api/sim/run`, {
				method: "POST",
				credentials: "same-origin",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(mode ? { action, mode } : { action }),
			});
```

and the returned `startRun: (mode?: SimRunMode) => runCommand("start", mode),`.

- [ ] **Step 5: Implement the split button**

In `SimControlsBlock.tsx`:

```tsx
import { Bug, ChevronDown, Hammer, Play, RotateCcw, Square } from "lucide-react";
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
```

Add an optional `className?: string;` to `SimButtonProps`, accept it in `SimButton`, and append it last in the `cn(...)` call (after `TONE_CLASSES[tone]`).

In `SimControlsBlock`, compute `const startDisabled = runBusy || !sessionReady;`. Replace the Start `SimButton` with:

```tsx
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
```

Leave Stop and Restart unchanged.

- [ ] **Step 6: Update prop types upstream**

In `WorkbenchPanel.tsx` and `DriverStation.tsx`, add `SimRunMode` to the existing `import type { ... } from "@/lib/contracts"` and change `onStartRun: () => void;` to `onStartRun: (mode: SimRunMode) => void;`. `WorkspacePage.tsx` passes `simulation.startRun`, which already matches.

- [ ] **Step 7: Run tests to verify they pass**

Run: `bun run test:web && bun run typecheck`
Expected: PASS, including the existing "calls onStart/onStop/onRestart on click" test.

- [ ] **Step 8: Check it in the browser**

Run `bun run dev:control` and `bun run dev:web`, open a workspace, and confirm:
- The ▾ sits flush against Start.
- The menu opens with Debug and Build.
- Both are disabled during a run.

The layout must still fit the Sim Controls block at its narrowest pane width.

- [ ] **Step 9: Commit**

```bash
bun run check:fix
git add apps/web/src
git commit -m "feat(web): split Start button with Debug and Build (#27)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Mocked E2E — menu sends the right request

**Files:**
- Create: `e2e/specs/run/run-modes.spec.ts`

**Interfaces:**
- Consumes: test ids `run-mode-menu`, menu items `Debug` / `Build` (Task 4); fixtures `loginAs`, `seedRuntimeRunning`, `seedWorkspaceProject`, `WorkspacePage` (existing, see `e2e/specs/run/run-lifecycle.spec.ts`).

- [ ] **Step 1: Write the spec**

```ts
/**
 * The Start split button's menu sends the chosen run mode to the control plane.
 */
import { expect, test } from "../../fixtures/app";
import { loginAs } from "../../fixtures/auth";
import {
	seedRuntimeRunning,
	seedWorkspaceProject,
} from "../../fixtures/runtime";
import { WorkspacePage } from "../../page-objects/workspace.po";

for (const mode of ["Debug", "Build"] as const) {
	test(`Start menu → ${mode} posts mode ${mode.toLowerCase()}`, async ({
		page,
		app,
		runtime,
		fakeVscode,
		fakeHalsim,
	}) => {
		const session = await loginAs(page, app, { name: "Alice" });
		const workspace = app.storage.findWorkspaceBySlug(
			session.user.slug as never,
		)!;
		await seedWorkspaceProject(workspace.project_path);
		seedRuntimeRunning({
			runtime,
			workspaceId: workspace.id,
			fakeVscode,
			fakeHalsim,
		});

		const wsp = new WorkspacePage(page, session.user.slug);
		await wsp.goto();

		const request = page.waitForRequest(
			(r) => r.url().endsWith("/api/sim/run") && r.method() === "POST",
		);
		await page.getByTestId("run-mode-menu").click();
		await page.getByRole("menuitem", { name: mode }).click();
		expect((await request).postDataJSON()).toEqual({
			action: "start",
			mode: mode.toLowerCase(),
		});
	});
}
```

- [ ] **Step 2: Run it**

Run: `bun run e2e -- e2e/specs/run/run-modes.spec.ts`
Expected: 2 PASS. If it fails, check that the menu trigger is enabled (session ready), the same precondition the run-button spec relies on.

- [ ] **Step 3: Commit**

```bash
bun run check:fix
git add e2e/specs/run/run-modes.spec.ts
git commit -m "test(e2e): Start menu sends debug/build modes (#27)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: CodeRunner debug extension — auto-attach

**Files:**
- Create: `containers/code/coderunner-debug/package.json`
- Create: `containers/code/coderunner-debug/README.md`
- Create: `containers/code/coderunner-debug/.vscodeignore`
- Create: `containers/code/coderunner-debug/tsconfig.json`
- Create: `containers/code/coderunner-debug/src/debug-marker.ts`
- Create: `containers/code/coderunner-debug/src/extension.ts`
- Create: `containers/code/coderunner-debug/src/debug-marker.test.ts`
- Create: `containers/code/coderunner-debug/src/version.test.ts`
- Modify: `scripts/typecheck.ts` (projects list), root `package.json` (devDependency `@types/vscode`)
- Modify: `containers/code/Dockerfile` (new build stage before `FROM linuxserver/vscodium-web...`; ARG block; `COPY --from`; `--install-extension`; `expected` list)

**Interfaces:**
- Consumes: `$HOME/sim-debug.json` `{port, pid}` and the `sim-debug.*.claim` cleanup in `stop-sim.sh` (Task 2).
- Produces:
  - Exports from `src/debug-marker.ts`: `DEBUG_SESSION_NAME`, `type DebugMarker = { port: number; pid: number }`, `parseDebugMarker(text: string | null): DebugMarker | null`, `readTextFile(path: string): string | null`, `claimDebugRun(home: string, pid: number): boolean`, `isProcessAlive(pid: number): boolean`

- [ ] **Step 1: Write the failing pure-module tests**

`containers/code/coderunner-debug/src/debug-marker.test.ts`:

```ts
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
```

`containers/code/coderunner-debug/src/version.test.ts`:

```ts
import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

test("the Dockerfile pins the extension's package.json version", async () => {
	const pkg = JSON.parse(
		await readFile(join(import.meta.dir, "..", "package.json"), "utf8"),
	) as { version: string };
	const dockerfile = await readFile(
		join(import.meta.dir, "..", "..", "Dockerfile"),
		"utf8",
	);
	expect(dockerfile).toContain(`ARG CODERUNNER_DEBUG_VERSION=${pkg.version}`);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test containers/code/coderunner-debug`
Expected: FAIL (module and package.json missing).

- [ ] **Step 3: Create the package files**

`containers/code/coderunner-debug/package.json`:

```json
{
	"name": "coderunner-debug",
	"displayName": "CodeRunner Debug",
	"description": "Attaches the Java debugger when a CodeRunner simulation is started with Debug.",
	"publisher": "coderunner",
	"version": "0.1.0",
	"license": "MIT",
	"engines": {
		"vscode": "^1.90.0"
	},
	"extensionKind": ["workspace"],
	"activationEvents": ["onStartupFinished"],
	"main": "./dist/extension.js"
}
```

(No `extensionDependencies`. Declaring `vscjava.vscode-java-debug` would make `codium-server --install-extension` resolve it from the gallery and break the pinned-extension check. Java debug is installed alongside it anyway.)

`containers/code/coderunner-debug/README.md`:

```markdown
# CodeRunner Debug

Bundled into the CodeRunner workspace image. When a student starts the
simulation with **Debug**, `run-sim.sh` writes `$HOME/sim-debug.json`; this
extension attaches VS Code's Java debugger to the waiting robot JVM.
See `docs/decisions/045-sim-debugging.md`.

Bump `version` here **and** `CODERUNNER_DEBUG_VERSION` in
`containers/code/Dockerfile` on every change, or existing workspaces keep the
old copy.
```

`containers/code/coderunner-debug/.vscodeignore`:

```
src/**
tsconfig.json
```

`containers/code/coderunner-debug/tsconfig.json`:

```json
{
	"extends": "../../../tsconfig.base.json",
	"compilerOptions": {
		"lib": ["ES2022"]
	},
	"include": ["src/**/*.ts"]
}
```

Add the typecheck project and types:

```bash
bun add -d @types/vscode@1.90.0
```

In `scripts/typecheck.ts`, append `"containers/code/coderunner-debug/tsconfig.json",` to `projects`.

- [ ] **Step 4: Implement `src/debug-marker.ts`**

```ts
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
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `bun test containers/code/coderunner-debug`
Expected: `debug-marker.test.ts` PASS. `version.test.ts` still FAILS until Step 7.

- [ ] **Step 6: Implement `src/extension.ts`**

```ts
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
```

Run: `bun run typecheck`
Expected: PASS.

- [ ] **Step 7: Build and install it in the image**

In `containers/code/Dockerfile`:

(a) After the `spotless-builder` stage's last `RUN` and before the `# V2 merged code container` comment, add:

```dockerfile
# CodeRunner's own editor extension: attaches the Java debugger to Debug runs.
# See docs/decisions/045-sim-debugging.md.
FROM node:22-bookworm-slim AS coderunner-debug-builder

COPY containers/code/coderunner-debug/ /src/
WORKDIR /src
RUN npx --yes esbuild@0.24.2 src/extension.ts --bundle --platform=node --format=cjs \
       --external:vscode --outfile=dist/extension.js \
    && npx --yes @vscode/vsce@3.2.1 package --no-dependencies --skip-license \
       --allow-missing-repository --out /tmp/coderunner-debug.vsix
```

(b) In the extension `ARG` block (after `ARG SPOTLESS_GRADLE_VERSION`), add `ARG CODERUNNER_DEBUG_VERSION=0.1.0`.

(c) After `COPY --from=spotless-builder ...`, add:

```dockerfile
COPY --from=coderunner-debug-builder /tmp/coderunner-debug.vsix /tmp/exts/coderunner-debug.vsix
```

(d) In the `codium-server` install command, add `--install-extension /tmp/exts/coderunner-debug.vsix \` after the spotless line.

(e) In the `jq -e --argjson expected '[...]'` list, append `,"coderunner.coderunner-debug@'"${CODERUNNER_DEBUG_VERSION}"'"` before the closing `]`.

Run: `bun test containers/code/coderunner-debug`
Expected: all PASS (including `version.test.ts`).

Run: `bun run docker:build:workspace`
Expected: the image builds, and the pinned-extension `jq` check passes.

- [ ] **Step 8: Commit**

```bash
bun run check:fix
git add containers/code/coderunner-debug containers/code/Dockerfile scripts/typecheck.ts package.json bun.lock
git commit -m "feat(workspace): bundle a CodeRunner extension that auto-attaches the debugger (#27)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: Real-image verification

**Files:**
- Modify: `e2e/specs/smoke-docker/java-tooling.spec.ts` (after the existing `stop-sim.sh` call, before `const robotLogs = ...`)

**Interfaces:**
- Consumes: everything above, in the built `coderunner-workspace` image.

- [ ] **Step 1: Add the debug-attach check to the Java smoke**

Insert after the existing `stop-sim.sh` `docker([...])` call:

```ts
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
```

- [ ] **Step 2: Build the image and run the smoke (required by decision 038)**

Run: `bun run docker:build:workspace && bun run e2e:workspace-java`
Expected: PASS, including `[java-smoke] starting a Debug run`.

- [ ] **Step 3: Manual pass in the real app**

Run the real app (`bun run dev:control` + `bun run dev:web` with the locally built image) on a robot lesson, and check each item:

- [ ] **Debug** → console shows the "Waiting up to 120s…" line → the debug toolbar appears with no user action.
- [ ] A breakpoint in `Robot.robotInit()` is hit, and Step Over, Variables and Call Stack work.
- [ ] After **Continue**, Robot Code goes green, and **Enable** in the Driver Station works. While paused at a breakpoint, AdvantageScope stays connected (values freeze).
- [ ] **Debug toolbar Stop/Disconnect** detaches the debugger; the sim keeps running until CodeRunner's **Stop**.
- [ ] **CodeRunner Stop** while debugging ends the debug session, and nothing else happens.
- [ ] **Restart** during a debug run starts a new debug run, and the debugger reattaches.
- [ ] With two editor tabs open on the workspace, **Debug** gives exactly one debug session.
- [ ] With the editor tab closed, **Debug** fails after ~120 s with a JDWP error in the console, and the run ends failed.
- [ ] A breakpoint in `Main.java` (before `RobotBase.startRobot`) can stay paused longer than the normal startup timeout without the run being failed.
- [ ] Open a project in a fresh workspace and click **Debug** right away (cold Java import): the debugger still attaches.
- [ ] **Build** on a clean project ends stopped with `BUILD SUCCESSFUL`. Introduce a compile error, and **Build** ends failed.
- [ ] **Stop** during a **Build** ends the Gradle process.
- [ ] Plain **Start** behaves exactly as before.

- [ ] **Step 4: Commit**

```bash
bun run check:fix
git add e2e/specs/smoke-docker/java-tooling.spec.ts
git commit -m "test(smoke): real-image check that Debug runs attach the debugger (#27)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: Docs and decision log

**Files:**
- Modify: `docs/using-coderunner.md` (the `:::important` block at the top of "Robot lessons and imported projects", plus a new subsection before `## PathPlanner`)
- Create: `docs/decisions/045-sim-debugging.md`
- Modify: `AGENTS.md` (Current Status, after the Auth0 paragraph; Key References "011–044" → "011–045")

- [ ] **Step 1: Update the user docs**

In `docs/using-coderunner.md`, replace the body of the `:::important[Start the simulation from CodeRunner]` block with:

```markdown
The WPILib extension can start or debug a simulation, but you should not use
it here. Click **Start** in the Driver Station at the bottom of the page so
CodeRunner can use its supported headless simulation setup and connect the
controls and telemetry. To debug, use **Start ▾ → Debug** instead of WPILib's
*Simulate Robot Code* or *Debug Robot Code*.
```

Insert before `## PathPlanner`:

```markdown
### Debugging and building

Click the **▾** beside **Start** for two more options:

- **Debug** starts the simulation with the debugger connected. Set
  breakpoints in the editor first. The robot waits up to 2 minutes for the
  editor's debugger, which connects by itself, so breakpoints in your `Robot`
  constructor and `robotInit` are hit. Use the debug toolbar to step,
  continue and inspect variables. While your code is paused, the robot stops
  running its loop (expect loop-overrun warnings), and AdvantageScope's
  values freeze. **Disconnect** on the debug toolbar detaches the debugger
  and leaves the simulation running; use **Stop** in the Driver Station to
  end it. Keep the editor open: if nothing connects within 2 minutes (for
  example, the editor tab was closed or reloaded while the robot was
  starting), the run fails and you can click **Debug** again.
- **Build** compiles your project and runs its tests (`./gradlew build`)
  without starting the simulation. The output appears in the **Console** tab.
```

- [ ] **Step 2: Write the decision log**

`docs/decisions/045-sim-debugging.md`:

```markdown
# 045 — Sim debugging and run modes

## Decision

Start becomes a split button with **Debug** and **Build** (gh #27). The mode
travels as `mode` on `POST /api/sim/run` → `RunManager` → `SIM_MODE` →
`run-sim.sh`. `restart` with no mode reuses the last run's mode.

**Attach, not launch.** WPILib's *Simulate Robot Code* launches the robot JVM
under the debugger. That would run a second, unmanaged sim beside ours: it
needs the Sim GUI (X11) and competes for port 3300. CodeRunner keeps owning
the JVM (decision 025), and in debug mode adds
`-agentlib:jdwp=transport=dt_socket,server=y,suspend=y,address=127.0.0.1:5005,timeout=120000,quiet=y`.

- **Loopback only.** In network mode, workspaces share a Docker network. A
  JDWP port on `0.0.0.0` would let one student run code in another's JVM.
- **`suspend=y` with a 120 s timeout.** Breakpoints in startup code are hit.
  If nothing attaches, the JVM exits and the run fails. 120 s, not 30 s:
  Java Debug won't resolve an attach until the Java language server has
  imported the project (about 40 s in decision 036, longer for large
  projects), and a student may click Debug right after opening one.
- **No readiness deadline once the JVM is up.** In debug mode, the run's
  build/startup timer is cancelled when the JVM prints its "Waiting…" line,
  so a student paused at a breakpoint before the NT4 readiness line (e.g. in
  `Main.java`) isn't failed. The JDWP timeout covers the attach wait.

**Who attaches.** A bundled extension, `coderunner-debug` (built in a
Dockerfile stage like Spotless, installed with the pinned extensions), polls
`$HOME/sim-debug.json` (`{port, pid}`). `run-sim.sh` writes that file just
before `exec java`. Each editor tab has its own extension host, so the
attach is claimed per sim pid with an `O_EXCL` file
(`sim-debug.<pid>.claim`). A push from the control plane through the editor
proxy was rejected as new authenticated plumbing for a container-local
event.

**Debug toolbar Stop only disconnects.** Stopping the sim from the debugger
was designed and then dropped after review. The sim runs as root
(`docker exec` without `--user`) while VSCodium runs as `abc`, so it needed a
root-side relay, which could race with Restart and kill the new run. Students
stop the sim with CodeRunner's Stop.

**Known limitation.** The attach claim belongs to whichever editor tab took
it. If that tab is closed or reloaded during startup, no other tab retries,
and the run fails at the JDWP timeout; clicking Debug again works.

**Build** runs `./gradlew build` (what WPILib's *Build Robot Code* runs, tests
included). It skips readiness detection, so Gradle output mentioning
NetworkTables can't mark it running. It has only the build timeout, and a
clean exit ends it **stopped**. `run-sim.sh` prints `BUILD FAILED` on any
non-zero Gradle exit.

## Consequences

- Bump the extension's `version` and `CODERUNNER_DEBUG_VERSION` together on
  every change. Reconciliation only updates existing workspaces when
  `id@version` changes, and `version.test.ts` keeps the two in sync.
- The image and its extensions changed, so `bun run e2e:workspace-java` is
  required (decision 038). It now checks that a Debug run's robot only starts
  after the extension attaches.
- `bun run test` now includes `containers/code` (sim script and extension
  tests).
```

- [ ] **Step 3: Update `AGENTS.md`**

After the **Auth0 SSO** status paragraph, add:

```markdown
**Sim debugging (post-V2):** Start is a split button with **Debug** and
**Build** run modes (`mode` on `POST /api/sim/run`, `SIM_MODE` into
`run-sim.sh`). Debug starts the robot JVM with a loopback JDWP agent
(`suspend=y`, 120 s) and writes `$HOME/sim-debug.json`. The bundled
`containers/code/coderunner-debug` extension attaches VSCodium's Java
debugger. Bump its version together with the Dockerfile's
`CODERUNNER_DEBUG_VERSION`. See `docs/decisions/045-sim-debugging.md`.
```

Change `011–044 active` to `011–045 active` under Key References.

- [ ] **Step 4: Verify docs build and everything passes**

Run: `bun run docs:build && bun run verify`
Expected: both succeed.

- [ ] **Step 5: Commit and refresh the graph**

```bash
bun run check:fix
git add docs/using-coderunner.md docs/decisions/045-sim-debugging.md AGENTS.md
git commit -m "docs: sim debugging and build modes (#27)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
graphify update .
```
