import { spawnSync } from "node:child_process";
import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { showSeatNotification } from "../integrations/herdr.ts";
import { textFile } from "../job/record.ts";
import { registeredProjects, seatDir } from "../project/seat.ts";
import { posixQuote, type ShellText, shellText } from "../runtime/host-shell.ts";
import { hostByAlias, loadHostPool } from "../runtime/hosts.ts";
import { runBash } from "./bash.ts";
import { redact } from "./parse.ts";
import { TMP_STALE_HOURS } from "./policy.ts";

const TERMINAL = new Set(["done", "failed", "stopped"]);

export type ActResult = { readonly ok: boolean; readonly text: string };

/** Carries out one action that `classifyAction` already allowed. Rechecks the facts the model claimed. */
export async function perform(action: Record<string, unknown>): Promise<ActResult> {
	switch (action.action) {
		case "clean-tmp":
			return runOn(String(action.host), cleanScript(String(action.path)));
		case "kill-orphan":
			return killOrphan(action);
		case "fix-zshenv-path":
			return runOn(String(action.host), zshenvScript(String(action.line)));
		case "hosts-check":
			return rerunCheck(String(action.host));
		case "restart-herdr":
			return runOn("seat", herdrScript());
		default:
			return { ok: false, text: "not on the allowlist" };
	}
}

/** Writes the refusal where the human sees it: Moshi, then a seat notification, then the proposals log. */
export async function propose(reason: string, action: unknown): Promise<void> {
	const body = redact(`${reason}\n${JSON.stringify(action)}`);
	const dir = join(seatDir(), "stack-doctor");
	await mkdir(dir, { recursive: true });
	await appendFile(join(dir, "proposals.log"), `${new Date().toISOString()} ${body.replaceAll("\n", " ")}\n`);
	console.log(body);
	const note = body.slice(0, 240);
	spawnSync("moshi-hook", ["notify", "--title", "Limen stack doctor", "--source", "stack-doctor", note], {
		timeout: 8_000,
	});
	await showSeatNotification("Limen stack doctor", note);
}

async function killOrphan(action: Record<string, unknown>): Promise<ActResult> {
	const job = String(action.job);
	const claimed = String(action.jobState);
	const live = await jobState(job);
	if (!TERMINAL.has(live) || live !== claimed) {
		return { ok: false, text: `job ${job} is ${live || "missing"} on the seat; not killed` };
	}
	const pid = Number(action.pid);
	if (pid === process.pid || pid === process.ppid) {
		return { ok: false, text: "refusing to signal the doctor" };
	}
	return runOn(String(action.host), killScript(pid, job));
}

async function jobState(job: string): Promise<string> {
	for (const root of registeredProjects()) {
		const state = await textFile(join(root, ".limen", "jobs", job, "state"));
		if (state) {
			return state;
		}
	}
	return "";
}

async function runOn(host: string, script: string): Promise<ActResult> {
	const result = host === "seat" ? await runBash(script, 20_000) : await remote(host, script);
	const text = redact(`${result.stdout}${result.stderr}`).trim();
	return { ok: result.code === 0, text: text || `exit ${result.code ?? "lost"}` };
}

async function remote(host: string, script: string): Promise<ShellText> {
	try {
		const pool = loadHostPool();
		return await shellText(hostByAlias(pool, host), script, 20_000);
	} catch (error) {
		return { code: null, stdout: "", stderr: error instanceof Error ? error.message : String(error) };
	}
}

function rerunCheck(host: string): ActResult {
	const script = process.argv[1];
	if (!script) {
		return { ok: false, text: "limen path unknown" };
	}
	const result = spawnSync(process.execPath, [script, "hosts", "check", host], { encoding: "utf8", timeout: 90_000 });
	return { ok: result.status === 0, text: redact(`${result.stdout ?? ""}${result.stderr ?? ""}`).trim() };
}

function cleanScript(path: string): string {
	const quoted = posixQuote(path);
	return `set -eu
path=${quoted}
case "$path" in
  /tmp/*|/private/tmp/*) ;;
  *) echo 'outside /tmp' >&2; exit 2 ;;
esac
parent=\${path%/*}
if [ "$parent" != /tmp ] && [ "$parent" != /private/tmp ]; then echo 'not a direct child of /tmp' >&2; exit 2; fi
if [ -L "$path" ]; then echo symlink >&2; exit 2; fi
if [ ! -e "$path" ]; then echo absent; exit 0; fi
now=$(date +%s)
if [ "$(uname -s)" = Darwin ]; then m=$(stat -f %m "$path"); else m=$(stat -c %Y "$path"); fi
age=$(((now - m) / 3600))
if [ "$age" -lt ${TMP_STALE_HOURS} ]; then echo 'too young' >&2; exit 2; fi
if [ -d /proc ]; then
  for cwd in /proc/[0-9]*/cwd; do
    target=$(readlink "$cwd" 2>/dev/null || true)
    case "$target" in
      "$path"|"$path"/*) echo 'in use' >&2; exit 2 ;;
    esac
  done
fi
rm -rf -- "$path"
echo removed
`;
}

function killScript(pid: number, job: string): string {
	return `set -eu
pid=${pid}
job=${posixQuote(job)}
if [ "$pid" -le 1 ]; then echo 'bad pid' >&2; exit 2; fi
cwd=""
if [ -d "/proc/$pid" ]; then
  cwd=$(readlink "/proc/$pid/cwd" 2>/dev/null || echo deleted)
elif command -v lsof >/dev/null 2>&1; then
  cwd=$(lsof -a -p "$pid" -d cwd -Fn 2>/dev/null | awk '/^n/{sub(/^n/,""); print; exit}')
fi
case "$cwd" in
  *'(deleted)'|deleted|*"$job"*) ;;
  *) echo 'cwd is not this finished job' >&2; exit 2 ;;
esac
kill -TERM "$pid"
echo signaled
`;
}

function zshenvScript(line: string): string {
	return `set -eu
line=${posixQuote(line)}
file="$HOME/.zshenv"
if [ -f "$file" ] && grep -qxF -- "$line" "$file"; then echo present; exit 0; fi
touch "$file"
printf '%s\\n' "$line" >> "$file"
echo appended
`;
}

function herdrScript(): string {
	return `set +e
if pgrep -x herdr >/dev/null 2>&1 || pgrep -x herdr-core >/dev/null 2>&1 || pgrep -f '[h]erdr-core' >/dev/null 2>&1; then
  echo 'herdr already running'
  exit 0
fi
if ! command -v herdr >/dev/null 2>&1; then echo 'herdr is not on PATH' >&2; exit 1; fi
nohup herdr server >/dev/null 2>&1 &
echo started
exit 0
`;
}
