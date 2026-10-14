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

- **`quiet=y` is required.** Without it the agent prints its "Listening for
  transport" banner through C stdio, and wpiutil's bundled fmt then aborts
  (`fmt/base.h:423: assertion failed: negative value`) when the HAL loads
  `halsim_ws_server` and writes to the same piped stdout. Found by the
  real-image smoke; reproduced with plain `java` + the agent, gone with
  `quiet=y` or with no HALSim extensions.
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
