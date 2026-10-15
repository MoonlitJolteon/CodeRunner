import { describe, expect, setSystemTime, test } from "bun:test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { codeContainerName, codeVolumeName } from "../containers/metadata";
import { createFakeDocker, login, withApp, workspaceBySlug } from "./helpers";

describe("container reconciliation", () => {
	test("adoption rejects a container with non-loopback port bindings", async () => {
		const fakeDocker = createFakeDocker();

		await withApp(
			async (app) => {
				await login(app, "alice");
				const workspace = workspaceBySlug(app, "alice");
				const name = codeContainerName(workspace.id);

				// Pre-create a container with a non-loopback (0.0.0.0) sim port
				fakeDocker.containers.set(name, {
					name,
					running: true,
					labels: {
						"frc-sim.managed": "true",
						"frc-sim.version": "v2",
						"frc-sim.role": "code",
						"frc-sim.workspace": workspace.id,
					},
					ports: [
						{ hostPort: 25830, containerPort: 5810, hostIp: "0.0.0.0" },
						{ hostPort: 33050, containerPort: 3000, hostIp: "127.0.0.1" },
					],
				});

				const status = await app.containers.ensureCodeContainer(workspace);
				// The container with non-loopback ports should have been removed and a new one created
				expect(status.state).toBe("running");
				expect(fakeDocker.calls).toContainEqual(["rm", "-f", name]);
				const runCalls = fakeDocker.calls.filter((call) => call[0] === "run");
				expect(runCalls.length).toBeGreaterThan(0);
			},
			{
				dockerRunner: fakeDocker.runner,
				codeImage: "coderunner-workspace:test",
				simPortRange: { start: 25830, end: 25831 },
				vscodePortRange: { start: 33050, end: 33051 },
			},
		);
	});

	test("adoption rejects a container with mismatched labels", async () => {
		const fakeDocker = createFakeDocker();

		await withApp(
			async (app) => {
				await login(app, "alice");
				const workspace = workspaceBySlug(app, "alice");
				const name = codeContainerName(workspace.id);

				// Pre-create a container with wrong version label
				fakeDocker.containers.set(name, {
					name,
					running: true,
					labels: {
						"frc-sim.managed": "true",
						"frc-sim.version": "v1",
						"frc-sim.role": "sim",
						"frc-sim.workspace": workspace.id,
					},
					ports: [
						{ hostPort: 25832, containerPort: 5810, hostIp: "127.0.0.1" },
						{ hostPort: 33052, containerPort: 3000, hostIp: "127.0.0.1" },
					],
				});

				const status = await app.containers.ensureCodeContainer(workspace);
				expect(status.state).toBe("running");
				// The old mismatched container should have been removed
				expect(fakeDocker.calls).toContainEqual(["rm", "-f", name]);
				// A new properly-labeled container should have been created
				const runCalls = fakeDocker.calls.filter((call) => call[0] === "run");
				expect(runCalls.length).toBeGreaterThan(0);
			},
			{
				dockerRunner: fakeDocker.runner,
				codeImage: "coderunner-workspace:test",
				simPortRange: { start: 25832, end: 25833 },
				vscodePortRange: { start: 33052, end: 33053 },
			},
		);
	});

	test("adoption rejects a bind-mounted /config when demo mode wants a volume", async () => {
		const fakeDocker = createFakeDocker();

		await withApp(
			async (app) => {
				const workspace = workspaceBySlug(app, "demo");
				const name = codeContainerName(workspace.id);

				// A container created before demo mode moved /config onto a volume.
				// Adopting it would leave the workspace on the slow bind mount.
				fakeDocker.containers.set(name, {
					name,
					running: true,
					labels: {
						"frc-sim.managed": "true",
						"frc-sim.version": "v2",
						"frc-sim.role": "code",
						"frc-sim.workspace": workspace.id,
					},
					// Otherwise adoptable: correct labels, all three loopback ports.
					ports: [
						{ hostPort: 25836, containerPort: 5810, hostIp: "127.0.0.1" },
						{ hostPort: 33056, containerPort: 3000, hostIp: "127.0.0.1" },
						{ hostPort: 34056, containerPort: 3300, hostIp: "127.0.0.1" },
					],
					mounts: [{ Type: "bind", Destination: "/config" }],
				});

				const status = await app.containers.ensureCodeContainer(workspace);
				expect(status.state).toBe("running");
				expect(fakeDocker.calls).toContainEqual(["rm", "-f", name]);

				const runCall = fakeDocker.calls.find((call) => call[0] === "run");
				expect(runCall).toBeTruthy();
				expect(runCall).toContain(
					`type=volume,src=${codeVolumeName(workspace.id)},dst=/config`,
				);
				// And the replacement is adoptable, so a second pass does not churn.
				await app.containers.ensureCodeContainer(workspace);
				expect(
					fakeDocker.calls.filter((call) => call[0] === "run"),
				).toHaveLength(1);
			},
			{
				demo: true,
				dockerRunner: fakeDocker.runner,
				codeImage: "coderunner-workspace:test",
				simPortRange: { start: 25836, end: 25837 },
				vscodePortRange: { start: 33056, end: 33057 },
				halsimPortRange: { start: 34056, end: 34057 },
			},
		);
	});

	test("adoption restarts a stopped code container instead of creating a new one", async () => {
		const fakeDocker = createFakeDocker();

		await withApp(
			async (app) => {
				await login(app, "alice");
				const workspace = workspaceBySlug(app, "alice");
				const name = codeContainerName(workspace.id);

				// Pre-create a stopped container with correct labels
				fakeDocker.containers.set(name, {
					name,
					running: false,
					labels: {
						"frc-sim.managed": "true",
						"frc-sim.version": "v2",
						"frc-sim.role": "code",
						"frc-sim.workspace": workspace.id,
					},
					ports: [
						{ hostPort: 25834, containerPort: 5810, hostIp: "127.0.0.1" },
						{ hostPort: 33054, containerPort: 3000, hostIp: "127.0.0.1" },
						{ hostPort: 34054, containerPort: 3300, hostIp: "127.0.0.1" },
					],
				});

				const status = await app.containers.ensureCodeContainer(workspace);
				expect(status.state).toBe("running");
				// Should have started the existing container, not created a new one
				expect(fakeDocker.calls).toContainEqual(["start", name]);
				const runCalls = fakeDocker.calls.filter((call) => call[0] === "run");
				expect(runCalls.length).toBe(0);
				expect(fakeDocker.containers.get(name)?.running).toBe(true);
			},
			{
				dockerRunner: fakeDocker.runner,
				codeImage: "coderunner-workspace:test",
				simPortRange: { start: 25834, end: 25835 },
				vscodePortRange: { start: 33054, end: 33055 },
				halsimPortRange: { start: 34054, end: 34055 },
			},
		);
	});

	for (const running of [true, false]) {
		test(`adoption recreates a ${running ? "running" : "stopped"} container from an older image`, async () => {
			const fakeDocker = createFakeDocker();

			await withApp(
				async (app) => {
					await login(app, "alice");
					const workspace = workspaceBySlug(app, "alice");
					const name = codeContainerName(workspace.id);

					// Otherwise adoptable, but created before the image was updated.
					fakeDocker.containers.set(name, {
						name,
						running,
						labels: {
							"frc-sim.managed": "true",
							"frc-sim.version": "v2",
							"frc-sim.role": "code",
							"frc-sim.workspace": workspace.id,
						},
						ports: [
							{ hostPort: 25840, containerPort: 5810, hostIp: "127.0.0.1" },
							{ hostPort: 33060, containerPort: 3000, hostIp: "127.0.0.1" },
							{ hostPort: 34060, containerPort: 3300, hostIp: "127.0.0.1" },
						],
						image: "sha256:older",
					});

					const status = await app.containers.ensureCodeContainer(workspace);
					expect(status.state).toBe("running");
					expect(fakeDocker.calls).toContainEqual(["rm", "-f", name]);
					expect(fakeDocker.calls).not.toContainEqual(["start", name]);
					expect(fakeDocker.containers.get(name)?.image).toBe("fake-image");
					const runCall = fakeDocker.calls.find((call) => call[0] === "run");
					expect(runCall).toContain("frc-sim.image-id=fake-image");

					// The replacement is on the current image, so a second pass adopts it.
					await app.containers.ensureCodeContainer(workspace);
					expect(
						fakeDocker.calls.filter((call) => call[0] === "run"),
					).toHaveLength(1);
				},
				{
					dockerRunner: fakeDocker.runner,
					codeImage: "coderunner-workspace:test",
					simPortRange: { start: 25840, end: 25841 },
					vscodePortRange: { start: 33060, end: 33061 },
					halsimPortRange: { start: 34060, end: 34061 },
				},
			);
		});
	}

	test("adoption trusts the image ID label over the container's Image field", async () => {
		const fakeDocker = createFakeDocker();

		await withApp(
			async (app) => {
				await login(app, "alice");
				const workspace = workspaceBySlug(app, "alice");
				const name = codeContainerName(workspace.id);

				// An image store that reports container images in another form
				// must not make every adoption look stale.
				fakeDocker.containers.set(name, {
					name,
					running: true,
					labels: {
						"frc-sim.managed": "true",
						"frc-sim.version": "v2",
						"frc-sim.role": "code",
						"frc-sim.workspace": workspace.id,
						"frc-sim.image-id": "fake-image",
					},
					ports: [
						{ hostPort: 25844, containerPort: 5810, hostIp: "127.0.0.1" },
						{ hostPort: 33064, containerPort: 3000, hostIp: "127.0.0.1" },
						{ hostPort: 34064, containerPort: 3300, hostIp: "127.0.0.1" },
					],
					image: "sha256:other-format",
				});

				const status = await app.containers.ensureCodeContainer(workspace);
				expect(status.state).toBe("running");
				expect(fakeDocker.calls).not.toContainEqual(["rm", "-f", name]);
				expect(fakeDocker.calls.some((call) => call[0] === "run")).toBe(false);
			},
			{
				dockerRunner: fakeDocker.runner,
				codeImage: "coderunner-workspace:test",
				simPortRange: { start: 25844, end: 25845 },
				vscodePortRange: { start: 33064, end: 33065 },
				halsimPortRange: { start: 34064, end: 34065 },
			},
		);
	});

	test("a pull recycles a running container once the cached image ID expires", async () => {
		const fakeDocker = createFakeDocker();
		const runs = () =>
			fakeDocker.calls.filter((call) => call[0] === "run").length;

		try {
			await withApp(
				async (app) => {
					await login(app, "alice");
					const workspace = workspaceBySlug(app, "alice");
					const name = codeContainerName(workspace.id);
					const start = Date.now();

					setSystemTime(start);
					await app.containers.ensureCodeContainer(workspace);
					expect(runs()).toBe(1);

					// `docker compose pull` while the control plane keeps running.
					fakeDocker.image.id = "sha256:pulled";
					await app.containers.ensureCodeContainer(workspace);
					expect(runs()).toBe(1);

					setSystemTime(start + 11_000);
					const status = await app.containers.ensureCodeContainer(workspace);
					expect(status.state).toBe("running");
					expect(runs()).toBe(2);
					expect(fakeDocker.containers.get(name)?.image).toBe("sha256:pulled");

					// The replacement matches the tag, so it is adopted from now on.
					setSystemTime(start + 22_000);
					await app.containers.ensureCodeContainer(workspace);
					expect(runs()).toBe(2);
				},
				{
					dockerRunner: fakeDocker.runner,
					codeImage: "coderunner-workspace:test",
					simPortRange: { start: 25842, end: 25843 },
					vscodePortRange: { start: 33062, end: 33063 },
					halsimPortRange: { start: 34062, end: 34063 },
				},
			);
		} finally {
			setSystemTime();
		}
	});

	test("lease row exists but container is missing triggers recreation", async () => {
		const fakeDocker = createFakeDocker();

		await withApp(
			async (app) => {
				await login(app, "alice");
				const workspace = workspaceBySlug(app, "alice");
				const name = codeContainerName(workspace.id);

				// Create a lease row without a matching Docker container
				app.storage.upsertCodeContainerLease({
					workspaceId: workspace.id,
					containerName: name,
					simPort: 25836,
					vscodePort: 33056,
					halsimPort: 34056,
					state: "running",
				});

				// ensureCodeContainer should detect the missing container and recreate
				const status = await app.containers.ensureCodeContainer(workspace);
				expect(status.state).toBe("running");
				const runCalls = fakeDocker.calls.filter((call) => call[0] === "run");
				expect(runCalls.length).toBe(1);
				expect(fakeDocker.containers.has(name)).toBe(true);
			},
			{
				dockerRunner: fakeDocker.runner,
				codeImage: "coderunner-workspace:test",
				simPortRange: { start: 25836, end: 25837 },
				vscodePortRange: { start: 33056, end: 33057 },
				halsimPortRange: { start: 34056, end: 34057 },
			},
		);
	});

	test("idle teardown followed by reload preserves vscode user data directory", async () => {
		const fakeDocker = createFakeDocker();
		await withApp(
			async (app) => {
				await login(app, "alice");
				const workspace = workspaceBySlug(app, "alice");

				await app.containers.ensureCodeContainer(workspace);
				expect(
					fakeDocker.containers.get(codeContainerName(workspace.id))?.running,
				).toBe(true);

				// Write a file into the home directory (simulating vscode user data)
				const homePath = join(
					app.storage.config.dataDir,
					"users",
					workspace.id,
					"home",
				);
				await mkdir(join(homePath, "data", "User"), { recursive: true });
				await writeFile(
					join(homePath, "data", "User", "settings.json"),
					'{"editor.fontSize": 16}',
					"utf8",
				);

				// Idle teardown
				await app.containers.stopWorkspaceContainers(workspace.id);
				await app.containers.removeCodeContainer(workspace.id);
				expect(fakeDocker.containers.has(codeContainerName(workspace.id))).toBe(
					false,
				);

				// Reload creates new container
				await app.containers.ensureCodeContainer(workspace);
				expect(fakeDocker.containers.has(codeContainerName(workspace.id))).toBe(
					true,
				);

				// User data should persist on the host (bind-mounted home)
				const settingsContent = await readFile(
					join(homePath, "data", "User", "settings.json"),
					"utf8",
				);
				expect(settingsContent).toContain("editor.fontSize");
			},
			{
				dockerRunner: fakeDocker.runner,
				codeImage: "coderunner-workspace:test",
				simPortRange: { start: 25838, end: 25839 },
				vscodePortRange: { start: 33058, end: 33059 },
			},
		);
	});
});
