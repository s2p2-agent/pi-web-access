import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const moduleUrl = new URL("../zai.ts", import.meta.url).href;

function runInIsolation(home, extraEnv = {}) {
	const env = { ...process.env, HOME: home, USERPROFILE: home, ...extraEnv };
	delete env.ZAI_API_KEY;
	Object.assign(env, extraEnv);

	return spawnSync(process.execPath, ["--import", "tsx/esm", "--input-type=module"], {
		input: `
			const { resolveZaiApiKey } = await import(${JSON.stringify(moduleUrl)});
			const key = await resolveZaiApiKey();
			console.log(JSON.stringify({ key }));
		`,
		encoding: "utf8",
		env,
	});
}

test("z.ai returns null key when no key configured", async () => {
	const home = await mkdtemp(join(tmpdir(), "pi-zai-test-"));
	await mkdir(join(home, ".pi"), { recursive: true });
	await writeFile(join(home, ".pi", "web-search.json"), "{}\n", "utf8");

	const child = runInIsolation(home);
	assert.equal(child.status, 0, child.stderr);

	const result = JSON.parse(child.stdout.trim());
	assert.equal(result.key, null);
});

test("z.ai resolves key from ZAI_API_KEY env var", async () => {
	const home = await mkdtemp(join(tmpdir(), "pi-zai-test-env-"));
	await mkdir(join(home, ".pi"), { recursive: true });
	await writeFile(join(home, ".pi", "web-search.json"), "{}\n", "utf8");

	const child = runInIsolation(home, { ZAI_API_KEY: "test-zai-key-123" });
	assert.equal(child.status, 0, child.stderr);

	const result = JSON.parse(child.stdout.trim());
	assert.equal(result.key, "test-zai-key-123");
});

test("z.ai resolves key from config file zaiApiKey", async () => {
	const home = await mkdtemp(join(tmpdir(), "pi-zai-test-cfg-"));
	await mkdir(join(home, ".pi"), { recursive: true });
	await writeFile(
		join(home, ".pi", "web-search.json"),
		JSON.stringify({ zaiApiKey: "config-zai-key-456" }) + "\n",
		"utf8",
	);

	const child = runInIsolation(home);
	assert.equal(child.status, 0, child.stderr);

	const result = JSON.parse(child.stdout.trim());
	assert.equal(result.key, "config-zai-key-456");
});

test("config file key is used when no env var set", async () => {
	const home = await mkdtemp(join(tmpdir(), "pi-zai-test-precedence-"));
	await mkdir(join(home, ".pi"), { recursive: true });
	await writeFile(
		join(home, ".pi", "web-search.json"),
		JSON.stringify({ zaiApiKey: "config-key" }) + "\n",
		"utf8",
	);

	const child = runInIsolation(home);
	assert.equal(child.status, 0, child.stderr);

	const result = JSON.parse(child.stdout.trim());
	assert.equal(result.key, "config-key");
});

test("isZaiAvailable returns false when no key configured", async () => {
	const home = await mkdtemp(join(tmpdir(), "pi-zai-test-avail-"));
	await mkdir(join(home, ".pi"), { recursive: true });
	await writeFile(join(home, ".pi", "web-search.json"), "{}\n", "utf8");

	const env = { ...process.env, HOME: home, USERPROFILE: home };
	delete env.ZAI_API_KEY;

	const child = spawnSync(process.execPath, ["--import", "tsx/esm", "--input-type=module"], {
		input: `
			const { isZaiAvailable, resolveZaiApiKey } = await import(${JSON.stringify(moduleUrl)});
			await resolveZaiApiKey();
			console.log(JSON.stringify({ available: isZaiAvailable() }));
		`,
		encoding: "utf8",
		env,
	});

	assert.equal(child.status, 0, child.stderr);
	const result = JSON.parse(child.stdout.trim());
	assert.equal(result.available, false);
});

test("isZaiAvailable returns true when key in config", async () => {
	const home = await mkdtemp(join(tmpdir(), "pi-zai-test-avail-cfg-"));
	await mkdir(join(home, ".pi"), { recursive: true });
	await writeFile(
		join(home, ".pi", "web-search.json"),
		JSON.stringify({ zaiApiKey: "cfg-key" }) + "\n",
		"utf8",
	);

	const env = { ...process.env, HOME: home, USERPROFILE: home };
	delete env.ZAI_API_KEY;

	const child = spawnSync(process.execPath, ["--import", "tsx/esm", "--input-type=module"], {
		input: `
			const { isZaiAvailable } = await import(${JSON.stringify(moduleUrl)});
			console.log(JSON.stringify({ available: isZaiAvailable() }));
		`,
		encoding: "utf8",
		env,
	});

	assert.equal(child.status, 0, child.stderr);
	const result = JSON.parse(child.stdout.trim());
	assert.equal(result.available, true);
});
