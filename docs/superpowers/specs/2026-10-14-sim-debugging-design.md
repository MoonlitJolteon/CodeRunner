# Sim Debugging and Run Modes — Design

**Date:** 2026-10-14
**Status:** draft, pending review
**Issue:** [#27](https://github.com/mathewdunne/CodeRunner/issues/27)
**Decision log to add:** `docs/decisions/045-sim-debugging.md`

## Problem

Mentors and students expect to set breakpoints in robot code and step through
it while the simulation runs, as WPILib's **Simulate Robot Code** command
does on the desktop. In CodeRunner, breakpoints never trigger. `run-sim.sh`
builds with Gradle, then `exec java -jar` starts the robot JVM with no debug
agent, so the editor's debugger has nothing to attach to. There is no
workaround: robot JVM args are operator-controlled (`ROBOT_SIM_JVMARGS`),
and Gradle `jvmArgs` don't apply because CodeRunner doesn't launch the robot
through Gradle's JavaExec (decision 025).

WPILib's own command is not usable inside CodeRunner. It starts a second,
unmanaged sim. That sim prompts for HALSim extensions (the Sim GUI needs X11,
which the container doesn't have), skips our headless init script and memory
bounds, competes for port 3300, and is invisible to Stop and run status.

## Agreed requirements

From the brainstorming conversation:

- **Start becomes a split button.** The main face stays **Start**; a ▾ menu
  offers **Debug** and **Build**.
- **Debug** starts the sim exactly like Start, and the VSCodium debugger
  attaches by itself. The student gets the normal step-through controls
  (toolbar, Variables, Call Stack). Driver Station and AdvantageScope keep
  working.
- **Wait for the debugger.** In Debug, the robot JVM pauses before running any
  student code until the debugger attaches, so breakpoints in the `Robot`
  constructor and `robotInit` are hit. If nothing attaches within 120 s, the
  run fails with a clear message. *(Amended after review: 30 s → 120 s,
  because Java Debug won't attach until the editor's Java import finishes,
  which can take over 40 s on a freshly opened project.)*
- **Decided after review: the debug toolbar's Stop only disconnects.** The
  stop-the-sim relay was dropped (it could race with Restart); students use
  CodeRunner's Stop. Original requirement, kept for the record:
  **the debug toolbar's Stop stops the sim**, but only if that turns out easy
  and reliable. **Fallback:** if it proves brittle during implementation, the
  Stop button just disconnects the debugger (VS Code's default for attached
  sessions), and the stop-the-sim code is dropped. The implementer makes this
  call; no further approval is needed.
- **Build** runs `./gradlew build`, as WPILib's *Build Robot Code* does
  (tests included), streams output to the console, and ends **stopped** on
  success or **failed** on failure.
- **Start is unchanged** and gets no debug agent.
- **Restart** reruns in the current run's mode.
- No changes to student project files (`.vscode/launch.json` etc.).
- The debug port is reachable only inside the workspace container.

## Non-goals

- Exposing the debug port outside the container, or debugging from a
  desktop IDE.
- Making WPILib's *Simulate Robot Code* / *Debug Robot Code* commands work
  inside CodeRunner.
- Debugging `plain-java` console lessons (they don't use the sim run path).
- Debugging native code (HALSim, NT4) or JNI debug builds.
- A new run status for "build succeeded". Gradle's own `BUILD SUCCESSFUL`
  line in the console is the success signal.
- Changing the WebSocket `start` message. The web shell starts runs with
  `POST /api/sim/run`; the WS path is left as-is unless the plan finds the
  UI depends on it.

## Approach

The editor learns about a debug run from a **marker file**. In debug mode,
`run-sim.sh` writes a small file just before it `exec`s the robot JVM. A small
bundled CodeRunner extension inside VSCodium watches for that file and
attaches.

Alternatives considered:

- **Polling port 5005 from the extension.** Simpler, but it polls
  indefinitely and can't tell one run from the next.
- **The control plane pushing a message into the editor.** This needs new
  authenticated plumbing through the editor proxy. That's overkill when the
  extension and the JVM already share a container.

Attach, not launch: WPILib's *Simulate Robot Code* launches the JVM under the
debugger. CodeRunner's run manager owns the JVM's lifecycle, so the debugger
attaches to it instead (as WPILib's roboRIO debugging does). Once attached,
the session looks the same to the student.

## Design

### Contract (`packages/contracts`)

- `simRunCommandRequestSchema` gains optional
  `mode: "run" | "debug" | "build"`, defaulting to `"run"`.
- `restart` with no `mode` reuses the mode of the current (or most recent) run, as tracked by the
  control plane. It therefore survives a page reload mid-debug.
- *(Amended during planning:)* the mode is **not** added to the sim status
  response. Nothing in the UI uses it, and `restart` resolves it server-side.

### Control plane (`apps/control/src/runs.ts`, `app/workspace-routes.ts`)

- `RunManager.start(workspace, connection?, mode = "run")`. The mode is stored
  on the `RunJob` and remembered per workspace (`RunManager.lastMode()`).
- The mode is validated against the enum, then passed into the container as
  `SIM_MODE=<mode>` on the existing `start-sim.sh` invocation in
  `dockerRunScript()`.
- Build mode:
  - The readiness timer uses `runBuildTimeoutMs` only; there is no sim
    startup phase.
  - Exit code 0 ends the run **stopped**. Today, exiting 0 without ever
    reporting "running" ends **failed**.
  - A non-zero exit or `BUILD FAILED` ends **failed**, as today.
- Run and debug modes keep today's readiness detection (the NT4 log line). In
  debug mode, that line appears only after the debugger attaches and the JVM
  resumes. *(Amended after review:)* in debug mode the build/startup
  deadline is cancelled once the JVM prints its "Waiting…" line, so a
  student paused at a breakpoint before the readiness line isn't failed.
  The 120 s JDWP timeout covers the attach wait.
- The route handler for `POST /api/sim/run` resolves the mode. It uses the
  explicit `mode` if given; for `restart`, the current (or most recent) run's mode; otherwise
  `"run"`.

### Container scripts (`containers/code/`)

- **`start-sim.sh`**: passes `SIM_MODE` (default `run`) to `run-sim.sh` as a
  new argument. Stale debug files are cleared by the `stop-sim.sh` call it
  already makes.
- **`run-sim.sh`**:
  - **run:** unchanged.
  - **build:** runs `./gradlew` with the same flags and init script, task
    `build`, then exits with Gradle's exit code. It does not read the
    descriptor or start a JVM.
  - **debug:** same Gradle phase as run. Before `exec`, it:
    1. appends
       `-agentlib:jdwp=transport=dt_socket,server=y,suspend=y,address=127.0.0.1:5005,timeout=120000`
       to `java_args`;
    2. prints `Waiting up to 120s for the editor's debugger to attach on port 5005…`;
    3. writes `$HOME/sim-debug.json` as `{"port":5005,"pid":<$$>}`. `$$`
       survives `exec`, so it is the robot JVM's pid and matches `sim.pid`.
  - The address is pinned to `127.0.0.1`. In network mode, workspaces share
    a Docker network, so `0.0.0.0` would let another workspace attach and
    run code in this JVM.
- **`stop-sim.sh`**: removes `$HOME/sim-debug.json`, the claim files and
  `$HOME/sim-stop-request`. Its
  process-name fallback match also covers the Gradle `build` invocation, not
  just `*simulate*`, so Stop works during a Build.

### CodeRunner extension (`containers/code/coderunner-debug/`)

A small TypeScript VS Code extension.

- **Manifest:** `extensionKind: ["workspace"]`, so it runs on the container
  side with Node `fs`. It activates `onStartupFinished`. *(Amended:)* it
  declares no `extensionDependencies`, because that would make
  `codium-server --install-extension` fetch Java debug from the gallery and
  break the pinned-extension check.
- **Watching:** polls `$HOME/sim-debug.json` (`fs.watchFile`, ~500 ms). The
  path is outside the workspace folder, so VS Code's workspace file watchers
  don't apply.
- **Claiming (multiple tabs):** each open editor tab has its own extension
  host. When a marker with a new pid appears, the host atomically creates
  `$HOME/sim-debug.<pid>.claim` (`O_EXCL`). Only the host that creates it
  attaches, and losing hosts do nothing. *(Amended:)* a per-pid file name
  replaces "one claim file, replace if stale", because replacing a stale file
  is itself racy between two tabs.
- **Attaching:** the claiming host calls `vscode.debug.startDebugging` with
  `{type: "java", request: "attach", name: "Debug Simulation", hostName:
  "127.0.0.1", port}`. It retries briefly (a few seconds) in case the JDWP
  listener isn't open yet.
- **Debug toolbar Stop:** on `onDidTerminateDebugSession` for its own session,
  the claiming host requests a stop only if its `attach` succeeded (seen via
  a debug adapter tracker) and the attached pid is still alive *and* still
  equals `sim.pid`. *(Amended:)* the sim runs as **root** (`docker exec` has
  no `--user`), while VSCodium runs as **abc**, so the extension can't run
  `stop-sim.sh` against it. It writes the pid to `$HOME/sim-stop-request`
  instead, and the control plane's debug-mode run script (root) polls that
  file and runs `stop-sim.sh`. When the sim
  ended for any other reason (CodeRunner Stop, Restart, crash, JDWP timeout),
  the check is false and nothing happens. *(Subject to the fallback in the
  requirements.)*
- **Testability:** claim, staleness and should-stop decisions live in a pure
  module with no `vscode` import, unit-tested with `bun test`. `extension.ts`
  is thin wiring.
- **Build and install:** a Dockerfile build stage compiles and packages the
  extension to a `.vsix`, mirroring the existing `spotless-builder` stage. It
  is installed alongside the other bundled extensions and added to the
  pinned `expected` list in the install check. `reconcile-frc-extensions`
  already rolls managed-extension updates onto existing workspaces.

### Web (`apps/web`)

- **`SimControlsBlock`**: Start becomes a split button. The main face runs
  Start; ▾ opens a menu with **Debug** and **Build**, using existing UI
  primitives. Stop and Restart are unchanged.
- **`useSimulationState`**: `startRun(mode?)` sends `mode` in the
  `POST /api/sim/run` body. `restartRun()` sends no mode.
- Prop changes flow through `DriverStation` / `WorkspacePage`.

### Docs

- `docs/using-coderunner.md`: a "Debugging your robot code" section covering
  Debug, breakpoints, the 30 s attach window, Stop behaviour, and Build. It
  also tells students to use CodeRunner's Debug instead of WPILib's
  *Simulate Robot Code* / *Debug Robot Code*.
- `docs/decisions/045-sim-debugging.md`: attach vs. launch, the marker file
  and claim, the `127.0.0.1` binding, `suspend=y` with a timeout, and the
  Stop fallback.
- An `AGENTS.md` status paragraph pointing at the decision log.

## Error handling

| Situation | Behaviour |
|---|---|
| Editor not open / extension never attaches | The JVM exits after 120 s with a JDWP timeout error, and the run ends **failed**. The console shows the "Waiting up to 120s…" line before it. |
| Two editor tabs | Only the claiming tab attaches; the other does nothing. If the claiming tab is closed or reloaded during startup, no other tab retries and the run fails at the JDWP timeout (known limitation; click Debug again). |
| Paused at a breakpoint before the readiness line | No deadline once the JVM is waiting for/attached to the debugger. |
| CodeRunner Stop / Restart while debugging | The JVM is killed, the debug session ends, and the pid check prevents a second stop. |
| Debugger paused at a breakpoint | The robot loop stops. Expect loop-overrun and watchdog warnings, which are normal for WPILib debugging. Native HALSim/NT4 keep running, so the DS and AdvantageScope stay connected, with values frozen. |
| Build fails | Gradle output in the console; run ends **failed**. |
| Stop during Build | The Gradle process tree is killed, and the run ends **stopped**. |

## Testing

- **Contracts:** the schema accepts each mode and rejects unknown ones.
- **`runs.ts` / route tests:**
  - The mode reaches the run command as `SIM_MODE`.
  - A successful build ends **stopped**.
  - A failed build ends **failed**.
  - `restart` reuses the current mode.
  - An invalid mode is rejected.
- **`sim-scripts.test.ts`** (fake `gradlew` / `java`):
  - Debug adds the JDWP agent bound to `127.0.0.1` and writes the marker
    with the exec'd pid.
  - Build runs `build` and starts no JVM.
  - Run's arguments are unchanged.
  - `stop-sim.sh` removes the marker and claim.
- **Extension pure module (`bun test`):**
  - Claim succeeds once.
  - A stale claim is replaced.
  - The should-stop decision is true only when the pid is alive and matches
    `sim.pid`.
- **Web (Vitest):** the split button menu calls `startRun("debug")` /
  `startRun("build")`; Restart passes no mode.
- **Mocked E2E:** choosing Debug or Build from the menu sends the right
  request body.
- **Real image (`bun run e2e:workspace-java`):** required by decision 038,
  because the image and its extensions change. Add a check that a debug
  run's JVM answers the JDWP handshake on `127.0.0.1:5005` inside the
  container.
- **Manual (real app):**
  - Debug attaches automatically, and a breakpoint in `robotInit` is hit.
  - Step, Variables and Call Stack work.
  - DS enable works while the debugger is attached.
  - Debug toolbar Stop stops the sim (or disconnects, under the fallback).
  - With two tabs open, only one attaches.
  - The 30 s timeout fires with the editor closed.
  - Build succeeds and fails as expected.
