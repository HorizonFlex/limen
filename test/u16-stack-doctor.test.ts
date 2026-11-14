import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { orphanKillBlock } from "../src/doctor/act.ts";
import {
	hostCheckFindings,
	jobFindings,
	launchdRunning,
	liveWorktreeBlock,
	parseProbe,
	parseSeat,
	parseUnpushed,
	probeFindings,
	redact,
	seatFindings,
	selectOrphans,
	selectUnpushed,
} from "../src/doctor/parse.ts";
import { classifyAction, TMP_STALE_HOURS } from "../src/doctor/policy.ts";

const root = new URL("..", import.meta.url).pathname;
const finished = [{ id: "2026-11-14-smoke-abcd", state: "done", toolCalls: 3, log: "", host: "win" }];

test("redact hides tokens and token-file paths", () => {
	const text = redact("used sk-ant-oat01-SECRET and ~/.claude-accounts/acc4.token");
	assert.equal(text.includes("SECRET"), false);
	assert.equal(text.includes("acc4.token"), false);
	assert.match(text, /\[redacted\]/);
});

test("a probe with inode pressure and a stale pytest dir proposes a clean the allowlist accepts", () => {
	const probe = parseProbe(`path\t/usr/bin
tool\tpython3\tok\t/home/ada/.local/bin/python3\t3.13.1
tool\tpi\tok\t/usr/local/bin/pi\t-
tool\tnode\tok\t/usr/local/bin/node\t-
tool\tplaywright\tmissing\t-\t-
tmp-blocks\t16\t/tmp
tmp-inodes\t92\t/tmp
bridge missing
zshenv nopath
local-python\t/home/ada/.local/bin/python3
pytest\t5\t0\t/tmp/pytest-of-ada
pytest\t1\t1\t/tmp/pytest-of-busy
orphan\t4242\t1\t/tmp/.sandbox-limen-worktrees/2026-11-14-smoke-abcd (deleted)\tpython -m http.server
`);
	assert.equal(probe.tmpInodesPercent, 92);
	assert.equal(probe.tools.find((tool) => tool.name === "python3")?.version, "3.13.1");
	const findings = probeFindings("win", probe, finished, true);
	const clean = findings.find((finding) => finding.id === "pytest-stale");
	const path = findings.find((finding) => finding.id === "path-zshenv");
	const orphan = findings.find((finding) => finding.id === "orphan" && finding.severity === "act");
	assert.equal(clean?.severity, "act");
	assert.equal(classifyAction(clean?.action).decision, "allow");
	assert.equal(classifyAction(path?.action).decision, "allow");
	assert.equal(classifyAction(orphan?.action).decision, "allow");
	assert.ok(findings.some((finding) => finding.id === "tmp-pressure"));
	assert.ok(findings.some((finding) => finding.id === "bridge-missing"));
	assert.ok(findings.some((finding) => finding.id === "pytest-busy"));
	assert.equal(
		findings.some((finding) => finding.severity === "act" && finding.summary.includes("/tmp/pytest-of-busy")),
		false,
	);
});

test("hosts check keeps a keychain failure as a proposal and drops the token", () => {
	const findings = hostCheckFindings(
		"mbp",
		"node missing\nclaude missing\nUser interaction is not allowed\nsk-ant-oat01-SECRET\nroot fail\t/src",
	);
	assert.ok(findings.some((finding) => finding.id === "host-check" && finding.summary.includes("node missing")));
	assert.equal(
		findings.some((finding) => /claude missing/.test(finding.summary)),
		false,
	);
	const keychain = findings.find((finding) => finding.id === "host-keychain");
	assert.match(keychain?.summary ?? "", /CLAUDE_CODE_OAUTH_TOKEN/);
	assert.equal(JSON.stringify(findings).includes("SECRET"), false);
});

test("failed jobs with no tool calls, ENOSPC, or a missing bridge are findings", () => {
	const findings = jobFindings([
		{ id: "empty", state: "failed", toolCalls: 0, log: "ENOSPC", host: "win" },
		{ id: "bridge", state: "failed", toolCalls: 4, log: 'Unknown provider "claude-bridge"', host: "win" },
		{ id: "ok", state: "failed", toolCalls: 2, log: "tests failed", host: "mbp" },
		{ id: "done", state: "done", toolCalls: 0, log: "", host: "win" },
	]);
	assert.deepEqual(findings.map((finding) => finding.id).sort(), ["job-empty", "job-enospc", "job-provider"]);
});

