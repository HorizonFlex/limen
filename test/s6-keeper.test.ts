// S6 · Spec keeper. One plant: ticket numbers, place ids, the keeper's start rules and ticket-author path
// resolution, all through the real CLI. The strict ticket gate is s5's land refusal and u1's diagnostics.
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { mkdir, symlink } from "node:fs/promises";
import { dirname, join } from "node:path";
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

test("ticket new refuses an unknown place id, cuts the slug at a word to 60 characters, and numbers past every ref", () => {
	const before = lane("planned");
	const refused = limen(p, ["ticket", "new", "y", "--touches", "nope"]);
	assert.match(`${refused.status} ${refused.stderr}`, /^1 .*nope/s);
	assert.deepEqual(lane("planned"), before);
	const ticket = (title: string, cwd = p.root, ...flags: string[]) => {
		const made = limen(p, ["ticket", "new", title, ...flags], { cwd });
		const text = readFileSync(join(cwd, made.stdout.trim()), "utf8");
		assert.match(text, new RegExp(`^# F\\d+ · ${title}$`, "m"), made.stderr);
		return { folder: dirname(made.stdout), number: Number(/\/F(\d+)-/.exec(made.stdout)?.[1]) };
	};
	// Past folders, limen branch names and job labels.
	assert.equal(ticket("x", p.root, "--touches", "demo.place").folder, "spec/features/planned/F010-x");
	// A cut at 60 would end mid-word; a boundary right after character 60 keeps all 60; one long word is cut at 60.
	const slug = (title: string) => ticket(title).folder.replace(/^.*\/F\d+-/, "");
	assert.equal(slug("seventh ".repeat(8).trim()), "seventh-".repeat(7).slice(0, -1));
	assert.equal(slug(`${"a".repeat(29)} ${"b".repeat(30)} c`), `${"a".repeat(29)}-${"b".repeat(30)}`);
	assert.equal(slug(`${"z".repeat(80)} tail`), "z".repeat(60));
	// The first ticket's folder lives only on a remote's ref, the second only on a local branch.
	const [one, two] = [join(p.parent, "tree-one"), join(p.parent, "tree-two")];
	git(p.root, "worktree", "add", "-q", "--detach", one, "main");
	git(p.root, "worktree", "add", "-q", "-b", "ticket-two", two, "main");
	const first = ticket("first", one).number;
	git(one, "add", "spec");
	git(one, "commit", "-q", "-m", "first ticket");
	git(one, "update-ref", "refs/remotes/origin/one", "HEAD");
	assert.equal(ticket("second", two).number, first + 1);
	git(two, "add", "spec");
	git(two, "commit", "-q", "-m", "second ticket");
	assert.equal(ticket("third", one).number, first + 2);
});

test("picture build --dir takes a plant root from any folder and stops on a folder with no map", () => {
	const built = limen(p, ["picture", "build", "--strict", "--dir", p.root], { cwd: p.parent });
	assert.match(`${built.status} ${built.stdout}`, /^0 picture: [1-9]\d* places/, built.stderr);
	const { status, stderr } = limen(p, ["picture", "build", "--dir", p.bin]);
	assert.match(`${status} ${stderr}`, /^1 \S+\/bin has no plant file .+ no map yet in \S+\/bin\/\.limen\/picture\./);
});

test("keeper refuses a running job, then starts on a new branch at the candidate tip", async () => {
	const refused = limen(p, ["keeper", TICKET, "--job", worker, ...ROUTE]);
	assert.match(`${refused.status} ${refused.stderr}`, new RegExp(`^1 .*${worker}`, "s"));
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
	assert.match(`${again.status} ${again.stderr}`, new RegExp(`^1 .*${keeperBranch}`, "s"));
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
		assert.deepEqual([result.status, result.stdout], [1, ""], path);
	}
});
