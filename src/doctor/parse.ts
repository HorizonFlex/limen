import { classifyAction, TMP_STALE_HOURS } from "./policy.ts";

// Parsers for the read-only collector. They never shell out. Thresholds match the host tmp-guard (70%)
// and the seat start gate (20% memory free). A full disk is 90%, past which a job log is the first thing lost.

const TMP_PRESSURE = 70;
const DISK_PRESSURE = 90;
const MEMORY_FREE_MIN = 20;
const JOB_IN_CWD = /limen-worktrees\/([A-Za-z0-9][A-Za-z0-9._-]*)/;
const SECRET = /sk-ant-[A-Za-z0-9_-]+|\S+\.token\b/gi;

export type Severity = "act" | "propose";

export type Finding = {
	readonly id: string;
	readonly host: string;
	readonly severity: Severity;
	readonly summary: string;
	readonly action?: unknown;
};

export type ToolRow = { readonly name: string; readonly ok: boolean; readonly path: string; readonly version: string };

export type PytestDir = { readonly path: string; readonly ageHours: number; readonly inUse: boolean };

export type Orphan = {
	readonly pid: number;
	readonly cwdDeleted: boolean;
	readonly cwd: string;
	readonly command: string;
};

export type Probe = {
	readonly path: string;
	readonly tools: readonly ToolRow[];
	readonly tmpBlocksPercent: number | null;
	readonly tmpInodesPercent: number | null;
	readonly bridge: "present" | "missing" | "unknown";
	readonly zshenvHasPath: boolean;
	readonly localPython: string;
	readonly pytest: readonly PytestDir[];
	readonly orphans: readonly Orphan[];
};

export type JobSnap = {
	readonly id: string;
	readonly state: string;
	readonly toolCalls: number;
	readonly log: string;
	readonly host: string;
};

export type SeatSnap = {
	readonly daemons: readonly { readonly name: string; readonly up: boolean }[];
	readonly diskPercent: number | null;
	readonly memoryFree: number | null;
	readonly load: string;
};

export type Unpushed = { readonly project: string; readonly branch: string; readonly detail: string };

export type DoctorReport = {
	readonly at: string;
	readonly ok: boolean;
	readonly findings: readonly Finding[];
	readonly seat: SeatSnap & { readonly probe: Probe };
	readonly hosts: readonly { readonly alias: string; readonly check: readonly string[]; readonly probe: Probe }[];
	readonly accounts: string;
	readonly failedJobs: readonly JobSnap[];
	readonly unpushed: readonly Unpushed[];
};

export function redact(text: string): string {
	return text.replace(SECRET, "[redacted]");
}

type ProbeBuild = {
	path: string;
	tools: ToolRow[];
	pytest: PytestDir[];
	orphans: Orphan[];
	tmpBlocksPercent: number | null;
	tmpInodesPercent: number | null;
	bridge: Probe["bridge"];
	zshenvHasPath: boolean;
	localPython: string;
};

export function parseProbe(text: string): Probe {
	const build: ProbeBuild = {
		path: "",
		tools: [],
		pytest: [],
		orphans: [],
		tmpBlocksPercent: null,
		tmpInodesPercent: null,
		bridge: "unknown",
		zshenvHasPath: false,
		localPython: "",
	};
	for (const raw of text.split("\n")) {
		const line = raw.trim();
		if (line) {
			applyProbeLine(build, line);
		}
	}
	return build;
}

function applyProbeLine(build: ProbeBuild, line: string): void {
	const [kind, ...rest] = line.split("\t");
	if (kind === "path" || kind === "tool" || kind === "local-python") {
		applyToolLine(build, kind, rest);
		return;
	}
	if (kind === "pytest" || kind === "orphan") {
		applyProcessLine(build, kind, rest);
		return;
	}
	applyStatusLine(build, kind, rest, line);
}

function applyToolLine(build: ProbeBuild, kind: string | undefined, rest: string[]): void {
	if (kind === "path") {
		build.path = rest.join("\t");
	} else if (kind === "tool" && rest.length >= 4) {
		build.tools.push({ name: rest[0] ?? "", ok: rest[1] === "ok", path: rest[2] ?? "", version: rest[3] ?? "" });
	} else if (kind === "local-python" && rest[0] && rest[0] !== "missing") {
		build.localPython = rest[0];
	}
}

function applyProcessLine(build: ProbeBuild, kind: string | undefined, rest: string[]): void {
	if (kind === "pytest" && rest.length >= 3) {
		build.pytest.push({ ageHours: Number(rest[0]) || 0, inUse: rest[1] === "1", path: rest.slice(2).join("\t") });
		return;
	}
	if (kind !== "orphan" || rest.length < 4 || build.orphans.length >= 50) {
		return;
	}
	const pid = Number(rest[0]);
	if (Number.isInteger(pid) && pid > 1) {
		build.orphans.push({
			pid,
			cwdDeleted: rest[1] === "1",
			cwd: rest[2] ?? "",
			command: rest.slice(3).join("\t"),
		});
	}
}

