#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# Self-signed certificates for the print bridge (no domain required).
#
#   ./make-cert.sh 192.168.1.60                 # the Pi's fixed LAN IP
#   ./make-cert.sh 192.168.1.60 starlight-pi.local
#
# Produces, in bridge/certs/:
#   ca.crt       install this on every iPad once (then enable Full Trust)
#   bridge.crt   \  the bridge serves these
#   bridge.key   /
#
# The CA is created once and reused, so renewing the server certificate later
# (every ~2 years) does NOT mean reinstalling anything on the iPads. Delete
# certs/ca.* only if you want to start over.
#
# iOS rules this follows: SAN is mandatory, EKU must include serverAuth, RSA
# 2048+, SHA-256, and a server certificate may not be valid for more than 825
# days — longer ones are silently rejected by Safari.
# ---------------------------------------------------------------------------
set -euo pipefail

if [[ $# -lt 1 ]]; then
  echo "usage: $0 <pi-lan-ip> [extra-hostname ...]" >&2
  exit 1
fi

cd "$(dirname "$0")"
mkdir -p certs
cd certs

IP="$1"; shift
SAN="IP:${IP}"
for name in "$@"; do SAN="${SAN},DNS:${name}"; done

if [[ ! -f ca.key || ! -f ca.crt ]]; then
  echo "→ creating local CA (valid 10 years)"
  openssl req -x509 -newkey rsa:2048 -sha256 -nodes \
    -keyout ca.key -out ca.crt -days 3650 \
    -subj "/CN=Bethel Starlight Print Bridge CA" \
    -addext "basicConstraints=critical,CA:TRUE" \
    -addext "keyUsage=critical,keyCertSign,cRLSign" 2>/dev/null
  chmod 600 ca.key
else
  echo "→ reusing existing CA (iPads that already trust it keep working)"
fi

echo "→ issuing bridge certificate for ${SAN} (valid 825 days)"
openssl req -newkey rsa:2048 -sha256 -nodes \
  -keyout bridge.key -out bridge.csr \
  -subj "/CN=${IP}" 2>/dev/null

cat > bridge.ext <<EXT
basicConstraints=CA:FALSE
keyUsage=critical,digitalSignature,keyEncipherment
extendedKeyUsage=serverAuth
subjectAltName=${SAN}
EXT

openssl x509 -req -sha256 -in bridge.csr -CA ca.crt -CAkey ca.key -CAcreateserial \
  -out bridge.crt -days 825 -extfile bridge.ext 2>/dev/null

rm -f bridge.csr bridge.ext
chmod 600 bridge.key

echo
echo "✓ done"
echo "  expires: $(openssl x509 -in bridge.crt -noout -enddate | cut -d= -f2)"
echo
echo "Next: send certs/ca.crt to each iPad (AirDrop or email), then"
echo "  Settings → General → VPN & Device Management → install the profile"
echo "  Settings → General → About → Certificate Trust Settings → enable it"
