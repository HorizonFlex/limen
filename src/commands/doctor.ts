import { readFileSync } from "node:fs";
import { perform, propose } from "../doctor/act.ts";
import { collectReport } from "../doctor/collect.ts";
import { deliverNotice, findingsInReport } from "../doctor/notify.ts";
import { redact, reportMarkdown } from "../doctor/parse.ts";
import { classifyAction } from "../doctor/policy.ts";

/** `limen doctor` prints a read-only report. `limen doctor act` is the only repair path. */
export async function doctorCommand(args: readonly string[]): Promise<void> {
	if (args[0] === "act") {
		await actCommand(args.slice(1));
		return;
	}
	if (args[0] === "notify") {
		await notifyCommand(args.slice(1));
		return;
	}
	const markdown = args.includes("--md");
	const extra = args.filter((arg) => arg !== "--md" && arg !== "--json");
	if (extra.length) {
		throw new Error(
			"doctor [--json|--md] | doctor act [--dry-run] <json> | doctor notify <slot> <message> [--report file]",
		);
	}
	const report = await collectReport();
	console.log(redact(markdown ? reportMarkdown(report) : JSON.stringify(report, null, 2)));
	if (!report.ok) {
		process.exitCode = 2;
	}
}

async function actCommand(args: readonly string[]): Promise<void> {
	const dry = args[0] === "--dry-run";
	const raw = dry ? args[1] : args[0];
	if (!raw || args.length !== (dry ? 2 : 1)) {
		throw new Error("doctor act [--dry-run] <json>");
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		throw new Error("doctor act expects one JSON object");
	}
	const verdict = classifyAction(parsed);
	if (verdict.decision === "refuse") {
		if (dry) {
			console.log(`refuse: ${verdict.reason}`);
		} else {
			await propose(verdict.reason, parsed);
		}
		process.exitCode = 2;
		return;
	}
	if (dry) {
		console.log(`allow: ${verdict.reason}`);
		return;
	}
	const result = await perform(parsed as Record<string, unknown>);
	console.log(result.text);
	if (!result.ok) {
		process.exitCode = 1;
	}
}

async function notifyCommand(args: readonly string[]): Promise<void> {
	const reportAt = args.indexOf("--report");
	const report = reportAt >= 0 ? args[reportAt + 1] : undefined;
	const words = args.filter((_, index) => reportAt < 0 || (index !== reportAt && index !== reportAt + 1));
	const [slot, message] = words;
	if (!slot || !message || words.length !== 2 || (reportAt >= 0 && !report)) {
		throw new Error("doctor notify <slot> <message> [--report file]");
	}
	let findings: ReturnType<typeof findingsInReport> = [];
	if (report) {
		try {
			findings = findingsInReport(readFileSync(report, "utf8"));
		} catch {
			findings = [];
		}
	}
	await deliverNotice(slot, message, findings);
}
