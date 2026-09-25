#!/usr/bin/env bash
# Guided MediaMTX install for the WEB SERVER (Ubuntu/Debian, x86-64 or ARM64).
# Run from the site folder:   sudo bash cameras/install.sh
#
# It will:
#   1. download MediaMTX (the program that turns camera streams into web video),
#   2. ask for your recorder's address, a view-only user and its password,
#   3. write /etc/mediamtx.yml (readable only by the site's user), start the service,
#   4. check that stall 1 is reachable.
# Nothing is opened to the internet: MediaMTX only listens on 127.0.0.1.
set -euo pipefail

say()  { printf '\n\033[1m%s\033[0m\n' "$*"; }
fail() { printf '\n\033[31mStopped: %s\033[0m\n' "$*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || fail "run this with sudo:  sudo bash cameras/install.sh"
command -v node >/dev/null || fail "Node.js isn't installed (the website needs it too)."
command -v curl >/dev/null || fail "curl isn't installed:  sudo apt install curl"
here="$(cd "$(dirname "$0")" && pwd)"

case "$(uname -m)" in
  x86_64|amd64) arch=amd64 ;;
  aarch64|arm64) arch=arm64 ;;
  *) fail "unsupported processor $(uname -m)" ;;
esac

say "1/4  Tailscale (private link to the ranch)"
if command -v tailscale >/dev/null && tailscale status >/dev/null 2>&1; then
  echo "Tailscale is connected."
else
  echo "Tailscale isn't connected yet. Install it with:"
  echo "   curl -fsSL https://tailscale.com/install.sh | sh && sudo tailscale up --accept-routes"
  echo "then run this script again."
  exit 1
fi

say "2/4  Downloading MediaMTX"
tag="$(curl -fsSL https://api.github.com/repos/bluenviron/mediamtx/releases/latest | sed -n 's/.*"tag_name": *"\([^"]*\)".*/\1/p' | head -1)"
[ -n "$tag" ] || fail "couldn't find the latest MediaMTX release (is the server online?)"
tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
curl -fsSL -o "$tmp/mtx.tar.gz" "https://github.com/bluenviron/mediamtx/releases/download/${tag}/mediamtx_${tag}_linux_${arch}.tar.gz" \
  || fail "download failed for mediamtx ${tag} (${arch})"
tar -xzf "$tmp/mtx.tar.gz" -C "$tmp" mediamtx
install -m 0755 "$tmp/mediamtx" /usr/local/bin/mediamtx
echo "Installed MediaMTX ${tag}."

say "3/4  Your recorder"
echo "Tip: in your router, reserve a fixed IP address for the recorder so it never changes."
read -rp "Recorder (NVR) IP address, e.g. 192.168.8.20: " nvr_ip
[[ "$nvr_ip" =~ ^[0-9]{1,3}(\.[0-9]{1,3}){3}$ ]] || fail "that doesn't look like an IP address"
read -rp "View-only user name on the recorder: " nvr_user
read -rsp "That user's password (not shown): " nvr_pass; echo
read -rp "How many stall cameras? [8]: " count; count="${count:-8}"
[[ "$count" =~ ^[0-9]+$ ]] && [ "$count" -ge 1 ] && [ "$count" -le 16 ] || fail "enter a number from 1 to 16"
read -rp "Stream quality: sub (recommended, ~0.5 Mbps) or main? [sub]: " quality; quality="${quality:-sub}"
[[ "$quality" == "sub" || "$quality" == "main" ]] || fail "enter sub or main"
site_user="${SUDO_USER:-root}"
read -rp "Linux user that runs the website [${site_user}]: " u; site_user="${u:-$site_user}"
id "$site_user" >/dev/null 2>&1 || fail "no such user: $site_user"

# Symbols in a password would break the stream address, so encode them.
enc() { node -e 'process.stdout.write(encodeURIComponent(process.argv[1]))' "$1"; }
eu="$(enc "$nvr_user")"; ep="$(enc "$nvr_pass")"

{
  sed '/^paths:/,$d' "$here/mediamtx.yml"
  echo "paths:"
  for n in $(seq 1 "$count"); do
    printf '  stall%d:\n    source: "rtsp://%s:%s@%s:554/h264Preview_%02d_%s"\n' "$n" "$eu" "$ep" "$nvr_ip" "$n" "$quality"
  done
} > "$tmp/mediamtx.yml"
install -m 0600 -o "$site_user" "$tmp/mediamtx.yml" /etc/mediamtx.yml
sed "s/^User=.*/User=${site_user}/" "$here/mediamtx.service" > /etc/systemd/system/mediamtx.service
systemctl daemon-reload
systemctl enable --now mediamtx >/dev/null
systemctl restart mediamtx

say "4/4  Checking stall 1"
ok=""
for i in $(seq 1 10); do
  if curl -fsS -o /dev/null "http://127.0.0.1:8888/stall1/index.m3u8"; then ok=1; break; fi
  sleep 3
done
if [ -n "$ok" ]; then
  echo "Stall 1 is streaming."
else
  echo "Stall 1 didn't answer yet. Check: is the recorder on, RTSP enabled on it, the IP right,"
  echo "and the ranch route approved in Tailscale?   Logs:  journalctl -u mediamtx -n 50"
fi

say "Next"
echo "1. In the website's .env set:   CAMERA_ALLOWED_HOSTS=127.0.0.1"
echo "2. From the website folder run:  npm run cameras:setup -- --count ${count}"
echo "3. Restart the website, then check each camera in Admin → Cameras → Test."
