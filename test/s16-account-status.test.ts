// S16 · `limen accounts` asks the seat's own tool which Claude account is active and prints what it says.
import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { findStatusCommand, readAccountStatus } from "../src/runtime/account-status.ts";

async function script(dir: string, name: string, body: string): Promise<string> {
	const file = join(dir, name);
	await writeFile(file, `#!/bin/sh\n${body}\n`);
	await chmod(file, 0o755);
	return file;
}

test("a forced status tool is the only source, and a missing one is not replaced by a lookup", async () => {
	const dir = await mkdtemp(join(tmpdir(), "limen-acct-"));
	const tool = await script(dir, "report", "echo active: one");
	assert.deepEqual(findStatusCommand({ LIMEN_ACCOUNT_STATUS: tool, PATH: dir }, dir), { file: tool, args: [] });
	assert.equal(findStatusCommand({ LIMEN_ACCOUNT_STATUS: join(dir, "absent"), PATH: dir }, dir), undefined);
	await script(dir, "claude-account-rotate", "echo other");
	assert.equal(findStatusCommand({ LIMEN_ACCOUNT_STATUS: join(dir, "absent"), PATH: dir }, dir), undefined);
});

test("without a forced tool the rotator is found on PATH, then in the seat bin directory", async () => {
	const home = await mkdtemp(join(tmpdir(), "limen-acct-"));
	const onPath = await mkdtemp(join(tmpdir(), "limen-acct-"));
	assert.equal(findStatusCommand({ PATH: onPath }, home), undefined);
	await mkdir(join(home, "seat", "bin"), { recursive: true });
	const seat = await script(join(home, "seat", "bin"), "claude-account-rotate", "echo seat");
	assert.deepEqual(findStatusCommand({ PATH: onPath }, home), { file: seat, args: ["status"] });
	const first = await script(onPath, "claude-account-rotate", "echo path");
	assert.deepEqual(findStatusCommand({ PATH: onPath }, home), { file: first, args: ["status"] });
});

test("the report is passed through, and a failing tool reports its own output", async () => {
	const dir = await mkdtemp(join(tmpdir(), "limen-acct-"));
	const good = await script(dir, "good", "printf 'active: b\\n  a  spent until 01:20\\n'");
	const bad = await script(dir, "bad", "echo cannot read accounts >&2; exit 3");
	assert.deepEqual(await readAccountStatus({ file: good, args: [] }), {
		ok: true,
		text: "active: b\n  a  spent until 01:20",
	});
	assert.deepEqual(await readAccountStatus({ file: bad, args: [] }), { ok: false, text: "cannot read accounts" });
});
