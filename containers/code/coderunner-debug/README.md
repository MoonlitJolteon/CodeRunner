# CodeRunner Debug

Bundled into the CodeRunner workspace image. When a student starts the
simulation with **Debug**, `run-sim.sh` writes `$HOME/sim-debug.json`; this
extension attaches VS Code's Java debugger to the waiting robot JVM.
See `docs/decisions/045-sim-debugging.md`.

Bump `version` here **and** `CODERUNNER_DEBUG_VERSION` in
`containers/code/Dockerfile` on every change, or existing workspaces keep the
old copy.