function applyStatusLine(build: ProbeBuild, kind: string | undefined, rest: string[], line: string): void {
	if (kind === "tmp-blocks") {
		build.tmpBlocksPercent = numberOrNull(rest[0]);
	} else if (kind === "tmp-inodes") {
		build.tmpInodesPercent = numberOrNull(rest[0]);
	} else if (line === "bridge present" || line === "bridge missing") {
		build.bridge = line === "bridge present" ? "present" : "missing";
	} else if (line === "zshenv path") {
		build.zshenvHasPath = true;
	}
}

export function parseSeat(text: string): SeatSnap {
	const daemons: { name: string; up: boolean }[] = [];
	let diskPercent: number | null = null;
	let memoryFree: number | null = null;
	let load = "";
	for (const raw of text.split("\n")) {
		const line = raw.trim();
		const [kind, ...rest] = line.split("\t");
		if (kind === "daemon" && rest[0]) {
			daemons.push({ name: rest[0], up: rest[1] === "up" });
		} else if (kind === "disk") {
			diskPercent = numberOrNull(rest[0]);
		} else if (kind === "memory-free") {
			memoryFree = numberOrNull(rest[0]);
		} else if (kind === "load") {
			load = rest.join("\t");
		}
	}
	return { daemons, diskPercent, memoryFree, load };
}

/** Failures from `limen hosts check` text. A missing Claude login is not one: host jobs use the seat token. */
export function hostCheckFindings(host: string, text: string): Finding[] {
	const findings: Finding[] = [];
	let keychain = false;
	for (const raw of redact(text).split("\n")) {
		const line = raw.trim();
		if (!line) {
			continue;
		}
		if (/25308|User interaction is not allowed/i.test(line)) {
			keychain = true;
			continue;
		}
		if (/^claude\b/.test(line) || /\bclaude (?:missing|ok|fail)\b/.test(line)) {
			continue;
		}
		if (/root fail\b/.test(line) || /(?:node|pi|hook|git) (?:missing|fail)\b/.test(line)) {
			findings.push(propose("host-check", host, `${host}: ${line}`));
		}
	}
	if (keychain) {
		findings.push(
			propose(
				"host-keychain",
				host,
				`${host}: locked keychain; host jobs use the seat Claude token via CLAUDE_CODE_OAUTH_TOKEN, no login on the host`,
			),
		);
	}
	return findings;
}

export function probeFindings(host: string, probe: Probe, jobs: readonly JobSnap[], wantPython313: boolean): Finding[] {
	return [
		...tmpFindings(host, probe),
		...toolFindings(host, probe, wantPython313),
		...orphanFindings(host, probe.orphans, jobs),
	];
}

export function seatFindings(seat: SeatSnap): Finding[] {
	const findings: Finding[] = [];
	for (const daemon of seat.daemons) {
		if (daemon.up) {
			continue;
		}
		if (daemon.name === "herdr") {
			findings.push(act("daemon-herdr", "seat", "herdr is not running", { action: "restart-herdr" }));
		} else {
			findings.push(propose("daemon-down", "seat", `${daemon.name} is not running`));
		}
	}
	if (seat.diskPercent !== null && seat.diskPercent >= DISK_PRESSURE) {
		findings.push(propose("disk", "seat", `disk is ${seat.diskPercent}% full`));
	}
	if (seat.memoryFree !== null && seat.memoryFree < MEMORY_FREE_MIN) {
		findings.push(propose("memory", "seat", `memory free is ${seat.memoryFree}%`));
	}
	return findings;
}

