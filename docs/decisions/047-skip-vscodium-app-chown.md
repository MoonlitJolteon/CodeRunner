# 047 — Skip the base image's chown of /app/vscodium-web

## Decision

The workspace image deletes the `lsiown -R abc:abc /app/vscodium-web` line
from the linuxserver base's `init-vscodium-web` script at build time and runs
`chmod -R a+rX /app/vscodium-web` instead. The build fails if the base script
still mentions `/app/vscodium-web` after the edit, so a base bump that moves
the line is caught.

## Why

The control plane starts workspaces with the data dir owner as `PUID`
(decision 017), which is not the UID the base image's files carry. The base
init then chowns all ~3,500 VSCodium files on every new container. On
overlay2 each chown is a copy-up into the container's upper layer, and the
editor does not start until it finishes.

On a TrueNAS host (overlay2 on a raidz1 HDD pool, `xattr=on`,
`sync=standard`, no SLOG) this took ~17 minutes per workspace. It hit every
student at once after each release, because decision 046 recycles every
workspace onto the new image. Enabling overlayfs `metacopy` cut the copied
bytes to ~34 MB but not the per-file cost (~0.4 s each, for xattr writes and
syncs).

`codium-server` only reads its install tree. Its writable state lives under
`/config`, which the base init still chowns. Read access is all `abc` needs,
whatever its runtime UID.

## Consequences

- New workspace containers reach "Extension host agent listening" without
  touching the image layer.
- `/app/vscodium-web` stays owned by the build-time UID. Anything that needs
  to write there at runtime must be added at build time instead.
