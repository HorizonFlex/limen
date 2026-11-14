#!/bin/bash
# Read-only probe a seat or a host can run. Prints tab-separated lines. No tokens, no account files.
set +e
printf 'path\t%s\n' "$PATH"
for name in python3 pi node playwright; do
	if [ "$name" = playwright ] && ! command -v playwright >/dev/null 2>&1; then
		if python3 -c 'import playwright' >/dev/null 2>&1; then
			printf 'tool\tplaywright\tok\tpython-module\t-\n'
			continue
		fi
	fi
	if command -v "$name" >/dev/null 2>&1; then
		bin=$(command -v "$name")
		ver=-
		if [ "$name" = python3 ]; then
			ver=$(python3 -c 'import sys; print("%d.%d.%d" % sys.version_info[:3])' 2>/dev/null || echo -)
		fi
		printf 'tool\t%s\tok\t%s\t%s\n' "$name" "$bin" "$ver"
	else
		printf 'tool\t%s\tmissing\t-\t-\n' "$name"
	fi
done
df -Pk /tmp 2>/dev/null | awk 'NR==2 {gsub("%","",$5); printf "tmp-blocks\t%s\t%s\n", $5, $6}'
# Linux df -P -i (inodes). macOS df has no -P -i; df -i puts %iused in field 8.
if df -Pi /tmp >/dev/null 2>&1; then
	df -Pi /tmp 2>/dev/null | awk 'NR==2 {gsub("%","",$5); printf "tmp-inodes\t%s\t%s\n", $5, $6}'
else
	df -i /tmp 2>/dev/null | awk 'NR==2 {gsub("%","",$8); printf "tmp-inodes\t%s\t%s\n", $8, $9}'
fi
bridge=$(find "$HOME/.pi/agent/npm/node_modules" -maxdepth 3 -type d -name 'pi-claude-bridge' 2>/dev/null | head -n 1)
if [ -n "$bridge" ]; then
	echo "bridge present"
else
	echo "bridge missing"
fi
if [ -f "$HOME/.zshenv" ] && grep -q 'PATH=' "$HOME/.zshenv" 2>/dev/null; then
	echo "zshenv path"
else
	echo "zshenv nopath"
fi
if [ -x "$HOME/.local/bin/python3" ]; then
	printf 'local-python\t%s\n' "$HOME/.local/bin/python3"
else
	echo "local-python missing"
fi
now=$(date +%s)
find /tmp -maxdepth 1 -name 'pytest-of-*' -type d 2>/dev/null | while IFS= read -r dir; do
	if [ "$(uname -s)" = Darwin ]; then
		m=$(stat -f %m "$dir" 2>/dev/null || echo "$now")
	else
		m=$(stat -c %Y "$dir" 2>/dev/null || echo "$now")
	fi
	age=$(((now - m) / 3600))
	inuse=0
	if [ -d /proc ]; then
		for cwd in /proc/[0-9]*/cwd; do
			target=$(readlink "$cwd" 2>/dev/null || true)
			case "$target" in
			"$dir" | "$dir"/*)
				inuse=1
				break
				;;
			esac
		done
	fi
	printf 'pytest\t%s\t%s\t%s\n' "$age" "$inuse" "$dir"
done
# One line per process: pid, parent, deleted cwd, cwd, command. The seat decides which belong to a finished job.
if [ -d /proc ]; then
	for cmdf in /proc/[0-9]*/cmdline; do
		pid=${cmdf#/proc/}
		pid=${pid%/cmdline}
		[ "$pid" -gt 1 ] 2>/dev/null || continue
		cmd=$(tr '\0' ' ' <"$cmdf" 2>/dev/null | tr '\t' ' ')
		[ -n "$cmd" ] || continue
		ppid=$(awk '/^PPid:/{print $2; exit}' "/proc/$pid/status" 2>/dev/null || echo 0)
		cwd=$(readlink "/proc/$pid/cwd" 2>/dev/null || echo deleted)
		cwd=$(printf '%s' "$cwd" | tr '\t' ' ' | cut -c 1-180)
		cmd=$(printf '%s' "$cmd" | cut -c 1-180)
		deleted=0
		case "$cwd" in
		deleted | *' (deleted)') deleted=1 ;;
		esac
		printf 'proc\t%s\t%s\t%s\t%s\t%s\n' "$pid" "$ppid" "$deleted" "$cwd" "$cmd"
	done
else
	ps -ax -o pid=,ppid=,command= 2>/dev/null | while IFS= read -r row; do
		pid=$(printf '%s' "$row" | awk '{print $1}')
		ppid=$(printf '%s' "$row" | awk '{print $2}')
		cmd=$(printf '%s' "$row" | tr '\t' ' ' | cut -c 1-180)
		[ "$pid" -gt 1 ] 2>/dev/null || continue
		deleted=0
		cwd=unknown
		if command -v lsof >/dev/null 2>&1; then
			shown=$(lsof -a -p "$pid" -d cwd -Fn 2>/dev/null | awk '/^n/ {sub(/^n/,""); print; exit}')
			if [ -n "$shown" ]; then
				cwd=$(printf '%s' "$shown" | tr '\t' ' ' | cut -c 1-180)
				case "$cwd" in *'(deleted)') deleted=1 ;; esac
			fi
		fi
		printf 'proc\t%s\t%s\t%s\t%s\t%s\n' "$pid" "$ppid" "$deleted" "$cwd" "$cmd"
	done
fi
exit 0
