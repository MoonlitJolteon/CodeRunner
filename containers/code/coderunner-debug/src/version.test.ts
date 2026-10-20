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
