#!/bin/bash
# Opt-in. launchd runs this every 30 minutes. Pi starts only when the report has findings.
# A failed job starts it only when ~/.limen/stack-doctor.on exists. seat-health can call it too:
#   stack-doctor.sh --reason "seat-health: herdr down"
set -u
umask 077
export PATH="/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin:/usr/local/bin:${HOME}/.local/bin:${PATH:-}"

reason=""
while [ $# -gt 0 ]; do
	case "$1" in
	--reason)
		reason=${2:-}
		shift 2
		;;
	*)
		shift
		;;
	esac
done

if ! command -v limen >/dev/null 2>&1; then
	echo "limen is not on PATH" >&2
	exit 1
fi

home=${LIMEN_HOME:-$HOME}
dir="$home/.limen/stack-doctor"
mkdir -p "$dir"
lock="$dir/lock"
if [ -d "$lock" ]; then
	stale=$(find "$lock" -maxdepth 0 -mmin +120 2>/dev/null || true)
	if [ -n "$stale" ]; then
		rmdir "$lock" 2>/dev/null || true
	fi
fi
if ! mkdir "$lock" 2>/dev/null; then
	echo "stack doctor already running" >&2
	exit 0
fi
trap 'rmdir "$lock" 2>/dev/null || true' EXIT

report="$dir/latest.json"
set +e
limen doctor >"$report"
code=$?
set -e
if [ "$code" -eq 0 ]; then
	exit 0
fi
if [ "$code" -ne 2 ]; then
	moshi-hook notify --title "Limen stack doctor" --source stack-doctor "collector failed (exit $code)" >/dev/null 2>&1 || true
	exit "$code"
fi

pkg=$(node -e 'const fs=require("fs");const path=require("path");const bin=fs.realpathSync(process.argv[1]);process.stdout.write(path.dirname(path.dirname(bin)));' "$(command -v limen)")
runbook="$pkg/templates/stack-doctor.md"
task="$dir/task.md"
cat >"$task" <<EOF
The stack report is ${report}.
Reason: ${reason:-scheduled}.
Follow the system prompt. Apply a fix only with limen doctor act. A refused act notifies the human; do not do that fix yourself.
Never print a token, and never read a file whose name ends in .token.
If this incident taught a lesson that docs/ops-knowledge.md does not already state, open a pull request that appends it. Do not push to main.
EOF

if ! command -v pi >/dev/null 2>&1 || [ ! -f "$runbook" ]; then
	moshi-hook notify --title "Limen stack doctor" --source stack-doctor "findings in ${report}; pi or the runbook is missing" >/dev/null 2>&1 || true
	exit 0
fi

cd "$pkg"
pi --approve --no-extensions --append-system-prompt "$(cat "$runbook")" "@${task}"