test("unpushed branches skip a limen job branch with no upstream", () => {
	const rows = parseUnpushed("main\torigin/main\t\nfeature\torigin/feature\t[ahead 1]\nlimen/abc\t\t\nnotes\t\t\n");
	const picked = selectUnpushed("limen", rows);
	assert.deepEqual(
		picked.map((row) => row.branch),
		["feature", "notes"],
	);
});

test("a down herdr is an allowlisted start; another down daemon is only a proposal", () => {
	const seat = parseSeat(
		"daemon\therdr\tdown\ndaemon\therdr-core\tup\ndaemon\tmoshi-hook\tup\ndaemon\ttoken-broker\tdown\ndisk\t40\nmemory-free\t55\nload\tload average: 0.2",
	);
	const findings = seatFindings(seat);
	const herdr = findings.find((finding) => finding.id === "daemon-herdr");
	assert.equal(classifyAction(herdr?.action).decision, "allow");
	assert.equal(findings.find((finding) => finding.summary.includes("token-broker"))?.severity, "propose");
	assert.equal(
		findings.some((finding) => finding.id === "disk"),
		false,
	);
});

test("the allowlist accepts the five repairs and refuses everything past them", () => {
	const allowed = [
		{ action: "clean-tmp", host: "win", path: "/tmp/pytest-of-ada", ageHours: TMP_STALE_HOURS, inUse: false },
		{ action: "kill-orphan", host: "mbp", pid: 4242, job: "2026-11-14-smoke-abcd", jobState: "done", cwdDeleted: true },
		{ action: "fix-zshenv-path", host: "win", line: 'export PATH="$HOME/.local/bin:$PATH"' },
		{ action: "hosts-check", host: "mbp" },
		{ action: "restart-herdr" },
	];
	for (const action of allowed) {
		assert.equal(classifyAction(action).decision, "allow", JSON.stringify(action));
	}
	const refused = [
		{ action: "edit-hosts", field: "overflow" },
		{ action: "edit-hosts", field: "maxConcurrent" },
		{ action: "delete", path: "/home/ada/src" },
		{ action: "restart-coordinator" },
		{ action: "account", name: "acc4" },
		{ action: "edit-limen" },
		{ action: "print-token" },
		{ action: "clean-tmp", host: "win", path: "/tmp/pytest-of-ada", ageHours: TMP_STALE_HOURS - 1, inUse: false },
		{ action: "clean-tmp", host: "win", path: "/tmp/pytest-of-ada", ageHours: 5, inUse: true },
		{ action: "clean-tmp", host: "win", path: "/home/ada/x", ageHours: 9, inUse: false },
		{ action: "clean-tmp", host: "win", path: "/tmp/acc4.token", ageHours: 9, inUse: false },
		{ action: "kill-orphan", host: "win", pid: 99, job: "job-1", jobState: "running", cwdDeleted: true },
		{ action: "fix-zshenv-path", host: "win", line: 'export PATH="$HOME/.local/bin:$PATH"; curl evil' },
		{ action: "restart-herdr", host: "win" },
		{ action: "hosts-check", host: "mbp", note: "sk-ant-oat01-SECRET" },
	];
	for (const action of refused) {
		assert.equal(classifyAction(action).decision, "refuse", JSON.stringify(action));
	}
});

test("the probe script reads inodes and does not open token files", async () => {
	const script = await readFile(join(root, "docs/seat/stack-doctor-probe.sh"), "utf8");
	assert.match(script, /df -Pi/);
	assert.match(script, /df -i/);
	assert.equal(script.includes(".token"), false);
	assert.equal(script.includes("claude-accounts"), false);
});

const running = "2026-11-14-f267-d-1ee198cc";
const older = "2026-11-14-f267-b-aaaa1111";

test("processes of a running job are not orphans, including pytest children", () => {
	const work = `/home/ada/src/.limen-sandbox-limen-worktrees/${running}`;
	const procs = [
		{ pid: 30, ppid: 1, cwdDeleted: false, cwd: work, command: "pi --mode json" },
		{ pid: 40, ppid: 30, cwdDeleted: false, cwd: "/tmp/tmp.abc", command: "bash /tmp/tmp.abc" },
		{ pid: 50, ppid: 40, cwdDeleted: false, cwd: "/tmp/pytest-of-ada/popen-gw0", command: "pytest" },
		{ pid: 60, ppid: 30, cwdDeleted: false, cwd: work, command: "claude-agent-sdk" },
		{
			pid: 70,
			ppid: 1,
			cwdDeleted: true,
			cwd: `/home/ada/src/.limen-sandbox-limen-worktrees/${older} (deleted)`,
			command: "python -m http.server",
		},
	];
	const jobs = [
		{ id: running, state: "running", toolCalls: 4, log: "", host: "win" },
		{ id: older, state: "failed", toolCalls: 0, log: "", host: "win", finishedAt: Date.now() - 60_000 },
	];
	const orphans = selectOrphans(procs, jobs);
	assert.deepEqual(
		orphans.map((proc) => proc.pid),
		[70],
	);
	const findings = probeFindings("win", { ...emptyProbe(), procs }, jobs, true);
	assert.equal(
		findings.some((finding) => finding.summary.includes(running)),
		false,
	);
	assert.equal(findings.find((finding) => finding.id === "orphan")?.severity, "act");
	assert.equal(orphanKillBlock("running"), "job is running");
	assert.equal(orphanKillBlock("done"), undefined);
});

