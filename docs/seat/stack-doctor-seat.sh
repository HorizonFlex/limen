#!/bin/bash
# Read-only seat checks: daemons, disk, memory pressure, load. No tokens.
set +e
herdr_core_up() {
	label=dev.agent.herdr-core
	if command -v launchctl >/dev/null 2>&1; then
		printed=$(launchctl print "system/$label" 2>/dev/null || true)
		if printf '%s\n' "$printed" | grep -q 'state = running' && printf '%s\n' "$printed" | grep -Eq 'pid = [1-9][0-9]*'; then
			return 0
		fi
	fi
	plist="/Library/LaunchDaemons/$label.plist"
	prog=""
	if [ -f "$plist" ] && command -v plutil >/dev/null 2>&1; then
		prog=$(plutil -extract Program raw "$plist" 2>/dev/null || true)
	fi
	if [ -n "$prog" ] && pgrep -f "[${prog%${prog#?}}]${prog#?}" >/dev/null 2>&1; then
		return 0
	fi
	return 1
}
if pgrep -x herdr >/dev/null 2>&1; then printf 'daemon\therdr\tup\n'; else printf 'daemon\therdr\tdown\n'; fi
# herdr-core's process is not named herdr-core. LaunchDaemon dev.agent.herdr-core runs ~/.local/bin/hc.
if herdr_core_up; then printf 'daemon\therdr-core\tup\n'; else printf 'daemon\therdr-core\tdown\n'; fi
if pgrep -x moshi-hook >/dev/null 2>&1; then printf 'daemon\tmoshi-hook\tup\n'; else printf 'daemon\tmoshi-hook\tdown\n'; fi
if [ -S /var/lib/limen-token/token.sock ] || pgrep -f '[l]imen-token-broker' >/dev/null 2>&1; then
	printf 'daemon\ttoken-broker\tup\n'
else
	printf 'daemon\ttoken-broker\tdown\n'
fi
df -Pk / 2>/dev/null | awk 'NR==2 {gsub("%","",$5); printf "disk\t%s\n", $5}'
if [ -x /usr/bin/memory_pressure ]; then
	raw=$(/usr/bin/memory_pressure -Q 2>/dev/null || /usr/bin/memory_pressure 2>/dev/null || true)
	mem=$(printf '%s\n' "$raw" | sed -n 's/.*[Mm]emory free percentage: *\([0-9][0-9]*\).*/\1/p' | head -n 1)
	printf 'memory-free\t%s\n' "${mem:-na}"
elif [ -r /proc/meminfo ]; then
	awk '/MemTotal/{t=$2} /MemAvailable/{a=$2} END{if (t>0) printf "memory-free\t%.0f\n", 100*a/t; else print "memory-free\tna"}' /proc/meminfo
else
	echo "memory-free	na"
fi
uptime 2>/dev/null | awk '{printf "load\t%s\n", $0}'
exit 0
