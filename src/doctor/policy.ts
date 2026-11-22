// The doctor may do only what this file allows. Anything else is a proposal for the human.
// The perform path rechecks age, use, and job state; a model cannot widen the list by adding fields.

/** A /tmp entry must be at least this old, and not in use, before it can be removed. */
export const TMP_STALE_HOURS = 2;

const ALIAS = /^(?:seat|[a-z][a-z0-9-]{0,31})$/;
const JOB_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,200}$/;
const HOST_ALIAS = /^[a-z][a-z0-9-]{0,31}$/;
// One export, one directory, no command substitution. ~/.zshenv is a login file; a second statement would run.
const PATH_LINE = /^export PATH="(?:\$HOME\/[\w./-]+|\/(?:[\w.-]+\/)*[\w.-]+):\$PATH"$/;
const TERMINAL = new Set(["done", "failed", "stopped"]);
const SECRET = /sk-ant-|CLAUDE_CODE_OAUTH_TOKEN\s*=|\.token\b|BEGIN [A-Z ]*PRIVATE KEY/i;

export type Verdict = { readonly decision: "allow" | "refuse"; readonly reason: string };

export function classifyAction(input: unknown): Verdict {
	if (!input || typeof input !== "object" || Array.isArray(input)) {
		return refuse("the action is not an object");
	}
	const record = input as Record<string, unknown>;
	if (mentionsSecret(record)) {
		return refuse("the action names a token or a token file");
	}
	switch (record.action) {
		case "clean-tmp":
			return classifyClean(record);
		case "kill-orphan":
			return classifyKill(record);
		case "fix-zshenv-path":
			return classifyPath(record);
		case "hosts-check":
			return classifyCheck(record);
		case "restart-herdr":
			return classifyHerdr(record);
		default:
			return refuse(`${actionName(record.action)} is not on the allowlist; propose it to the human`);
	}
}

function classifyClean(record: Record<string, unknown>): Verdict {
	if (!onlyKeys(record, ["action", "host", "path", "ageHours", "inUse"])) {
		return refuse("clean-tmp has a field that is not host, path, ageHours, or inUse");
	}
	if (typeof record.host !== "string" || !ALIAS.test(record.host)) {
		return refuse("clean-tmp host is not the seat or a host alias");
	}
	if (typeof record.path !== "string" || !tmpChild(record.path)) {
		return refuse("clean-tmp only removes one entry directly under /tmp");
	}
	if (record.inUse !== false) {
		return refuse("clean-tmp refuses a path that is in use");
	}
	if (typeof record.ageHours !== "number" || !(record.ageHours >= TMP_STALE_HOURS)) {
		return refuse(`clean-tmp requires ageHours >= ${TMP_STALE_HOURS}`);
	}
	return allow("remove a stale unused /tmp entry");
}

function classifyKill(record: Record<string, unknown>): Verdict {
	if (!onlyKeys(record, ["action", "host", "pid", "job", "jobState", "cwdDeleted"])) {
		return refuse("kill-orphan has a field outside host, pid, job, jobState, and cwdDeleted");
	}
	if (typeof record.host !== "string" || !ALIAS.test(record.host)) {
		return refuse("kill-orphan host is not the seat or a host alias");
	}
	if (typeof record.pid !== "number" || !Number.isInteger(record.pid) || record.pid <= 1) {
		return refuse("kill-orphan pid is not a process id");
	}
	if (typeof record.job !== "string" || !JOB_ID.test(record.job)) {
		return refuse("kill-orphan needs the finished job id");
	}
	if (typeof record.jobState !== "string" || !TERMINAL.has(record.jobState)) {
		return refuse("kill-orphan only kills a process of a finished job");
	}
	if (typeof record.cwdDeleted !== "boolean") {
		return refuse("kill-orphan needs cwdDeleted true or false");
	}
	return allow("kill a leftover process of a finished job");
}

function classifyPath(record: Record<string, unknown>): Verdict {
	if (!onlyKeys(record, ["action", "host", "line"])) {
		return refuse("fix-zshenv-path has a field outside host and line");
	}
	if (typeof record.host !== "string" || !ALIAS.test(record.host)) {
		return refuse("fix-zshenv-path host is not the seat or a host alias");
	}
	if (typeof record.line !== "string" || !PATH_LINE.test(record.line)) {
		return refuse("fix-zshenv-path only appends one export PATH line");
	}
	return allow("append a PATH line to ~/.zshenv");
}

function classifyCheck(record: Record<string, unknown>): Verdict {
	if (!onlyKeys(record, ["action", "host"])) {
		return refuse("hosts-check has a field other than host");
	}
	if (typeof record.host !== "string" || !HOST_ALIAS.test(record.host)) {
		return refuse("hosts-check needs a host alias");
	}
	return allow("re-run limen hosts check");
}

function classifyHerdr(record: Record<string, unknown>): Verdict {
	if (!onlyKeys(record, ["action"])) {
		return refuse("restart-herdr takes no target; it only starts the seat herdr daemon");
	}
	return allow("start herdr on the seat when it is not running");
}

/** One path segment under /tmp or /private/tmp. Not the tmp directory itself, not a token name. */
function tmpChild(path: string): boolean {
	if (path.includes("\0") || path.split("/").includes("..")) {
		return false;
	}
	const match = /^\/(?:private\/)?tmp\/([^/]+)$/.exec(path);
	const name = match?.[1];
	if (!name || name === "." || name === "..") {
		return false;
	}
	return !/\.token$/i.test(name) && !/token/i.test(name);
}

function onlyKeys(record: Record<string, unknown>, keys: readonly string[]): boolean {
	return Object.keys(record).every((key) => keys.includes(key));
}

function mentionsSecret(record: Record<string, unknown>): boolean {
	return SECRET.test(JSON.stringify(record));
}

function actionName(action: unknown): string {
	return typeof action === "string" && action ? action : "that action";
}

function allow(reason: string): Verdict {
	return { decision: "allow", reason };
}

function refuse(reason: string): Verdict {
	return { decision: "refuse", reason };
}
