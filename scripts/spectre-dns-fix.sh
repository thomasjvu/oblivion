#!/usr/bin/env bash
# Apply DNS fixes on spectre.thomasjvu.com when docker.io pulls fail with
# "lookup ... on 127.0.0.53:53: i/o timeout" or TLS handshake timeouts.
set -euo pipefail

HOST="${OBLIVION_BUILD_HOST:-spectre.thomasjvu.com}"

ssh "$HOST" 'sudo bash -s' <<'REMOTE'
set -euo pipefail
mkdir -p /etc/systemd/resolved.conf.d
cat > /etc/systemd/resolved.conf.d/oblivion-dns.conf <<EOF
[Resolve]
DNS=8.8.8.8 8.8.4.4
FallbackDNS=9.9.9.9
DNSStubListener=no
DNSOverTLS=no
EOF
systemctl restart systemd-resolved
printf "nameserver 8.8.8.8\nnameserver 8.8.4.4\n" > /etc/resolv.conf
mkdir -p /etc/docker
if [[ ! -f /etc/docker/daemon.json ]]; then
  echo '{"dns":["8.8.8.8","8.8.4.4"]}' > /etc/docker/daemon.json
fi
systemctl restart docker
resolvectl flush-caches || true
echo "DNS fix applied. Test with: docker pull node:22-bookworm-slim"
REMOTE

echo "Spectre DNS fix applied on $HOST"