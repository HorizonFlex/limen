import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import {
	hostCheckFindings,
	jobFindings,
	parseProbe,
	parseSeat,
	parseUnpushed,
	probeFindings,
	redact,
	seatFindings,
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
