#!/usr/bin/env bash
# Dedicated, account-pinned developer fixture. Not a customer deployment path.
set -euo pipefail
repo=$(cd "$(dirname "$0")/.." && pwd)
mode=${1:-tcp}
case "$mode" in tcp) remote_url='turn:localhost:3478?transport=tcp';; tls) remote_url='turns:localhost:5349?transport=tcp';; *) exit 2;; esac
: "${NAT_SSH_KEY:?private SSH key path required}" "${NAT_KNOWN_HOSTS:?verified known-hosts path required}"
[[ $(aws sts get-caller-identity --query Account --output text) == 735391218823 ]]
instance=i-0d320abd28be9eaa9
[[ $(aws ec2 describe-instances --region ap-south-1 --instance-ids "$instance" --query 'Reservations[0].Instances[0].Tags[?Key==`Name`].Value|[0]' --output text) == tunnex-nat0-aws-20260906a ]]
host=$(aws ec2 describe-instances --region ap-south-1 --instance-ids "$instance" --query 'Reservations[0].Instances[0].PublicIpAddress' --output text)
[[ "$host" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]]
case "$mode" in
  tcp) client_url="turn:$host:13478?transport=tcp";;
  tls) client_url="turns:$host:15349?transport=tcp";;
esac
ssh_opts=(-i "$NAT_SSH_KEY" -o IdentitiesOnly=yes -o StrictHostKeyChecking=yes -o "UserKnownHostsFile=$NAT_KNOWN_HOSTS")
image=$(ssh "${ssh_opts[@]}" "ubuntu@$host" "sudo docker image inspect tunnex-nat0-kernel:20260906a --format '{{.Id}}'")
[[ "$image" =~ ^sha256:[a-f0-9]{64}$ ]]
umask 077
stage=$(mktemp -d /private/tmp/tunnex-aws-pion.XXXXXX)
name="tunnex-aws-pion-$(date -u +%Y%m%dT%H%M%S)-$$"
remote="/home/ubuntu/$name"
echo "AWS fixture $name on $instance; private local artifacts $stage"
CGO_ENABLED=1 go test -C "$repo/apps/helper" -mod=readonly -tags natproof -c -o "$stage/mac.test" .
CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go test -C "$repo/apps/helper" -mod=readonly -tags natproof -c -o "$stage/linux.test" .
cp "$repo/scripts/nat0-native-root.sh" "$stage/root.sh"
openssl req -x509 -newkey rsa:2048 -nodes -days 1 -keyout "$stage/key.pem" -out "$stage/cert.pem" \
  -subj /CN=localhost -addext "subjectAltName=DNS:localhost,IP:$host" >/dev/null 2>&1
NAT_STAGE="$stage" node - <<'NODE'
const fs=require('node:fs'),crypto=require('node:crypto'),p=process.env.NAT_STAGE;
const password=crypto.randomBytes(32).toString('hex');
fs.writeFileSync(p+'/turn.json',JSON.stringify({Username:'nat0',Password:password}),{mode:0o600});
fs.writeFileSync(p+'/turn.conf',`no-cli
verbose
no-dtls
listening-ip=0.0.0.0
relay-ip=127.0.0.1
min-port=49160
max-port=49200
realm=nat0.invalid
lt-cred-mech
user=nat0:${password}
allow-loopback-peers
no-multicast-peers
cert=/proof/cert.pem
pkey=/proof/key.pem
`,{mode:0o600});
NODE
ssh "${ssh_opts[@]}" "ubuntu@$host" "mkdir -m 700 '$remote'"
scp "${ssh_opts[@]}" "$stage/linux.test" "$stage/turn.json" "$stage/turn.conf" "$stage/cert.pem" "$stage/key.pem" "ubuntu@$host:$remote/"
ssh "${ssh_opts[@]}" "ubuntu@$host" "sudo docker run -d --name '$name' --cap-add NET_ADMIN --user 0:0 -p 13478:3478/tcp -p 15349:5349/tcp --mount 'type=bind,src=$remote,dst=/proof' --entrypoint turnserver '$image' -c /proof/turn.conf >/dev/null"
trap 'ssh "${ssh_opts[@]}" "ubuntu@$host" "sudo docker stop '\''$name'\'' >/dev/null"' EXIT
for attempt in {1..40}; do if nc -z -w 2 "$host" 15349; then break; fi; sleep 0.25; done
nc -z -w 2 "$host" 13478
ice_only=${NAT_PROOF_ICE_ONLY:-no}
[[ "$ice_only" == yes || "$ice_only" == no ]]
ssh "${ssh_opts[@]}" "ubuntu@$host" "sudo docker exec -e NAT_PROOF_START_BARRIER=yes -e NAT_PROOF_ICE_ONLY='$ice_only' -e NAT_PROOF_CONTAINER=yes -e NAT_PROOF_DIR=/proof -e NAT_PROOF_ROLE=server -e 'TURN_URL=$remote_url' '$name' /proof/linux.test -test.run '^TestNativePionProof$' -test.v -test.timeout=110s" &
server_pid=$!
for attempt in {1..100}; do
  if ssh "${ssh_opts[@]}" "ubuntu@$host" "test -f '$remote/server.json'"; then break; fi
  sleep 0.1