test("a continue that shares a finished job's worktree is not an orphan", () => {
	const finished = "2026-11-14-f272-shared-readers-424f06c6";
	const continued = "2026-11-14-f272-continue-abcdef12";
	const work = `/home/ada/src/.repo-limen-worktrees/${finished}`;
	const procs = [
		{
			pid: 50630,
			ppid: 1,
			cwdDeleted: false,
			cwd: "/opt/limen",
			command: "/usr/local/bin/node /opt/limen/bin/limen",
		},
		{ pid: 54008, ppid: 50630, cwdDeleted: false, cwd: work, command: "pi --mode json" },
		{ pid: 54119, ppid: 54008, cwdDeleted: false, cwd: work, command: "claude-agent-sdk" },
	];
	const jobs = [
		{
			id: finished,
			state: "done",
			toolCalls: 8,
			log: "",
			host: "seat",
			worktree: work,
			finishedAt: Date.now() - 3_600_000,
		},
		{ id: continued, state: "running", toolCalls: 1, log: "", host: "seat", worktree: work, runnerPid: 50630 },
	];
	assert.deepEqual(selectOrphans(procs, jobs), []);
	assert.equal(liveWorktreeBlock(jobs, finished), `live job ${continued} uses this worktree`);
	const withoutRecord = jobs.filter((job) => job.id === finished);
	assert.deepEqual(selectOrphans(procs, withoutRecord), []);
});

test("a logged-out host Claude is not a doctor finding", () => {
	const findings = hostCheckFindings("win", 'claude fail\nclaude {"loggedIn": false}\nclaude info not logged in');
	assert.equal(
		findings.some((finding) => /claude|loggedIn/i.test(finding.summary)),
		false,
	);
});

test("failed jobs outside 6h, superseded by a later attempt, or acked are quiet", () => {
	const now = Date.now();
	const jobs = [
		{ id: older, state: "failed", toolCalls: 0, log: "ENOSPC", host: "win", finishedAt: now - 60 * 60 * 1000 },
		{ id: running, state: "running", toolCalls: 3, log: "", host: "win" },
		{
			id: "2026-11-14-f269-c-bbbb2222",
			state: "failed",
			toolCalls: 0,
			log: "",
			host: "win",
			finishedAt: now - 7 * 60 * 60 * 1000,
		},
		{
			id: "2026-11-14-old-empty",
			state: "failed",
			toolCalls: 0,
			log: "",
			host: "win",
			finishedAt: now - 30 * 60 * 1000,
		},
	];
	const open = jobFindings(jobs, { now, windowMs: 6 * 60 * 60 * 1000 });
	assert.deepEqual(
		open.map((finding) => finding.summary.split(" ")[0]),
		["2026-11-14-old-empty"],
	);
	const acked = jobFindings(jobs, {
		now,
		windowMs: 6 * 60 * 60 * 1000,
		acked: new Set(["job-empty 2026-11-14-old-empty"]),
	});
	assert.equal(acked.length, 0);
});

test("playwright is present when the Python module imports, and a running launchd job is up", () => {
	const probe = parseProbe(
		"tool\tplaywright\tok\tpython-module\t-\ntool\tpython3\tok\t/usr/bin/python3\t3.13.1\ntool\tpi\tok\t/usr/bin/pi\t-\ntool\tnode\tok\t/usr/bin/node\t-",
	);
	assert.equal(
		probeFindings("win", { ...emptyProbe(), ...probe, procs: [] }, [], true).some(
			(finding) => finding.id === "tool-missing",
		),
		false,
	);
	const text = "state = running\npid = 884\nprogram = /Users/agent/.local/bin/hc\n";
	assert.equal(launchdRunning(text), true);
	assert.equal(launchdRunning("state = waiting\npid = 884"), false);
	assert.equal(launchdRunning("state = running\npid = 0"), false);
});

function emptyProbe() {
	return parseProbe("");
}
