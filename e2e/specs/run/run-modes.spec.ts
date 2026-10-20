/**
 * The Start split button's menu picks the run mode; clicking Start sends it.
 */
import { expect, test } from "../../fixtures/app";
import { loginAs } from "../../fixtures/auth";
import {
	seedRuntimeRunning,
	seedWorkspaceProject,
} from "../../fixtures/runtime";
import { WorkspacePage } from "../../page-objects/workspace.po";

for (const mode of ["Debug", "Build"] as const) {
	test(`Start menu → ${mode}, then Start, posts mode ${mode.toLowerCase()}`, async ({
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
		await page.getByRole("menuitemradio", { name: mode }).click();
		await expect(page.getByTestId("run-button")).toHaveText(mode);
		await page.getByTestId("run-button").click();
		expect((await request).postDataJSON()).toEqual({
			action: "start",
			mode: mode.toLowerCase(),
		});
		await wsp.stopRun();
	});
}
