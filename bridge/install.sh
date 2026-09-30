#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# Bethel Starlight — print bridge installer (Raspberry Pi / any Debian-family)
#
# On the Pi, after `ssh`-ing in, paste one line:
#
#   bash <(curl -fsSL https://raw.githubusercontent.com/Bethel-Church-of-Oregon/starlight_check_in/main/bridge/install.sh)
#
# or, from a copied bridge/ folder:  ./install.sh
#
# It installs Node.js (if needed), puts the bridge in ~/starlight-bridge,
# asks for the printer's IP, issues an HTTPS certificate, registers a systemd
# service that starts on boot, checks the printer, and prints the two values
# to enter in the app (bridge address + key).
#
# Safe to re-run: it keeps the existing settings and certificate unless you
# ask to change them, and updates bridge.mjs to the latest version.
#
# Non-interactive use (every prompt has an environment variable):
#   PRINTER_HOST=192.168.1.50  BRIDGE_IP=192.168.1.60  BRIDGE_PORT=9443
#   BRIDGE_ORIGINS=https://starlight-check-in.vercel.app  BRIDGE_KEY=...
#   CERT_MODE=self|skip|keep   ASSUME_YES=1   INSTALL_DIR=~/starlight-bridge
#   BRIDGE_REF=main            NO_SYSTEMD=1 (containers/tests only)
# ---------------------------------------------------------------------------
set -euo pipefail

REPO="Bethel-Church-of-Oregon/starlight_check_in"
REF="${BRIDGE_REF:-main}"
RAW="https://raw.githubusercontent.com/${REPO}/${REF}/bridge"
DEFAULT_ORIGINS="https://starlight-check-in.vercel.app"
NODE_MAJOR=24          # Node 20 is end-of-life; 24 is LTS until 2028
MIN_NODE_MAJOR=18      # what bridge.mjs actually needs
SERVICE=starlight-bridge

# --- output helpers --------------------------------------------------------
if [ -t 1 ]; then B=$'\e[1m'; G=$'\e[32m'; Y=$'\e[33m'; R=$'\e[31m'; N=$'\e[0m'; else B= G= Y= R= N=; fi
step() { printf '\n%s==> %s%s\n' "$B" "$1" "$N"; }
ok()   { printf '  %s✓%s %s\n' "$G" "$N" "$1"; }
warn() { printf '  %s!%s %s\n' "$Y" "$N" "$1"; }
die()  { printf '\n%s✗ %s%s\n' "$R" "$1" "$N" >&2; exit 1; }

# Prompts read from the terminal even when the script itself arrives on stdin.
INTERACTIVE=0
if [ "${ASSUME_YES:-0}" != 1 ] && { : </dev/tty; } 2>/dev/null; then INTERACTIVE=1; fi

# ask VAR "question" "default" — an already-set VAR (from the environment) wins.
ask() {
  local var=$1 question=$2 default=${3:-} reply
  if [ -n "${!var:-}" ]; then return; fi
  if [ "$INTERACTIVE" = 1 ]; then
    read -r -p "  $question${default:+ [$default]}: " reply </dev/tty || true
    printf -v "$var" '%s' "${reply:-$default}"
  else
    printf -v "$var" '%s' "$default"
  fi
}

# yes_no "question" default(y|n) — returns 0 for yes.
yes_no() {
  local question=$1 default=$2 reply
  if [ "$INTERACTIVE" != 1 ]; then [ "$default" = y ]; return; fi
  read -r -p "  $question [$( [ "$default" = y ] && echo Y/n || echo y/N )]: " reply </dev/tty || true
  reply=${reply:-$default}
  [[ "$reply" =~ ^[Yy] ]]
}

valid_ipv4() {
  local ip=$1 IFS=. part
  [[ "$ip" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]] || return 1
  for part in $ip; do [ "$part" -le 255 ] || return 1; done
}

# --- 0. preflight ----------------------------------------------------------
step "시작 전 확인"

[ "$(uname -s)" = Linux ] || die "리눅스(라즈베리파이 OS / Ubuntu)에서 실행해 주세요."
command -v apt-get >/dev/null || die "apt 를 쓰는 OS(라즈베리파이 OS, Ubuntu, Debian)가 필요합니다."

