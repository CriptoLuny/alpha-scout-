#!/usr/bin/env bash
# aSCOUT bot installer/updater - Ubuntu 24.04 (Hetzner CX22). Run as root: bash setup.sh
set -e
RAW="${1:-https://raw.githubusercontent.com/CriptoLuny/alpha-scout-/main/bot}"
APP=/opt/ascout
export PLAYWRIGHT_BROWSERS_PATH=$APP/pw-browsers

echo "== Binance reachability =="
curl -s -o /dev/null -w "fapi HTTP %{http_code}\n" https://fapi.binance.com/fapi/v1/ping

apt-get update -y && apt-get install -y curl ca-certificates
if ! command -v node >/dev/null || [ "$(node -v | cut -c2- | cut -d. -f1)" -lt 20 ]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
fi

id ascout >/dev/null 2>&1 || useradd -r -m -d $APP -s /usr/sbin/nologin ascout
mkdir -p $APP && cd $APP
curl -fsSL "$RAW/ascout-bot.mjs" -o ascout-bot.mjs
curl -fsSL "$RAW/package.json"   -o package.json

npm install --omit=dev --no-audit --no-fund
npx playwright install --with-deps chromium

if [ ! -f .env ]; then
  read -rp "BOT_TOKEN: " TOK
  printf 'BOT_TOKEN=%s\nCHAT_ID=\nPAGE_URL=https://criptoluny.github.io/alpha-scout-/\nPRE_MIN=7\nDELAY_SEC=15\nCOOLDOWN_MIN=60\n' "$TOK" > .env
fi
chmod 600 .env
chown -R ascout:ascout $APP

cat >/etc/systemd/system/ascout.service <<UNIT
[Unit]
Description=aSCOUT Telegram scanner
After=network-online.target
Wants=network-online.target
[Service]
User=ascout
WorkingDirectory=$APP
Environment=PLAYWRIGHT_BROWSERS_PATH=$APP/pw-browsers
ExecStart=/usr/bin/node $APP/ascout-bot.mjs
Restart=always
RestartSec=10
[Install]
WantedBy=multi-user.target
UNIT

timedatectl set-ntp true || true
systemctl daemon-reload
systemctl enable ascout
systemctl restart ascout
echo "OK. Logs: journalctl -u ascout -f"
