// A host job's GitHub token lasts an hour; the seat renews it while the job runs and the host reads it on every use.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ghPath, loadGithub } from "../src/runtime/host-shell.ts";
import { keepGithubFresh } from "../src/runtime/remote-job.ts";

function credential(jobId: string): string {
	const script = `${loadGithub(jobId, undefined)}\nprintf 'protocol=https\\nhost=github.com\\n\\n' | git credential fill`;
	const run = spawnSync("bash", ["-c", script], {
		encoding: "utf8",
		env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
	});
	return run.stdout;
}

test("the host credential helper reads the token file on every use, and the file stays until cleanup", async () => {
	const id = `tok-${process.pid}-${Date.now()}`;
	const file = ghPath(id);
	try {
		await writeFile(file, "first-token-value\n");
		assert.match(credential(id), /password=first-token-value/);
		await writeFile(file, "second-token-value\n");
		assert.match(credential(id), /password=second-token-value/);
		assert.equal(existsSync(file), true);
	} finally {
		await rm(file, { force: true });
	}
});

test("the seat renews the token while the job runs, keeps it out of the log, and stops when asked", async () => {
	const jobDir = await mkdtemp(join(tmpdir(), "limen-refresh-"));
	const sent: string[] = [];
	const secrets: string[] = ["first"];
	let n = 0;
	const stop = keepGithubFresh({ jobDir, jobId: "job-1", host: {} as never }, "o/r", secrets, {
		mint: async () => (n++ === 1 ? { detail: "broker down" } : { token: `token-${n}`, detail: "" }),
		send: async (script) => {
			sent.push(script);
			return 0;
		},
		everyMs: 20,
	});
	await new Promise((resolve) => setTimeout(resolve, 150));
	stop();
	const count = sent.length;
	await new Promise((resolve) => setTimeout(resolve, 60));
	assert.equal(sent.length, count, "no refresh after stop");
	assert.ok(count >= 2);
	assert.match(sent[0] ?? "", /token-1/);
	assert.ok(secrets.some((secret) => secret.startsWith("token-")));
	const log = await readFile(join(jobDir, "log"), "utf8").catch(() => "");
	assert.match(log, /refreshed/);
	assert.match(log, /not refreshed: broker down/);
	assert.equal(log.includes("token-"), false);
});
