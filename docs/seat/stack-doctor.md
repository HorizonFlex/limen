# Stack doctor

An optional Pi agent on the seat. It reads a report and may repair only an allowlist. It is not installed by `limen init`, and nothing here starts it.

The report is `limen doctor`. It is read-only. Exit 0 means no findings. Exit 2 means the report has findings. The text never includes a token.

```bash
limen doctor          # JSON
limen doctor --md     # the same report as markdown
```

The report covers, per enabled host in `~/.limen/hosts.json`: `limen hosts check`, `/tmp` space and inodes (`df -i` on Linux), `python3` / `pi` / `node` / `playwright` on the non-interactive PATH, and `pi-claude-bridge`. On the seat: herdr, herdr-core, moshi-hook, the token broker, disk, memory pressure, and load. It also includes `limen accounts`, failed jobs from the last 6 hours (`LIMEN_DOCTOR_JOB_HOURS`) that made 0 tool calls or logged `ENOSPC` or `Unknown provider "claude-bridge"` and are not superseded by a later job of the same feature or listed in `~/.limen/stack-doctor/ack`, and local branches that are ahead of upstream or have no upstream (`limen/*` job branches with no upstream are skipped). A process is an orphan only when its job record is finished, or its cwd is gone and it is not in a running job's tree; pytest under `/tmp/pytest-of-*` is tied to that job through its parents. A continue shares that worktree, so the process belongs to the newest job using it, and a live `limen` wrapper among its parents means the job is still running. `playwright` counts as present when `python3 -c 'import playwright'` works. herdr-core is up when `launchctl print system/dev.agent.herdr-core` says `state = running`. A logged-out host Claude is info, not a finding.

## What the agent may change

`limen doctor act '<json>'` is the only repair. `--dry-run` classifies and does not change anything. A refusal is the proposal: it is appended to `~/.limen/stack-doctor/proposals.log`, sent with `moshi-hook notify`, and shown as a seat notification.

Allowed: remove one unused `/tmp` entry at least 2 hours old (including `pytest-of-*`); kill a pid that belongs to a finished job; append one `export PATH` line to a host's `~/.zshenv`; re-run `limen hosts check`; start herdr on the seat when it is not already running.

Not allowed, and never done by the act command: deleting any other path, editing `hosts.json` (`overflow`, `maxConcurrent`, or anything else), restarting a coordinator, moshi, or the token broker, changing a Claude account, editing Limen. A new lesson is a pull request that appends to [ops-knowledge.md](../ops-knowledge.md), not a push to main.

The runbook the Pi process gets is `templates/stack-doctor.md`. Coordinators are pointed at the lessons from the shop manual and from the coordinator system prompt.

## Schedule

`docs/seat/stack-doctor.sh` collects, and starts Pi only when the report's exit code is 2. A second run while one is in progress exits. A lock older than 2 hours is dropped.

The launchd template is `docs/seat/dev.limen.stack-doctor.plist`. It is a LaunchDaemon (`StartInterval` 1800, 30 minutes) that runs as the seat user. It ships with placeholders. Copying it into `/Library/LaunchDaemons` without editing those placeholders does nothing useful, and this package never bootstraps it.

On the seat, as a dry run of the collector (this does not start Pi and does not install launchd):

```bash
limen doctor --md
```

Opt in, after you have edited the three placeholders (`__USER__`, `__HOME__`, `__LIMEN_PKG__`):

```bash
# __USER__ is the seat account. __HOME__ is that account's home.
# __LIMEN_PKG__ is the limen checkout launchd should run (the directory that contains docs/seat).
sed -e "s|__USER__|agent|g" -e "s|__HOME__|/Users/agent|g" -e "s|__LIMEN_PKG__|/Users/agent/src/limen|g" \
  docs/seat/dev.limen.stack-doctor.plist > /tmp/dev.limen.stack-doctor.plist
plutil -lint /tmp/dev.limen.stack-doctor.plist
sudo cp /tmp/dev.limen.stack-doctor.plist /Library/LaunchDaemons/dev.limen.stack-doctor.plist
sudo chown root:wheel /Library/LaunchDaemons/dev.limen.stack-doctor.plist
sudo chmod 644 /Library/LaunchDaemons/dev.limen.stack-doctor.plist
rm /tmp/dev.limen.stack-doctor.plist
sudo launchctl enable system/dev.limen.stack-doctor
sudo launchctl bootstrap system /Library/LaunchDaemons/dev.limen.stack-doctor.plist
```

To use a LaunchAgent instead, drop the `UserName` key, put the plist in `~/Library/LaunchAgents/`, and bootstrap `gui/$(id -u)` rather than `system`. Still your step, not the package's.

Stop it:

```bash
sudo launchctl bootout system/dev.limen.stack-doctor
sudo rm /Library/LaunchDaemons/dev.limen.stack-doctor.plist
```

## When a job or seat-health fails

`~/.limen/stack-doctor.on` (an empty file is enough) makes a failed job start the same script. Without that file, a failure does not. Create it only if you also want failure-triggered runs; the launchd job does not require it.

```bash
touch ~/.limen/stack-doctor.on
```

seat-health, or any other checker, calls the script with a short reason. The reason is shown to Pi. It is not a shell command.

```bash
/Users/agent/src/limen/docs/seat/stack-doctor.sh --reason "seat-health: herdr down"
```

Pi needs to be on the PATH the script sets (`/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin:/usr/local/bin` and `~/.local/bin`). If `pi` is missing, the script notifies Moshi with the report path and does not fail the launchd job.