case "$(uname -m)" in
  aarch64|arm64|x86_64) ok "아키텍처: $(uname -m)" ;;
  armv7l|armv6l) die "32-bit OS 입니다. 최신 Node는 32-bit ARM을 지원하지 않습니다.
   Raspberry Pi Imager로 'Raspberry Pi OS Lite (64-bit)' 를 다시 설치해 주세요." ;;
  *) warn "확인되지 않은 아키텍처: $(uname -m) — 계속 진행합니다" ;;
esac

if [ "$(id -u)" = 0 ]; then
  SUDO=""
  RUN_USER="${SUDO_USER:-root}"
else
  command -v sudo >/dev/null || die "sudo 가 필요합니다."
  SUDO="sudo"
  RUN_USER="$(id -un)"
  sudo -v || die "sudo 권한이 필요합니다."
fi
RUN_HOME="$(getent passwd "$RUN_USER" | cut -d: -f6)"
INSTALL_DIR="${INSTALL_DIR:-$RUN_HOME/starlight-bridge}"
ok "설치 위치: $INSTALL_DIR (실행 사용자: $RUN_USER)"

# Run as the service user, so files end up owned by them.
as_user() {
  if [ "$(id -un)" = "$RUN_USER" ]; then "$@"
  elif [ "$(id -u)" = 0 ]; then runuser -u "$RUN_USER" -- "$@"
  else sudo -u "$RUN_USER" "$@"
  fi
}

# --- 1. packages + Node ----------------------------------------------------
step "필요한 프로그램 설치"

