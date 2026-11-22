// S6 · Spec keeper. One plant: ticket numbers, place ids, the keeper's start rules and ticket-author path
// resolution, all through the real CLI. The strict ticket gate is s5's land refusal and u1's diagnostics.
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { mkdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { after, test } from "node:test";
import { git, jobDir, jobFile, limen, plant, release, spawnJob, TICKET, waitJob } from "./plant.ts";

const p = await plant();
after(p.cleanup);
const ROUTE = ["--engine", "omp", "--provider", "p", "--model", "m", "--thinking", "high"];
const lane = (name: string) =>
	existsSync(join(p.root, "spec/features", name)) ? readdirSync(join(p.root, "spec/features", name)) : [];

// The F009 job stays running until the keeper refusal below has been seen.
await mkdir(join(p.root, "spec/features/done/2026-09/F004-x"), { recursive: true });
git(p.root, "branch", "limen/f007-y");
const worker = spawnJob(p, "block\ncommit", ["--label", "F009 keeper proof"]);

test("ticket new refuses an unknown place id before any file exists, then takes the number past folders, limen branches and job labels", () => {
	const before = lane("planned");
	const refused = limen(p, ["ticket", "new", "y", "--touches", "nope"]);
	assert.match(`${refused.status} ${refused.stderr}`, /^1 .*nope/s);
	assert.deepEqual(lane("planned"), before);
	const made = limen(p, ["ticket", "new", "x", "--touches", "demo.place"]);
	assert.equal(made.stdout, "spec/features/planned/F010-x/ticket.md\n", made.stderr);
	assert.ok(existsSync(join(p.root, made.stdout.trim())));
});

test("ticket new cuts the folder slug at a word boundary to at most 60 characters and keeps the whole title", () => {
	const cases = [
		// Eight 7-letter words make 63 characters: the cut keeps seven words, not 60 characters that end mid-word.
		[Array.from({ length: 8 }, () => "seventh").join(" "), Array.from({ length: 7 }, () => "seventh").join("-")],
		// The boundary right after character 60 keeps all 60.
		[`${"a".repeat(29)} ${"b".repeat(30)} c`, `${"a".repeat(29)}-${"b".repeat(30)}`],
		// A first word over 60 characters is cut at 60.
		[`${"z".repeat(80)} tail`, "z".repeat(60)],
	] as const;
	for (const [title, slug] of cases) {
		const made = limen(p, ["ticket", "new", title]);
		assert.equal(made.status, 0, made.stderr);
		const folder = made.stdout.trim().split("/").at(-2) ?? "";
		assert.equal(folder.replace(/^F\d+-/, ""), slug, title);
		assert.match(readFileSync(join(p.root, made.stdout.trim()), "utf8"), new RegExp(`^# F\\d+ · ${title}$`, "m"));
	}
});

test("ticket new takes the number past the ticket folders of every local branch and every remote ref", async () => {
	const number = (run: { stdout: string; stderr: string }) => Number(/\/F(\d+)-/.exec(run.stdout)?.[1] ?? run.stderr);
	const [one, two, far] = ["one", "two", "far"].map((name) => join(p.parent, `tree-${name}`));
	git(p.root, "worktree", "add", "-q", "-b", "ticket-one", one, "main");
	git(p.root, "worktree", "add", "-q", "-b", "ticket-two", two, "main");
	git(p.root, "worktree", "add", "-q", "--detach", far, "main");
	const first = limen(p, ["ticket", "new", "first branch"], { cwd: one });
	git(one, "add", "spec/features");
	git(one, "commit", "-q", "-m", "first ticket");
	const second = limen(p, ["ticket", "new", "second branch"], { cwd: two });
	assert.equal(number(second), number(first) + 1, `${first.stdout} ${second.stdout}`);
	// A ticket that exists only on a remote's ref still takes its number.
	await mkdir(join(far, "spec/features/planned/F090-far"), { recursive: true });
	await writeFile(join(far, "spec/features/planned/F090-far/ticket.md"), "# F090 · far\n");
	git(far, "add", "spec/features");
	git(far, "commit", "-q", "-m", "far ticket");
	git(far, "update-ref", "refs/remotes/origin/far", "HEAD");
	git(p.root, "worktree", "remove", "--force", far);
	assert.equal(number(limen(p, ["ticket", "new", "after remote"], { cwd: two })), 91);
});

test("picture build --dir takes a plant root from any folder and stops on a folder with no map", () => {
	const built = limen(p, ["picture", "build", "--strict", "--dir", p.root], { cwd: p.parent });
	assert.match(`${built.status} ${built.stdout}`, /^0 picture: [1-9]\d* places/, built.stderr);
	const { status, stderr } = limen(p, ["picture", "build", "--dir", p.bin]);
	assert.match(`${status} ${stderr}`, /^1 \S+\/bin has no plant file .+ no map yet in \S+\/bin\/\.limen\/picture\./);
});

test("keeper refuses a running job, then starts on a new branch at the candidate tip", async () => {
	const refused = limen(p, ["keeper", TICKET, "--job", worker, ...ROUTE]);
	assert.equal(refused.status, 1);
	assert.match(refused.stderr, new RegExp(worker));
	assert.deepEqual([git(p.root, "branch", "--list", "limen/keeper-*"), jobFile(p, worker, "state")], ["", "running"]);

	await release(jobDir(p, worker));
	assert.equal(waitJob(p, worker), "done");
	const branch = jobFile(p, worker, "branch");
	const tip = git(p.root, "rev-parse", branch);
	assert.notEqual(tip, git(p.root, "rev-parse", "main"));
	// The worker's task named the planned lane; the keeper follows the one F001 folder at the tip.
	const started = limen(p, ["keeper", "spec/features/planned/F001-demo/ticket.md", "--job", worker, ...ROUTE]);
	assert.equal(started.status, 0, started.stderr);
	const keeper = started.stdout.trim().split("\n").at(-1) ?? "";
	const keeperBranch = `limen/keeper-f001-${tip.slice(0, 7)}`;
	assert.deepEqual([jobFile(p, keeper, "branch"), jobFile(p, keeper, "base")], [keeperBranch, tip]);
	assert.ok(jobFile(p, keeper, "task.md").split("\n").includes(`Ticket: ${TICKET}`));
	assert.deepEqual([git(p.root, "rev-parse", branch), waitJob(p, keeper)], [tip, "done"]);
	const again = limen(p, ["keeper", TICKET, "--job", worker, ...ROUTE]);
	assert.equal(again.status, 1);
	assert.match(again.stderr, new RegExp(keeperBranch));
});

test("ticket-author resolves aliased paths and invents no author for others", async () => {
	const alias = join(p.parent, "alias");
	await symlink(p.root, alias, "dir");
	const commit = git(p.root, "log", "--format=%H", "--diff-filter=A", "--", TICKET);
	for (const [cwd, path] of [
		[p.root, join(alias, TICKET)],
		[join(alias, "spec/features/active"), "F001-demo/ticket.md"],
	] as const) {
		const found = limen(p, ["ticket-author", path], { cwd });
		assert.equal(found.status, 0, found.stderr);
		assert.ok(found.stdout.includes(commit), found.stdout);
	}
	for (const path of ["spec/features/planned/F010-x/ticket.md", "missing.md", "spec", "../outside.md"]) {
		const result = limen(p, ["ticket-author", path]);
		assert.equal(result.status, 1, path);
		assert.equal(result.stdout, "", path);
	}
});
