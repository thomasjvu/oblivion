#!/usr/bin/env bash
# Fix Docker/registry networking on spectre (HP laptop on public WiFi / xfinitywifi).
#
# Symptoms:
#   - lookup ... on 127.0.0.53:53: i/o timeout
#   - TLS handshake timeout to registry-1.docker.io / auth.docker.io
#   - curl to hostname hangs but curl to IP + Host header works
#
# Root causes on spectre:
#   1. Router DNS (172.20.20.1) often unreachable on xfinitywifi captive portal WiFi
#   2. Broken/slow IPv6 paths — curl/docker prefer IPv6 and hang
#   3. Docker Hub HTTPS often blocked on public WiFi (seed base image instead)
#
# This script is safe to re-run after reboot or network changes.
set -euo pipefail

HOST="${OBLIVION_BUILD_HOST:-spectre.thomasjvu.com}"
NODE_DIGEST="${OBLIVION_NODE_DIGEST:-sha256:7af03b14a13c8cdd38e45058fd957bf00a72bbe17feac43b1c15a689c029c732}"
SKIP_PULL="${OBLIVION_SKIP_DOCKER_PULL:-0}"

echo "==> Applying spectre Docker/network fix on $HOST"

ssh -o ServerAliveInterval=15 "$HOST" 'sudo bash -s' <<REMOTE
set -euo pipefail

# --- IPv4 preference (broken IPv6 on xfinitywifi) ---
cat > /etc/gai.conf <<'EOF'
precedence ::ffff:0:0/96  100
precedence ::1/128       50
precedence ::/0          10
EOF

# --- systemd-resolved: Comcast + Google DNS; router last (often broken on xfinitywifi) ---
mkdir -p /etc/systemd/resolved.conf.d
cat > /etc/systemd/resolved.conf.d/oblivion-dns.conf <<'EOF'
[Resolve]
DNS=75.75.75.75 8.8.8.8 172.20.20.1
FallbackDNS=8.8.4.4
DNSStubListener=no
DNSOverTLS=no
EOF
systemctl restart systemd-resolved

# --- resolv.conf: Comcast first, TCP DNS (UDP often filtered on public WiFi) ---
cat > /etc/resolv.conf <<'EOF'
nameserver 75.75.75.75
nameserver 8.8.8.8
nameserver 172.20.20.1
options use-vc ndots:1 timeout:2 attempts:2
EOF

# --- Persist DNS on active WiFi connection (NetworkManager) ---
WIFI_CON="\$(nmcli -t -f NAME,TYPE con show --active | awk -F: '\$2=="wifi"{print \$1; exit}')"
if [[ -n "\$WIFI_CON" ]]; then
  nmcli con mod "\$WIFI_CON" ipv4.dns "75.75.75.75 8.8.8.8 172.20.20.1"
  nmcli con mod "\$WIFI_CON" ipv4.ignore-auto-dns yes
  echo "Pinned DNS on NetworkManager connection: \$WIFI_CON"
fi

# --- /etc/hosts pins (hostname path workaround when DNS is slow/broken) ---
MARK="# oblivion-docker-hub"
if ! grep -q "\$MARK" /etc/hosts; then
  cat >> /etc/hosts <<'EOF'

# oblivion-docker-hub
104.18.43.178 auth.docker.io
104.18.43.178 production.cloudflare.docker.com
34.225.27.121 registry-1.docker.io
140.82.112.34 ghcr.io
185.199.108.154 pkg-containers.githubusercontent.com
EOF
else
  grep -q 'ghcr.io' /etc/hosts || echo '140.82.112.34 ghcr.io' >> /etc/hosts
  grep -q 'pkg-containers.githubusercontent.com' /etc/hosts || echo '185.199.108.154 pkg-containers.githubusercontent.com' >> /etc/hosts
fi

# --- Docker daemon ---
mkdir -p /etc/docker
cat > /etc/docker/daemon.json <<'EOF'
{
  "dns": ["75.75.75.75", "8.8.8.8", "172.20.20.1"],
  "max-concurrent-downloads": 2,
  "max-download-attempts": 5
}
EOF
systemctl restart docker
sleep 3

echo "==> Preflight checks"
curl -4 -sS -m15 -o /dev/null -w "ghcr.io: %{http_code}\n" https://ghcr.io/v2/ || true
curl -4 -sS -m15 -o /dev/null -w "registry-1.docker.io: %{http_code}\n" https://registry-1.docker.io/v2/ || true
curl -4 -sS -m15 -o /dev/null -w "auth.docker.io: %{http_code}\n" "https://auth.docker.io/token?scope=repository%3Alibrary%2Fhello-world%3Apull&service=registry.docker.io" || true

if [[ "${SKIP_PULL}" == "1" ]]; then
  echo "Skipping docker pull (OBLIVION_SKIP_DOCKER_PULL=1); seed base image with scripts/spectre-seed-node-image.sh"
  exit 0
fi

echo "==> Pre-pull node base image (tmux; survives SSH drops)"
NODE_IMAGE="node:22-bookworm-slim@${NODE_DIGEST}"
if docker image inspect "\$NODE_IMAGE" >/dev/null 2>&1; then
  echo "Base image already present"
  docker images "\$NODE_IMAGE" | head -2
  exit 0
fi
tmux kill-session -t oblivion-node-pull 2>/dev/null || true
tmux new-session -d -s oblivion-node-pull "docker pull \\\"\$NODE_IMAGE\\\" > /tmp/oblivion-node-pull.log 2>&1; echo exit:\\\$? >> /tmp/oblivion-node-pull.log"
for wait in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20 21 22 23 24 25 26 27 28 29 30; do
  if grep -q 'exit:0' /tmp/oblivion-node-pull.log 2>/dev/null; then
    echo "Base image pull OK"
    docker images "\$NODE_IMAGE" | head -2
    exit 0
  fi
  if grep -qE 'exit:[1-9]' /tmp/oblivion-node-pull.log 2>/dev/null; then
    tail -20 /tmp/oblivion-node-pull.log || true
    echo "Base image pull failed — run: bash scripts/spectre-seed-node-image.sh" >&2
    exit 1
  fi
  sleep 10
done
tail -20 /tmp/oblivion-node-pull.log || true
echo "Base image pull timed out — check: tmux attach -t oblivion-node-pull" >&2
exit 1
REMOTE

echo "Spectre Docker/network fix applied on $HOST"