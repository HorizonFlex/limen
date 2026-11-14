#!/bin/bash
# Read-only seat checks: daemons, disk, memory pressure, load. No tokens.
set +e
if pgrep -x herdr >/dev/null 2>&1; then printf 'daemon\therdr\tup\n'; else printf 'daemon\therdr\tdown\n'; fi
# [h] keeps this script's own text from matching the pattern.
if pgrep -x herdr-core >/dev/null 2>&1 || pgrep -f '[h]erdr-core' >/dev/null 2>&1; then
	printf 'daemon\therdr-core\tup\n'
else
	printf 'daemon\therdr-core\tdown\n'
fi
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