done
scp "${ssh_opts[@]}" "ubuntu@$host:$remote/server.json" "$stage/server.incoming"
mv "$stage/server.incoming" "$stage/server.json"
# Transfer only known private signaling files; no public signaling endpoint.
(
  for file in client.json; do
    for attempt in {1..500}; do [[ -f "$stage/$file" ]] && break; sleep 0.1; done
    scp "${ssh_opts[@]}" "$stage/$file" "ubuntu@$host:$remote/$file.incoming"
    ssh "${ssh_opts[@]}" "ubuntu@$host" "mv '$remote/$file.incoming' '$remote/$file'"
  done
  for attempt in {1..100}; do
    if ssh "${ssh_opts[@]}" "ubuntu@$host" "test -f '$remote/server-prepared.json'"; then break; fi
    sleep 0.1
  done
  for attempt in {1..100}; do [[ -f "$stage/client-prepared.json" ]] && break; sleep 0.1; done
  [[ -f "$stage/client-prepared.json" ]]
  ssh "${ssh_opts[@]}" "ubuntu@$host" "test -f '$remote/server-prepared.json'"
  printf true > "$stage/start.incoming"
  scp "${ssh_opts[@]}" "$stage/start.incoming" "ubuntu@$host:$remote/start.incoming"
  ssh "${ssh_opts[@]}" "ubuntu@$host" "mv '$remote/start.incoming' '$remote/start.json'"
  mv "$stage/start.incoming" "$stage/start.json"
  if [[ "$ice_only" == yes ]]; then exit 0; fi
  for attempt in {1..100}; do
    if ssh "${ssh_opts[@]}" "ubuntu@$host" "test -f '$remote/ready.json'"; then break; fi
    sleep 0.1
  done
  scp "${ssh_opts[@]}" "ubuntu@$host:$remote/ready.json" "$stage/ready.incoming"
  mv "$stage/ready.incoming" "$stage/ready.json"
  for attempt in {1..500}; do [[ -f "$stage/done.json" ]] && break; sleep 0.1; done
  scp "${ssh_opts[@]}" "$stage/done.json" "ubuntu@$host:$remote/done.json.incoming"
  ssh "${ssh_opts[@]}" "ubuntu@$host" "mv '$remote/done.json.incoming' '$remote/done.json'"
) &
signal_pid=$!
if [[ "$ice_only" == yes ]]; then
  NAT_PROOF_START_BARRIER=yes NAT_PROOF_ICE_ONLY=yes NAT_PROOF_ROLE=client NAT_PROOF_DIR="$stage" TURN_URL="$client_url" \
    "$stage/mac.test" -test.run '^TestNativePionProof$' -test.v -test.timeout=110s
  wait "$signal_pid"; wait "$server_pid"
  echo 'ICE-only diagnostic completed; no helper or traffic qualification'
  exit 0
fi
osascript - "$stage/root.sh" "$mode" "$host" <<'APPLESCRIPT'
on run argv
  do shell script "/bin/sh " & quoted form of (item 1 of argv) & " " & quoted form of (item 2 of argv) & " " & quoted form of (item 3 of argv) with administrator privileges
end run
APPLESCRIPT
wait "$signal_pid"
wait "$server_pid"
restored=false
for attempt in {1..40}; do
  if /usr/local/tunnex/tunnelctl status 2>/dev/null | grep -q '"state": "down"'; then restored=true; break; fi
  sleep 0.25
done
[[ "$restored" == true ]]
if [[ "$mode" == tls ]]; then
  NAT_PROOF_REJECT_CA=yes NAT_PROOF_ROLE=client NAT_PROOF_DIR="$stage" TURN_URL="turns:$host:15349?transport=tcp" \
    "$stage/mac.test" -test.run '^TestNativePionProof$' -test.v -test.timeout=30s
fi
echo "PASS AWS $mode packet fixture $name; NOT CP policy/GUI acceptance"
