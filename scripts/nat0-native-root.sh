#!/bin/sh
# Private prebuilt NAT-0 fixture only; no repository access required as root.
set -eu
stage=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
target=${2:-localhost}
expect=${3:-}
case "$expect" in ''|direct|relay) ;; *) exit 2;; esac
if [ "$target" != localhost ]; then
  case "$target" in ''|*[!0-9.]*) echo 'Invalid proof host' >&2; exit 2;; esac
fi
case "${1:-}" in
  tcp) turn_url="turn:$target:13478?transport=tcp";;
  tls) turn_url="turns:$target:15349?transport=tcp";;
  *) exit 2;;
esac
/usr/local/tunnex/tunnelctl status | /usr/bin/grep -q '"state": "down"'
# Conservative: refuse ANY explicit 10/8 route or assigned 10/8 address,
# regardless of interface. Never displace a pre-existing fixture-range route.
if /usr/sbin/netstat -rn -f inet | /usr/bin/awk '$1 ~ /^10([.\/]|$)/ {found=1} END {exit !found}'; then
  echo 'Existing 10/8 route; refusing fixed-address fixture' >&2; exit 1
fi
if /sbin/ifconfig | /usr/bin/awk '$1 == "inet" && $2 ~ /^10\./ {found=1} END {exit !found}'; then
  echo 'Existing 10/8 interface address; refusing fixture' >&2; exit 1
fi
for ip in 10.250.0.1 10.250.0.2 10.250.0.3; do
  if /sbin/route -n get "$ip" | /usr/bin/grep -q 'interface: utun'; then
    echo 'Fixture route overlaps an existing tunnel; refusing' >&2; exit 1
  fi
done
/bin/launchctl bootout system /Library/LaunchDaemons/io.tunnex.helper.plist
trap '/bin/launchctl bootstrap system /Library/LaunchDaemons/io.tunnex.helper.plist' EXIT
barrier=no
if [ "$target" != localhost ]; then barrier=yes; fi
NAT_PROOF_EXPECT_PATH="$expect" NAT_PROOF_START_BARRIER="$barrier" NAT_PROOF_HELPER_STOPPED=yes NAT_PROOF_ROLE=client NAT_PROOF_DIR="$stage" TURN_URL="$turn_url" \
  "$stage/mac.test" -test.run '^TestNativePionProof$' -test.v -test.timeout=110s