missing=()
for pkg in curl openssl; do command -v "$pkg" >/dev/null || missing+=("$pkg"); done
[ -e /etc/ssl/certs/ca-certificates.crt ] || missing+=(ca-certificates)
if [ ${#missing[@]} -gt 0 ]; then
  $SUDO apt-get update -qq
  $SUDO env DEBIAN_FRONTEND=noninteractive apt-get install -y -qq "${missing[@]}" >/dev/null
  ok "설치: ${missing[*]}"
else
  ok "curl, openssl 있음"
fi

node_major() { node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0; }
if command -v node >/dev/null && [ "$(node_major)" -ge "$MIN_NODE_MAJOR" ]; then
  ok "Node $(node -v) 있음"
else
  echo "  Node ${NODE_MAJOR} LTS 설치 중 (1~2분)…"
  curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | ${SUDO:+$SUDO -E} bash - >/dev/null 2>&1 \
    || die "NodeSource 저장소 등록 실패 — 인터넷 연결을 확인해 주세요."
  $SUDO env DEBIAN_FRONTEND=noninteractive apt-get install -y -qq nodejs >/dev/null
  ok "Node $(node -v) 설치됨"
fi
NODE_BIN="$(command -v node)"

# --- 2. bridge files -------------------------------------------------------
step "브릿지 파일"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd || echo "")"
as_user mkdir -p "$INSTALL_DIR/certs"

FILES=(bridge.mjs make-cert.sh config.example.json README.md)
if [ -n "$SCRIPT_DIR" ] && [ -f "$SCRIPT_DIR/bridge.mjs" ]; then
  if [ "$(realpath "$SCRIPT_DIR")" = "$(realpath "$INSTALL_DIR")" ]; then
    ok "이 폴더에서 바로 설치합니다"
  else
    for f in "${FILES[@]}"; do as_user cp "$SCRIPT_DIR/$f" "$INSTALL_DIR/$f"; done
    ok "로컬 파일 복사: $SCRIPT_DIR → $INSTALL_DIR"
  fi
else
  for f in "${FILES[@]}"; do
    as_user curl -fsSL "$RAW/$f" -o "$INSTALL_DIR/$f" || die "다운로드 실패: $RAW/$f"
  done
  ok "GitHub($REF)에서 최신 파일을 받았습니다"
fi
as_user chmod +x "$INSTALL_DIR/make-cert.sh"
node --check "$INSTALL_DIR/bridge.mjs" || die "bridge.mjs 가 손상되었습니다."

# --- 3. settings -----------------------------------------------------------
step "설정"

CONFIG="$INSTALL_DIR/config.json"
KEEP_CONFIG=0
OLD_PRINTER="" OLD_PORT="" OLD_KEY="" OLD_ORIGINS=""
if [ -f "$CONFIG" ]; then
  # Existing values become the defaults, so changing one answer (say, a new
  # printer IP) does not silently rotate the key the app already knows.
  eval "$(node -e '
    const c = require(process.argv[1])
    const q = (s) => "\x27" + String(s ?? "").replace(/\x27/g, "\x27\\\x27\x27") + "\x27"
    console.log(`OLD_PRINTER=${q(c.printerHost)}; OLD_PORT=${q(c.port)}; OLD_KEY=${q(c.key)}`)
    console.log(`OLD_ORIGINS=${q((c.allowedOrigins || []).join(","))}`)
  ' "$CONFIG")"
  echo "  기존 설정:"
  node -e '
    const c = require(process.argv[1])
    console.log(`    프린터 IP     ${c.printerHost}`)
    console.log(`    포트          ${c.port}`)
    console.log(`    허용된 앱     ${(c.allowedOrigins || []).join(", ") || "(모두)"}`)
  ' "$CONFIG"
  if [ -z "${PRINTER_HOST:-}" ] && yes_no "기존 설정을 그대로 쓸까요?" y; then KEEP_CONFIG=1; fi
fi

if [ "$KEEP_CONFIG" = 1 ]; then
  PRINTER_HOST="$OLD_PRINTER" BRIDGE_PORT="$OLD_PORT" BRIDGE_KEY="$OLD_KEY" BRIDGE_ORIGINS="$OLD_ORIGINS"
  ok "기존 설정 유지"
else
  while :; do
    ask PRINTER_HOST "프린터 IP (프린터 메뉴 → WLAN/유선 LAN → IP 주소)" "$OLD_PRINTER"
    valid_ipv4 "$PRINTER_HOST" && break
    [ "$INTERACTIVE" = 1 ] || die "PRINTER_HOST 가 올바른 IPv4 주소가 아닙니다: '${PRINTER_HOST}'"
    warn "IPv4 주소 형식이 아닙니다 (예: 192.168.1.50)"; PRINTER_HOST=""
  done
  ask BRIDGE_ORIGINS "앱 주소 (쉼표로 여러 개)" "${OLD_ORIGINS:-$DEFAULT_ORIGINS}"
  ask BRIDGE_PORT "브릿지 포트" "${OLD_PORT:-9443}"
  # Keep the key the app already has; only a first install makes a new one.
  BRIDGE_KEY="${BRIDGE_KEY:-${OLD_KEY:-$(openssl rand -hex 24)}}"
fi

# Reachability is informative only — the printer may simply be switched off.
if timeout 3 bash -c "exec 3<>/dev/tcp/$PRINTER_HOST/9100" 2>/dev/null; then
  ok "프린터 $PRINTER_HOST:9100 에 연결됨"
else
  warn "프린터 $PRINTER_HOST:9100 에 연결되지 않습니다 — 전원과 IP를 확인해 주세요 (설치는 계속합니다)"
fi

# --- 4. HTTPS certificate --------------------------------------------------
step "HTTPS 인증서"

detect_ip() {
  ip -4 route get 1.1.1.1 2>/dev/null | awk '{for (i = 1; i < NF; i++) if ($i == "src") { print $(i + 1); exit }}' \
    || true
}
LAN_IP="${BRIDGE_IP:-$(detect_ip)}"
[ -n "$LAN_IP" ] || LAN_IP="$(hostname -I 2>/dev/null | awk '{print $1}')"

HAVE_CERT=0
[ -f "$INSTALL_DIR/certs/bridge.crt" ] && [ -f "$INSTALL_DIR/certs/bridge.key" ] && HAVE_CERT=1

if [ -z "${CERT_MODE:-}" ]; then
  if [ "$HAVE_CERT" = 1 ]; then
    if openssl x509 -in "$INSTALL_DIR/certs/bridge.crt" -noout -ext subjectAltName 2>/dev/null | grep -q "IP Address:$LAN_IP\b"; then
      CERT_MODE=keep
      yes_no "기존 인증서가 이 파이의 IP($LAN_IP)와 맞습니다. 다시 발급할까요?" n && CERT_MODE=self
    else
      echo "  기존 인증서가 현재 IP($LAN_IP)용이 아니거나, 도메인 인증서입니다."
      CERT_MODE=keep
      yes_no "이 IP로 자체 인증서를 새로 발급할까요?" y && CERT_MODE=self
    fi
  else
    echo "  1) 자체 인증서 — 도메인이 없을 때. 아이패드에 인증서를 한 번 설치합니다 (권장)"
    echo "  2) 도메인 인증서 — Let's Encrypt 를 직접 설정 (README 4-A). 지금은 건너뜁니다"
    choice=""; ask choice "선택" "1"
    [ "$choice" = 2 ] && CERT_MODE=skip || CERT_MODE=self
  fi
fi

case "$CERT_MODE" in
  self)
    PI_IP="${BRIDGE_IP:-}"
    ask PI_IP "이 파이의 고정 IP (인증서에 들어갑니다)" "$LAN_IP"
    LAN_IP="$PI_IP"
    valid_ipv4 "$LAN_IP" || die "파이 IP가 올바르지 않습니다: '$LAN_IP'"
    (cd "$INSTALL_DIR" && as_user ./make-cert.sh "$LAN_IP" "$(hostname).local" >/dev/null)
    ok "인증서 발급: IP $LAN_IP, $(hostname).local (825일 유효)"
    HAVE_CERT=1 ;;
  keep) ok "기존 인증서 유지" ;;
  skip)
    warn "인증서를 건너뜁니다. certs/bridge.crt, certs/bridge.key 를 둔 뒤"
    warn "  sudo systemctl restart $SERVICE   로 시작하세요 (README 4-A)" ;;
  *) die "CERT_MODE 는 self, keep, skip 중 하나여야 합니다: '$CERT_MODE'" ;;
