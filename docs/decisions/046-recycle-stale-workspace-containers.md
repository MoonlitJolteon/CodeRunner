# 046 — Recycle workspace containers on an older image

## Decision

When the control plane adopts an existing workspace container
(`adoptCodeContainer`), it recreates the container if it was created from a
different image than the one this control-plane process uses. After
`docker compose pull` + `up -d`, a new workspace image reaches students on its
own; `coderunner rebuild-workspaces` is no longer an update step, and the
Deploy workflow no longer runs it.

**The image ID is pinned per process.** The control plane resolves the code
image tag (`docker image inspect`) at boot and keeps that ID until it exits.
If the image is missing at boot, the first successful lookup pins it. This rests on one assumption: **control and workspace images always
update together.** `release.yml` publishes both for every tag and stamps
`org.opencontainers.image.version` on each, so every release changes both
image IDs. Any update therefore recreates the control container (a new
`CODERUNNER_TAG` changes `CODE_IMAGE`; a moved `latest` changes the control
image), and the new process pins the new workspace ID.

Comparing against the tag's live ID was rejected. On a floating tag,
`docker compose pull` moves the tag under the still-running old control
plane. That control plane would then recreate students on the new image with
its old `docker run` arguments. The new control plane would adopt those
containers because the image matches, so the release's argument changes
would never reach them. A pull alone would also kill every live session.
With a pinned ID, a pull changes nothing until the restart. Every container
the old process created then carries the old ID, so the new process recycles
it and recreates it with its own arguments.

**Run by tag; the label marks the process.** Containers are still created
with `docker run <tag>`, so Docker Desktop, Portainer and `docker ps` show the
version. Between a pull and the restart, the old process can therefore start
a container from the newer image while labelling it with its own, older ID.
That is harmless: the next process pins the newer ID and recycles the
container with its own arguments. Every container a process creates carries
that process's ID, so nothing is recycled twice by the same process.

**Labelled, not read from `.Image`.** Each container is created with
`frc-sim.image-id=<ID>`, the same `docker image inspect` value it is later
compared against, so the check never depends on how the image store
(e.g. containerd) formats a container's `.Image`. A container without the
label predates this change and is recycled once. Any container stays
adoptable while the image is missing.

## Consequences

- After a control-plane restart onto a new release, each workspace is
  recycled the next time it is seen. The restart has already dropped every
  proxied session, so no extra disconnect is visible. Update between classes.
- A workspace image rebuilt or pulled without restarting the control plane
  reaches only containers created after it (e.g. by `rebuild-workspaces`).
  Existing containers move over when the control plane restarts.
- If the release process ever stops changing the workspace image ID with
  every release, a release that changes only control-plane `docker run`
  arguments will not recycle workspaces. Revisit this decision before making
  that change.
- `rebuild-workspaces` remains for forcing fresh containers.
