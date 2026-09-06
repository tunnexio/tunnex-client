#!/usr/bin/env bash
# Opt-in, administrator-confirmed native backend proof. No published UDP ports.
set -euo pipefail
repo=$(cd "$(dirname "$0")/.." && pwd)
mode=${1:-tcp}
case "$mode" in tcp) remote_url='turn:localhost:3478?transport=tcp';; tls) remote_url='turns:localhost:5349?transport=tcp';; *) exit 2;; esac
umask 077
stage=$(mktemp -d /private/tmp/tunnex-native-pion.XXXXXX)
name="tunnex-native-pion-$(date -u +%Y%m%dT%H%M%S)-$$"
image=$(docker image inspect tunnex-nat0-kernel:20260906a --format '{{.Id}}')
echo "Fixture: $name; private artifacts retained: $stage"
CGO_ENABLED=1 go test -C "$repo/apps/helper" -mod=readonly -tags natproof -c -o "$stage/mac.test" .
CGO_ENABLED=0 GOOS=linux GOARCH=arm64 go test -C "$repo/apps/helper" -mod=readonly -tags natproof -c -o "$stage/linux.test" .
cp "$repo/scripts/nat0-native-root.sh" "$stage/root.sh"
openssl req -x509 -newkey rsa:2048 -nodes -days 1 -keyout "$stage/key.pem" -out "$stage/cert.pem" \
  -subj /CN=localhost -addext subjectAltName=DNS:localhost >/dev/null 2>&1
export NAT_STAGE="$stage"
node -e 'const fs=require("node:fs"),crypto=require("node:crypto");fs.writeFileSync(process.env.NAT_STAGE+"/turn.json",JSON.stringify({Username:"nat0",Password:crypto.randomBytes(32).toString("hex")}),{mode:0o600})'
export TURN_USERNAME=nat0 TURN_PASSWORD
TURN_PASSWORD=$(node -e 'process.stdout.write(JSON.parse(require("node:fs").readFileSync(process.env.NAT_STAGE+"/turn.json")).Password)')
# Docker's internal network drops host port publication on this runtime.
# Dedicated bridge; only localhost TCP publications, never host networking.
docker network create "$name" >/dev/null
docker run -d --name "$name" --network "$name" --cap-add NET_ADMIN --user 0:0 \
  -p 127.0.0.1:13478:3478/tcp -p 127.0.0.1:15349:5349/tcp \
  --mount "type=bind,src=$stage,dst=/proof" -e TURN_USERNAME -e TURN_PASSWORD \
  --entrypoint turnserver "$image" -n --no-cli --no-dtls --listening-ip=0.0.0.0 \
  --relay-ip=127.0.0.1 --min-port=49160 --max-port=49200 --realm=nat0.invalid \
  --lt-cred-mech --user "$TURN_USERNAME:$TURN_PASSWORD" --allow-loopback-peers \
  --no-multicast-peers --cert=/proof/cert.pem --pkey=/proof/key.pem >/dev/null
trap 'docker stop "$name" >/dev/null' EXIT
for attempt in {1..40}; do
  if docker exec "$name" sh -c 'grep -q ":14E5 " /proc/net/tcp'; then break; fi
  sleep 0.25
done
# Fail before administrator authentication if host-to-fixture TCP is unavailable.
nc -z -w 2 127.0.0.1 13478
nc -z -w 2 127.0.0.1 15349
docker exec -e NAT_PROOF_CONTAINER=yes -e NAT_PROOF_DIR=/proof -e NAT_PROOF_ROLE=server \
  -e "TURN_URL=$remote_url" "$name" /proof/linux.test -test.run '^TestNativePionProof$' -test.v -test.timeout=110s &
server_pid=$!
osascript - "$stage/root.sh" "$mode" <<'APPLESCRIPT'
on run argv
  do shell script "/bin/sh " & quoted form of (item 1 of argv) & " " & quoted form of (item 2 of argv) with administrator privileges
end run
APPLESCRIPT
wait "$server_pid"
restored=false
for attempt in {1..40}; do
  if /usr/local/tunnex/tunnelctl status 2>/dev/null | grep -q '"state": "down"'; then restored=true; break; fi
  sleep 0.25
done
if [[ "$restored" != true ]]; then echo 'Helper did not return idle after restart' >&2; exit 1; fi
if [[ "$mode" == tls ]]; then
  NAT_PROOF_REJECT_CA=yes NAT_PROOF_ROLE=client NAT_PROOF_DIR="$stage" \
    TURN_URL='turns:localhost:15349?transport=tcp' "$stage/mac.test" \
    -test.run '^TestNativePionProof$' -test.v -test.timeout=30s
fi
echo "PASS $mode native fixture $name (container/network retained; no CP-policy claim)"
