#!/usr/bin/env bash
# vps_audit.sh — read-only diagnostic sweep for the Project Bravo VPS.
#
# Collects everything the scale audit still needs in one pass. Makes no
# changes: no writes outside /tmp, no service restarts, no config edits.
#
# Usage, from your machine:
#   scp -i ~/.ssh/vps_ed25519 tools/vps_audit.sh ubuntu@135.148.120.186:/tmp/
#   ssh -i ~/.ssh/vps_ed25519 ubuntu@135.148.120.186 "bash /tmp/vps_audit.sh" > vps_audit.txt
#
# Then paste vps_audit.txt back. Some sections need sudo; they degrade to a
# note rather than failing if you run without it.

set -uo pipefail
sec(){ printf '\n\n===== %s =====\n' "$1"; }
have(){ command -v "$1" >/dev/null 2>&1; }

printf 'Project Bravo VPS audit — %s\n' "$(date -Is)"

sec "HOST"
uname -a; echo; lsb_release -d 2>/dev/null || cat /etc/os-release | head -2
echo; echo "-- uptime / load (load > 2.0 on 2 vCPU means saturated)"; uptime

sec "CPU"
lscpu | grep -Ei 'model name|^cpu\(s\)|mhz|cache|hypervisor|flags' | head -8
echo; echo "-- steal time: 'st' column. Anything above ~2 means a noisy neighbour is taking your cycles."
have vmstat && vmstat 1 5

sec "MEMORY"
free -h; echo; echo "-- swap devices (expect none today)"; swapon --show || echo "(no swap configured)"
echo; echo "-- top RSS"; ps -eo rss,pid,user,comm --sort=-rss | head -18

sec "DISK + I/O LATENCY"
df -h /; echo
echo "-- write latency matters: bravo does blocking writeFileSync on the game thread"
if have ioping; then ioping -c 10 /home/ubuntu 2>&1 | tail -4
else
  echo "(ioping not installed — crude fallback, 64MB sync write to /tmp then removed)"
  dd if=/dev/zero of=/tmp/_iotest bs=1M count=64 conv=fsync 2>&1 | tail -1
  rm -f /tmp/_iotest
fi

sec "NETWORK — INTERFACE"
ip -br addr 2>/dev/null | grep -v '^lo'
for f in /sys/class/net/*/speed; do
  [ -r "$f" ] && printf '%s = %s (-1 = virtio does not report)\n' "$f" "$(cat "$f" 2>/dev/null)"
done

sec "NETWORK — REAL EGRESS THROUGHPUT"
echo "-- This is THE number: your uplink is the binding constraint at 100 players."
if have speedtest-cli; then speedtest-cli --simple 2>&1 | head -5
else
  echo "(speedtest-cli absent; using Cachefly 100MB as a rough upper bound)"
  curl -so /dev/null -w 'download: %{speed_download} B/s = %{size_download} bytes in %{time_total}s\n' \
       --max-time 45 https://cachefly.cachefly.net/100mb.test 2>&1 \
    || echo "(egress test blocked or timed out)"
fi

sec "NGINX — CONFIG + CACHE HEADERS"
nginx -v 2>&1
echo; echo "-- server blocks and any existing cache/gzip directives"
sudo -n nginx -T 2>/dev/null | grep -nE 'server_name|location|root |expires|add_header|gzip|brotli|sendfile|tcp_nopush|worker_(processes|connections)' \
  || echo "(needs sudo: re-run with sudo, or: sudo nginx -T | grep -E 'location|add_header|expires')"
echo; echo "-- what the game path actually returns today"
for p in games/medieval/js/game3d.js games/medieval/models/wolf.glb; do
  echo "--- /$p"
  curl -sS -o /dev/null -D - --max-time 15 "http://127.0.0.1/$p" 2>&1 \
    | grep -iE '^(HTTP|content-type|content-encoding|cache-control|etag|content-length)' || echo "(no local vhost match)"
done

sec "PM2 + SERVICES"
echo "-- ubuntu daemon (the real one)"; pm2 list 2>&1 | head -20
echo; echo "-- root daemon (expected: EMPTY = safe to 'sudo pm2 kill')"
sudo -n pm2 list 2>&1 | head -20 || echo "(needs sudo)"
echo; echo "-- pm2 startup units"; systemctl list-units --type=service --all 2>/dev/null | grep -i pm2 || echo "(none)"
echo; echo "-- root pm2 saved dump (expect empty/absent)"
sudo -n cat /root/.pm2/dump.pm2 2>/dev/null | head -5 || echo "(needs sudo, or file absent — both fine)"

sec "BRAVO — RUNTIME STATE"
curl -sS --max-time 10 localhost:2567/health; echo
echo; echo "-- data dir: these files drive the O(objects x players) broadcast finding"
ls -la /home/ubuntu/bravo-server/data/ 2>/dev/null || echo "(no data dir)"
for f in placed_objects.json houses.json players.json; do
  p="/home/ubuntu/bravo-server/data/$f"
  [ -f "$p" ] && printf '%-22s %8s bytes, %s top-level entries\n' "$f" "$(stat -c%s "$p")" \
    "$(python3 -c "import json;d=json.load(open('$p'));print(len(d))" 2>/dev/null || echo '?')"
done
echo; echo "-- sqlite"
if [ -f /home/ubuntu/bravo-server/data/bravo.db ]; then
  ls -la /home/ubuntu/bravo-server/data/bravo.db*
  have sqlite3 && sqlite3 /home/ubuntu/bravo-server/data/bravo.db \
    "select count(*) as players, round(sum(length(coalesce(blob,'')))/1024.0,1) as blob_kb from players;" 2>&1
else echo "(no sqlite db — running on the JSON fallback, worth knowing)"; fi
echo; echo "-- recent errors"
tail -25 /home/ubuntu/.pm2/logs/bravo-error.log 2>/dev/null || echo "(no error log)"

sec "STATIC ASSET FOOTPRINT ON DISK"
for d in /var/www/orion-syndicate /var/www/html/games/medieval /home/ubuntu/orion-platform; do
  [ -d "$d" ] && { echo "--- $d"; du -sh "$d" 2>/dev/null; du -sh "$d"/* 2>/dev/null | sort -rh | head -8; }
done

sec "CO-TENANT: DOES orion-platform USE MONGO?"
grep -rIl --include=*.js --include=*.json -e mongo -e mongoose \
  /home/ubuntu/orion-platform 2>/dev/null | head -5 || echo "(no mongo references found — those 87MB may be reclaimable)"

sec "JOURNALD"
journalctl --disk-usage 2>/dev/null
grep -E '^\s*SystemMaxUse' /etc/systemd/journald.conf 2>/dev/null || echo "SystemMaxUse: unset (uncapped — this is the 121MB)"

sec "IDLE DAEMONS WORTH DISABLING"
for s in fwupd multipathd snapd; do
  printf '%-12s %s\n' "$s" "$(systemctl is-active $s 2>/dev/null || echo absent)"
done

printf '\n\n===== END — paste this whole file back =====\n'