/** A failed job with no tool calls, or a log that ran out of space or could not load the bridge. */
export function jobFindings(jobs: readonly JobSnap[]): Finding[] {
	const findings: Finding[] = [];
	for (const job of jobs) {
		if (job.state !== "failed") {
			continue;
		}
		const where = job.host || "seat";
		if (job.toolCalls === 0) {
			findings.push(propose("job-empty", where, `${job.id} failed with 0 tool calls`));
		}
		if (/ENOSPC/.test(job.log)) {
			findings.push(propose("job-enospc", where, `${job.id} failed with ENOSPC; a full /tmp drops the job log`));
		}
		if (/Unknown provider ["']claude-bridge["']/.test(job.log)) {
			findings.push(
				propose("job-provider", where, `${job.id} hit Unknown provider "claude-bridge"; pi-claude-bridge did not load`),
			);
		}
	}
	return findings;
}

export function parseUnpushed(text: string): { branch: string; upstream: string; track: string }[] {
	const rows: { branch: string; upstream: string; track: string }[] = [];
	for (const raw of text.split("\n")) {
		const line = raw.trim();
		if (!line) {
			continue;
		}
		const [branch = "", upstream = "", track = ""] = line.split("\t");
		if (branch) {
			rows.push({ branch, upstream, track });
		}
	}
	return rows;
}

type BranchRow = { readonly branch: string; readonly upstream: string; readonly track: string };

/** Ahead of upstream, or a non-job branch with no upstream. `limen/<id>` is the seat's own job branch. */
export function selectUnpushed(project: string, rows: readonly BranchRow[]): Unpushed[] {
	const found: Unpushed[] = [];
	for (const row of rows) {
		const ahead = row.track.includes("ahead");
		const untracked = !row.upstream && !row.branch.startsWith("limen/");
		if (!ahead && !untracked) {
			continue;
		}
		const detail = [row.upstream || "no upstream", row.track].filter(Boolean).join(" ");
		found.push({ project, branch: row.branch, detail });
	}
	return found;
}

export function unpushedFindings(rows: readonly Unpushed[]): Finding[] {
	return rows.map((row) => propose("unpushed", "seat", `${row.project}: ${row.branch} ${row.detail}`.trim()));
}

export function accountsFinding(text: string): Finding[] {
	if (/^account status failed\b/m.test(text)) {
		return [propose("accounts", "seat", "limen accounts could not be read")];
	}
	return [];
}

export function checkLines(text: string): string[] {
	return redact(text)
		.split("\n")
		.map((line) => line.trim())
		.filter(Boolean)
		.slice(0, 40);
}

export function buildReport(input: {
	readonly at: string;
	readonly seat: SeatSnap & { readonly probe: Probe };
	readonly hosts: readonly { readonly alias: string; readonly check: readonly string[]; readonly probe: Probe }[];
	readonly accounts: string;
	readonly failedJobs: readonly JobSnap[];
	readonly unpushed: readonly Unpushed[];
	readonly findings: readonly Finding[];
}): DoctorReport {
	const findings = input.findings.map(redactFinding);
	return { ...input, findings, accounts: redact(input.accounts), ok: findings.length === 0 };
}

export function reportMarkdown(report: DoctorReport): string {
	const lines = ["# Stack doctor", "", report.ok ? "No findings." : `${report.findings.length} findings.`, ""];
	if (report.findings.length) {
		lines.push("## Findings", "");
		for (const finding of report.findings) {
			lines.push(`- ${finding.severity} \`${finding.host}\` ${finding.id}: ${finding.summary}`);
		}
		lines.push("");
	}
	lines.push("## Seat", "");
	lines.push(seatLine(report.seat), "");
	lines.push("## Hosts", "");
	if (!report.hosts.length) {
		lines.push("No hosts file.", "");
	}
	for (const host of report.hosts) {
		lines.push(`### ${host.alias}`, "", ...host.check.map((line) => `- ${line}`), probeLine(host.probe), "");
	}
	lines.push("## Accounts", "", report.accounts || "(none)", "");
	if (report.failedJobs.length) {
		lines.push("## Failed jobs", "");
		for (const job of report.failedJobs) {
			lines.push(`- ${job.id} tools=${job.toolCalls} on ${job.host || "seat"}`);
		}
		lines.push("");
	}
	if (report.unpushed.length) {
		lines.push("## Unpushed", "");
		for (const row of report.unpushed) {
			lines.push(`- ${row.project}: ${row.branch} ${row.detail}`);
		}
		lines.push("");
	}
	return lines.join("\n");
}

function tmpFindings(host: string, probe: Probe): Finding[] {
	const findings: Finding[] = [];
	const pressured =
		(probe.tmpBlocksPercent !== null && probe.tmpBlocksPercent >= TMP_PRESSURE) ||
		(probe.tmpInodesPercent !== null && probe.tmpInodesPercent >= TMP_PRESSURE);
	const parts: string[] = [];
	if (probe.tmpBlocksPercent !== null) {
		parts.push(`space ${probe.tmpBlocksPercent}%`);
	}
	if (probe.tmpInodesPercent !== null) {
		parts.push(`inodes ${probe.tmpInodesPercent}%`);
	}
	for (const dir of probe.pytest) {
		if (dir.ageHours >= TMP_STALE_HOURS && !dir.inUse) {
			findings.push(
				act("pytest-stale", host, `${dir.path} is ${dir.ageHours}h old and unused`, {
					action: "clean-tmp",
					host,
					path: dir.path,
					ageHours: dir.ageHours,
					inUse: false,
				}),
			);
		} else if (pressured) {
			findings.push(
				propose("pytest-busy", host, `${dir.path} is ${dir.inUse ? "in use" : `${dir.ageHours}h old`}; not removed`),
			);
		}
	}
	if (pressured) {
		findings.push(propose("tmp-pressure", host, `/tmp ${parts.join(", ") || "is under pressure"}`));
	}
	if (probe.bridge === "missing") {
		findings.push(propose("bridge-missing", host, "pi-claude-bridge is not under ~/.pi/agent/npm"));
	}
	return findings;
}

function toolFindings(host: string, probe: Probe, wantPython313: boolean): Finding[] {
	const findings: Finding[] = [];
	const python = probe.tools.find((tool) => tool.name === "python3");
	if (wantPython313 && python?.ok && python.version !== "-" && !python.version.startsWith("3.13")) {
		findings.push(propose("python", host, `python3 is ${python.version}; hosts use 3.13`));
	}
	const required = wantPython313 ? ["python3", "pi", "node", "playwright"] : ["pi", "node"];
	const missing = probe.tools.filter((tool) => required.includes(tool.name) && !tool.ok).map((tool) => tool.name);
	if (!missing.length) {
		return findings;
	}
	const localBin = probe.localPython.replace(/\/python3$/, "");
	const pathHasLocal = localBin !== "" && probe.path.split(":").includes(localBin);
	if (localBin && !pathHasLocal && !probe.zshenvHasPath) {
		findings.push(
			act("path-zshenv", host, `non-interactive PATH lacks ${localBin}; missing ${missing.join(", ")}`, {
				action: "fix-zshenv-path",
				host,
				line: 'export PATH="$HOME/.local/bin:$PATH"',
			}),
		);
		return findings;
	}
	findings.push(propose("tool-missing", host, `missing on PATH: ${missing.join(", ")}`));
	return findings;
}

function orphanFindings(host: string, orphans: readonly Orphan[], jobs: readonly JobSnap[]): Finding[] {
	const findings: Finding[] = [];
	for (const orphan of orphans) {
		const jobId = JOB_IN_CWD.exec(orphan.cwd)?.[1];
		const job = jobId ? jobs.find((row) => row.id === jobId) : undefined;
		const finished = job && (job.state === "done" || job.state === "failed" || job.state === "stopped");
		if (finished && job) {
			findings.push(
				act("orphan", host, `pid ${orphan.pid} left from finished job ${job.id}`, {
					action: "kill-orphan",
					host,
					pid: orphan.pid,
					job: job.id,
					jobState: job.state,
					cwdDeleted: orphan.cwdDeleted,
				}),
			);
		} else {
			findings.push(propose("orphan", host, `pid ${orphan.pid} ${orphan.command} cwd ${orphan.cwd || "unknown"}`));
		}
	}
	return findings;
}

function seatLine(seat: DoctorReport["seat"]): string {
	const daemons = seat.daemons.map((daemon) => `${daemon.name} ${daemon.up ? "up" : "down"}`).join(", ");
	return [
		daemons,
		seat.diskPercent === null ? "" : `disk ${seat.diskPercent}%`,
		seat.memoryFree === null ? "" : `memory free ${seat.memoryFree}%`,
		seat.load ? `load ${seat.load}` : "",
		probeLine(seat.probe),
	]
		.filter(Boolean)
		.join("; ");
}

function probeLine(probe: Probe): string {
	const tools = probe.tools.map((tool) =>
		tool.ok ? `${tool.name} ${tool.version === "-" ? "ok" : tool.version}` : `${tool.name} missing`,
	);
	const tmp = [
		probe.tmpBlocksPercent === null ? "" : `tmp space ${probe.tmpBlocksPercent}%`,
		probe.tmpInodesPercent === null ? "" : `tmp inodes ${probe.tmpInodesPercent}%`,
	].filter(Boolean);
	return [`bridge ${probe.bridge}`, ...tmp, ...tools].join("; ");
}

function redactFinding(finding: Finding): Finding {
	const summary = redact(finding.summary);
	return finding.summary === summary ? finding : { ...finding, summary };
}

function numberOrNull(value: string | undefined): number | null {
	if (!value || value === "na" || value === "-") {
		return null;
	}
	const parsed = Number(value);
	return Number.isFinite(parsed) ? parsed : null;
}

function propose(id: string, host: string, summary: string): Finding {
	return { id, host, severity: "propose", summary };
}

function act(id: string, host: string, summary: string, action: unknown): Finding {
	if (classifyAction(action).decision !== "allow") {
		return propose(id, host, summary);
	}
	return { id, host, severity: "act", summary, action };
}