esac

# --- write config.json (node handles quoting) --------------------------------
# Values go in as arguments, not environment: sudo -u resets the environment.
as_user node -e '
  const fs = require("fs")
  const [file, printerHost, port, key, originList] = process.argv.slice(1)
  const origins = originList.split(",").map((s) => s.trim().replace(/\/+$/, "")).filter(Boolean)
  const config = {
    port: Number(port) || 9443,
    certFile: "certs/bridge.crt",
    keyFile: "certs/bridge.key",
    key,
    allowedOrigins: origins,
    printerHost,
    printerPort: 9100,
    preflightStatus: true,
  }
  fs.writeFileSync(file, JSON.stringify(config, null, 2) + "\n", { mode: 0o600 })
' "$CONFIG" "$PRINTER_HOST" "$BRIDGE_PORT" "$BRIDGE_KEY" "$BRIDGE_ORIGINS"
chmod 600 "$CONFIG" 2>/dev/null || $SUDO chmod 600 "$CONFIG"
ok "config.json 저장"

# --- 5. service --------------------------------------------------------------
step "자동 실행 등록"

if [ "${NO_SYSTEMD:-0}" = 1 ] || ! command -v systemctl >/dev/null || [ ! -d /run/systemd/system ]; then
  warn "systemd 를 쓸 수 없는 환경입니다 — 서비스 등록을 건너뜁니다"
  warn "  직접 실행: cd $INSTALL_DIR && node bridge.mjs"
  SERVICE_OK=0
else
  $SUDO tee "/etc/systemd/system/$SERVICE.service" >/dev/null <<UNIT
[Unit]
Description=Bethel Starlight print bridge
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$RUN_USER
WorkingDirectory=$INSTALL_DIR
ExecStart=$NODE_BIN $INSTALL_DIR/bridge.mjs
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
UNIT
  $SUDO systemctl daemon-reload
  $SUDO systemctl enable "$SERVICE" >/dev/null 2>&1
  if [ "$HAVE_CERT" = 1 ]; then
    $SUDO systemctl restart "$SERVICE"
    for _ in $(seq 1 20); do systemctl is-active --quiet "$SERVICE" && break; sleep 0.5; done
    if systemctl is-active --quiet "$SERVICE"; then
      ok "서비스 실행 중 — 재부팅해도 자동으로 켜집니다"
      SERVICE_OK=1
    else
      warn "서비스가 시작되지 않았습니다. 로그: journalctl -u $SERVICE -n 30"
      SERVICE_OK=0
    fi
  else
    ok "서비스 등록됨 (인증서를 둔 뒤 시작하세요)"
    SERVICE_OK=0
  fi

  # Ubuntu may ship with ufw enabled; Raspberry Pi OS has no firewall by default.
  if command -v ufw >/dev/null && $SUDO ufw status 2>/dev/null | grep -q "Status: active"; then
    $SUDO ufw allow "$BRIDGE_PORT/tcp" >/dev/null && ok "방화벽(ufw)에서 $BRIDGE_PORT 포트 열기"
  fi
