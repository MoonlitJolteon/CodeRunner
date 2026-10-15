# 046 — Recycle workspace containers on an older image

## Decision

When the control plane adopts an existing workspace container
(`adoptCodeContainer`), it recreates the container if it was created from a
different image than the code image tag resolves to now. A new workspace
image reaches students after `docker compose pull` on its own;
`coderunner rebuild-workspaces` is no longer a required update step.

**Compared against the tag's current ID, not one pinned at boot.** Pinning
the ID when the control plane starts looked safer, because a pull would only
take effect on a restart. It breaks single-tag updates, though: with
`CODERUNNER_TAG=latest`, `docker compose up -d` leaves the control container
running unless its own image changed. The pinned ID would stay old
indefinitely, and even `rebuild-workspaces` would recreate students on the
old image. Replacement containers are created from the tag, so comparing
against the tag is also what keeps a replacement from being recycled again.

**Cached for 10 s.** Adoption runs on every proxied editor request, so the
tag's ID (`docker image inspect`) is cached for `CODE_IMAGE_ID_TTL_MS`.
`ensureImage()` shares the cache.

**Labelled, not read from `.Image`.** Each container is created with
`frc-sim.image-id=<ID>`, the same `docker image inspect` value it is later
compared against. With the containerd image store, a container's `.Image`
need not have the same form as the image's `.Id`; a mismatch there would
recreate the container on every request. Containers created before this
change have no label and fall back to `.Image`, so at worst they are
recycled once and come back labelled. A container reporting neither stays
adoptable, as does any container while the image is missing.

## Consequences

- A pull recycles running workspaces within about 10 s, disconnecting live
  editor sessions and stopping running sims, just as `rebuild-workspaces`
  did. Pull between classes.
- `rebuild-workspaces` remains for forcing fresh containers. The Deploy
  workflow still runs it after `compose up`, which is now redundant but
  harmless.
