import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { appendFile, mkdir, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { textFile } from "../job/record.ts";
import { packageRoot } from "../project/inherit.ts";
import { registeredProjects, seatDir } from "../project/seat.ts";
import { findStatusCommand, readAccountStatus } from "../runtime/account-status.ts";
import { formatUsage, readSeatUsage } from "../runtime/account-usage.ts";
import { hostCheckScript, shellText } from "../runtime/host-shell.ts";
import { loadHostPool, type RemoteHost } from "../runtime/hosts.ts";
import { runBash } from "./bash.ts";
import {
	accountsFinding,
	buildReport,
	checkLines,
	type DoctorReport,
	hostCheckFindings,
	type JobSnap,
	jobAckLine,
	jobFindings,
	jobWindowMs,
	type Probe,
	parseProbe,
	parseSeat,
	parseUnpushed,
	probeFindings,
	seatFindings,
	selectUnpushed,
	type Unpushed,
	unpushedFindings,
} from "./parse.ts";

const LOG_TAIL = 8_000;

/** Read-only. One dead host becomes a finding; it does not drop the rest of the report. */
export async function collectReport(at = new Date().toISOString()): Promise<DoctorReport> {
	const jobs = await collectJobs();
	const acked = readAck();
	const failures = jobFindings(jobs, { windowMs: jobWindowMs(), acked });
	const [seatProbe, seatText, accounts] = await Promise.all([
		runScript("stack-doctor-probe.sh"),
		runScript("stack-doctor-seat.sh"),
		readAccounts(),
	]);
	const seat = { ...parseSeat(seatText), probe: parseProbe(seatProbe) };
	const unpushed = collectUnpushed();
	const hosts = await collectHosts(jobs);
	const findings = [
		...seatFindings(seat),
		...probeFindings("seat", seat.probe, jobs, false),
		...hosts.findings,
		...failures,
		...unpushedFindings(unpushed),
		...accountsFinding(accounts),
	];
	await rememberJobAcks(failures, acked).catch(() => undefined);
	return buildReport({
		at,
		seat,
		hosts: hosts.views,
		accounts,
		failedJobs: jobs.filter((job) => failures.some((finding) => finding.summary.startsWith(`${job.id} `))),
		unpushed,
		findings,
	});
}

async function collectHosts(jobs: readonly JobSnap[]): Promise<{
	views: { alias: string; check: string[]; probe: Probe }[];
	findings: DoctorReport["findings"];
}> {
	let pool: { hosts: readonly RemoteHost[] };
	try {
		pool = loadHostPool();
	} catch (error) {
		const message = error instanceof Error ? error.message : "hosts.json could not be read";
		return { views: [], findings: [{ id: "hosts-file", host: "seat", severity: "propose", summary: message }] };
	}
	const enabled = pool.hosts.filter((host) => host.enabled);
	const rows = await Promise.all(enabled.map((host) => collectHost(host, jobs)));
	return {
		views: rows.map((row) => row.view),
		findings: rows.flatMap((row) => row.findings),
	};
}

async function collectHost(host: RemoteHost, jobs: readonly JobSnap[]) {
	const probeRun = await shellText(host, scriptText("stack-doctor-probe.sh"), 30_000);
	const checkRun = await shellText(host, hostCheckScript(host), 45_000);
	const probeText = `${probeRun.stdout}\n${probeRun.stderr}`;
	const checkText = `${checkRun.stdout}\n${checkRun.stderr}`;
	const probe = parseProbe(probeText);
	const findings = [...probeFindings(host.alias, probe, jobs, true), ...hostCheckFindings(host.alias, checkText)];
	if (probeRun.code === null && !probeRun.stdout.trim()) {
		findings.unshift({
			id: "host-unreachable",
			host: host.alias,
			severity: "propose",
			summary: `${host.alias} did not answer: ${probeRun.stderr.trim() || "ssh failed"}`,
		});
	}
	return { view: { alias: host.alias, check: checkLines(checkText), probe }, findings };
}

async function collectJobs(): Promise<JobSnap[]> {
	const snaps: JobSnap[] = [];
	const now = Date.now();
	for (const root of registeredProjects()) {
		const jobs = join(root, ".limen", "jobs");
		for (const id of await readdir(jobs).catch(() => [] as string[])) {
			const snap = await jobSnap(join(jobs, id), id, now);
			if (snap) {
				snaps.push(snap);
			}
		}
	}
	return snaps;
}

async function jobSnap(dir: string, id: string, now: number): Promise<JobSnap | undefined> {
	const state = await textFile(join(dir, "state"));
	const live = state === "running" || state === "starting" || state === "queued";
	const terminal = state === "done" || state === "failed" || state === "stopped";
	if (!live && !terminal) {
		return;
	}
	const finished = Date.parse(await textFile(join(dir, "finished-at")));
	const finishedAt = Number.isFinite(finished) ? finished : 0;
	if (terminal && finishedAt > 0 && now - finishedAt > jobWindowMs()) {
		return;
	}
	const tools = Number(await textFile(join(dir, "tool-calls")));
	return {
		id,
		state,
		toolCalls: Number.isFinite(tools) ? tools : 0,
		log: state === "failed" ? await tail(join(dir, "log")) : "",
		host: await textFile(join(dir, "host")),
		label: await textFile(join(dir, "label")),
		finishedAt,
	};
}

function readAck(): Set<string> {
	try {
		return new Set(
			readFileSync(join(seatDir(), "stack-doctor", "ack"), "utf8")
				.split("\n")
				.map((line) => line.trim())
				.filter(Boolean),
		);
	} catch {
		return new Set();
	}
}

async function rememberJobAcks(findings: DoctorReport["findings"], already: ReadonlySet<string>): Promise<void> {
	const fresh = findings.map(jobAckLine).filter((line) => line && !already.has(line));
	if (!fresh.length) {
		return;
	}
	const dir = join(seatDir(), "stack-doctor");
	await mkdir(dir, { recursive: true });
	await appendFile(join(dir, "ack"), `${fresh.join("\n")}\n`);
}

function collectUnpushed(): Unpushed[] {
	const found: Unpushed[] = [];
	for (const root of registeredProjects()) {
		const result = spawnSync(
			"git",
			["-C", root, "for-each-ref", "--format=%(refname:short)%09%(upstream:short)%09%(upstream:track)", "refs/heads"],
			{ encoding: "utf8", timeout: 15_000 },
		);
		if (result.status === 0) {
			found.push(...selectUnpushed(root, parseUnpushed(result.stdout ?? "")));
		}
	}
	return found;
}

async function readAccounts(): Promise<string> {
	try {
		const command = findStatusCommand();
		const status = command ? await readAccountStatus(command) : { ok: true, text: "no account status tool" };
		const usage = formatUsage(await readSeatUsage());
		const head = status.ok ? status.text : `account status failed: ${status.text}`;
		return [head, usage].filter(Boolean).join("\n\n");
	} catch (error) {
		return `account status failed: ${error instanceof Error ? error.message : "unread"}`;
	}
}

async function runScript(name: string): Promise<string> {
	try {
		const result = await runBash(scriptText(name), 20_000);
		return `${result.stdout}\n${result.stderr}`;
	} catch (error) {
		return error instanceof Error ? error.message : "";
	}
}

function scriptText(name: string): string {
	return readFileSync(join(packageRoot(), "docs/seat", name), "utf8");
}

async function tail(path: string): Promise<string> {
	const text = await readFile(path, "utf8").catch(() => "");
	return text.length > LOG_TAIL ? text.slice(-LOG_TAIL) : text;
}