fi

# --- 6. checks ---------------------------------------------------------------
step "점검"

if [ "${SERVICE_OK:-0}" = 1 ]; then
  sleep 1
  if curl -sk --max-time 5 "https://127.0.0.1:$BRIDGE_PORT/" | grep -q starlight-print-bridge; then
    ok "브릿지가 https://127.0.0.1:$BRIDGE_PORT 에서 응답합니다"
  else
    warn "브릿지가 응답하지 않습니다. 로그: journalctl -u $SERVICE -n 30"
  fi
fi

if (cd "$INSTALL_DIR" && as_user "$NODE_BIN" bridge.mjs --status 2>&1 | sed 's/^/  /'); then
  ok "프린터 정상"
else
  warn "프린터 상태를 확인해 주세요 (전원, 용지, IP)"
fi

# --- summary -----------------------------------------------------------------
BRIDGE_HOST="$LAN_IP"
if [ "$CERT_MODE" = keep ] && [ -f "$INSTALL_DIR/certs/bridge.crt" ]; then
  # A kept Let's Encrypt certificate names a domain, and only that name works.
  SAN="$(openssl x509 -in "$INSTALL_DIR/certs/bridge.crt" -noout -ext subjectAltName 2>/dev/null || true)"
  if ! grep -q "IP Address:$LAN_IP\b" <<<"$SAN"; then
    DOMAIN="$(grep -o 'DNS:[^, ]*' <<<"$SAN" | grep -v '\.local$' | head -1 | cut -d: -f2)"
    [ -n "$DOMAIN" ] && BRIDGE_HOST="$DOMAIN"
  fi
fi
BRIDGE_URL="https://$BRIDGE_HOST:$BRIDGE_PORT"
printf '\n%s──────────────────────────────────────────────────────────────%s\n' "$B" "$N"
printf '%s설치 완료%s\n\n' "$B" "$N"
printf '앱 세팅 → 프린터 탭에 입력하세요:\n'
printf '  브릿지 주소  %s%s%s\n' "$B" "$BRIDGE_URL" "$N"
printf '  브릿지 키    %s%s%s\n\n' "$B" "$BRIDGE_KEY" "$N"

if [ -f "$INSTALL_DIR/certs/ca.crt" ] && [ "$CERT_MODE" != skip ]; then
  printf '아이패드마다 인증서를 한 번 설치하세요 (Safari 에서):\n'
  printf '  1. %s%s/ca.crt%s 열기\n' "$B" "$BRIDGE_URL" "$N"
  printf '     "연결이 비공개로 설정되어 있지 않습니다" → 세부사항 보기 → 이 웹 사이트 방문\n'
  printf '  2. "구성 프로파일을 다운로드하려고 합니다" → 허용\n'
  printf '  3. 설정 → 일반 → VPN 및 기기 관리 → 다운로드된 프로파일 → 설치\n'
  printf '  4. 설정 → 일반 → 정보 → 인증서 신뢰 설정 → "Bethel Starlight Print Bridge CA" 켜기\n'
  printf '  5. Safari 에서 %s%s%s 를 다시 열어 경고 없이 {"ok":true,...} 가 보이면 끝\n\n' "$B" "$BRIDGE_URL" "$N"
  printf '  CA 지문(SHA-256): %s\n\n' "$(openssl x509 -in "$INSTALL_DIR/certs/ca.crt" -noout -fingerprint -sha256 | cut -d= -f2)"
fi

printf '파이 IP(%s)는 공유기에서 고정(DHCP 예약)해 두세요 — 바뀌면 인쇄가 멈춥니다.\n' "$LAN_IP"
printf '다시 실행하면 설정을 유지한 채 브릿지를 최신으로 업데이트합니다.\n'
printf '로그: journalctl -u %s -f\n' "$SERVICE"
