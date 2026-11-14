# Ops knowledge

What has been verified on this seat. Coordinators read this before they state how a host, a Claude account, `/tmp`, or a non-interactive PATH works. A line here beats a remembered claim. The stack doctor appends a new lesson only by a pull request, after an incident, and does not push to main.

## 2026-11-14

- Host jobs get the seat's Claude account for that job only, as `CLAUDE_CODE_OAUTH_TOKEN`. The seat reads `~/.claude-accounts/<name>.token`. The host does not need a Claude login. A locked macOS keychain on the host (`-25308`, `User interaction is not allowed`) is not a reason to run `claude` login there.
- A host job whose provider or model is `anthropic/<model>` runs as `claude-bridge/<model>` when that host has `pi-claude-bridge`. Pi's own `anthropic` provider sends the seat token as `Authorization: Bearer`, and Anthropic rejects it. The bridge sends it as `x-api-key`. The job log records the mapping.
- On `win`, `/tmp` is a 7.7G tmpfs with about 1M inodes. `pytest-of-<user>` can use the inodes up within hours. The failure is `ENOSPC`. Pi then fails to load extensions (`Unknown provider "claude-bridge"`). A full `/tmp` also drops the job log, so the seat record can look empty.
- Non-interactive ssh does not read `.zshrc`. On these hosts the ssh command is a zsh login shell, which reads `~/.zshenv`. `python3`, `pi`, and `node` have to be on the PATH that file sets, or in the host's `path` in `hosts.json`.
- `win` and `mbp` have Python 3.13 on `~/.local/bin`, and Playwright 1.65 with Chromium, for review jobs that drive a browser.
- Hosts run a nightly tmp clean at 04:45, and a tmp guard every 15 minutes that clears `pytest-of-*` when inodes or space on `/tmp` pass 70%.
- A running job does not move to another host. `limen continue` stays on the worktree's host.
