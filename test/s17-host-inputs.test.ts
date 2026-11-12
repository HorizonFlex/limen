// S17 · A host job's inputs: the coordinator names what the job reads, Limen packs exactly that, and the job finds it
// in LIMEN_INPUTS; what it leaves in LIMEN_OUTPUTS comes home.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { packInputs, recordedInputs, validateInputs } from "../src/runtime/host-inputs.ts";
import { bundleScript, launchScript, type RemoteHost } from "../src/runtime/host-shell.ts";

const remote: RemoteHost = {
	alias: "mbp",
	ssh: "mbp",
	platform: "darwin",
	root: "/repo",
	shorthand: "/repo",
	clones: [],
	hook: "/hook",
	maxConcurrent: 2,
	enabled: true,
	distro: "Ubuntu",
	path: "",
	model: "",
};

async function scratch(): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "limen-inputs-"));
	await mkdir(join(root, "a", "deep"), { recursive: true });
	await writeFile(join(root, "a", "deep", "note.txt"), "alpha\n");
	await writeFile(join(root, "b.txt"), "beta\n");
	return root;
}

test("--input needs a host, an existing path, and distinct names", async () => {
	const root = await scratch();
	await assert.rejects(validateInputs([join(root, "a")], undefined, root), /needs --host/);
	await assert.rejects(validateInputs([join(root, "missing")], "mbp", root), /does not exist/);
	await mkdir(join(root, "other", "a"), { recursive: true });
	await assert.rejects(validateInputs([join(root, "a"), join(root, "other", "a")], "mbp", root), /two paths called a/);
	assert.deepEqual(await validateInputs([], undefined, root), []);
	assert.deepEqual(await validateInputs(["a", join(root, "b.txt")], "mbp", root), [
		join(root, "a"),
		join(root, "b.txt"),
	]);
});

test("the packed inputs land under their own names, and a linked folder is sent as what it points to", async () => {
	const root = await scratch();
	const link = join(root, "linked");
	await symlink(join(root, "a"), link);
	const tar = packInputs([link, join(root, "b.txt")]);
	assert.ok(tar);
	const out = await mkdtemp(join(tmpdir(), "limen-inputs-out-"));
	assert.equal(spawnSync("tar", ["-xf", "-", "-C", out], { input: tar }).status, 0);
	assert.equal(readFileSync(join(out, "linked", "deep", "note.txt"), "utf8"), "alpha\n");
	assert.equal(readFileSync(join(out, "b.txt"), "utf8"), "beta\n");
	assert.equal(packInputs([]), undefined);
});

test("a job records its inputs in a file the next start reads again", async () => {
	const dir = await mkdtemp(join(tmpdir(), "limen-job-"));
	assert.deepEqual(recordedInputs(dir), []);
	await writeFile(join(dir, "inputs"), "/seat/a\n/seat/b.txt\n");
	assert.deepEqual(recordedInputs(dir), ["/seat/a", "/seat/b.txt"]);
	assert.ok(!existsSync(join(dir, "outputs")));
});

test("the host job gets LIMEN_INPUTS and LIMEN_OUTPUTS, and the bundle brings outputs home", () => {
	const script = launchScript({
		host: remote,
		jobId: "job-1",
		branch: "limen/job-1",
		label: "x",
		piArgs: ["--approve"],
		bridged: false,
		task: "t\n",
	});
	assert.match(script, /export LIMEN_INPUTS="\$jobdir\/inputs"/);
	assert.match(script, /export LIMEN_OUTPUTS="\$jobdir\/outputs"/);
	assert.match(script, /mkdir -p [^\n]*"\$jobdir\/outputs"/);
	const bundle = bundleScript(remote, "job-1");
	assert.match(bundle, /for name in [^\n]*\boutputs\b/);
	assert.match(bundle, /outputs over 32 MB not copied/);
});
