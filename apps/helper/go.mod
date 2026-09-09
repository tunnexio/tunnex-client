module github.com/tunnexio/tunnex/apps/helper

// GUARD: builds/tests use GOFLAGS=-mod=readonly so dependency resolution cannot
// silently rewrite go.mod/go.sum. The module path matches the canonical repository.
//
// The core (protocol / config / auth / state / ipc) is STDLIB-ONLY. Deps are
// platform-only + never in the core test path: golang.org/x/sys (caller-path —
// SO_PEERCRED / LOCAL_PEERPID / GetNamedPipeClientProcessId) and Microsoft/go-winio
// (the Windows SDDL-protected named-pipe listener). Tunnel backends (wireguard-go /
// wireguard-nt) arrive later in build-tagged files. CI cross-compiles CGO_ENABLED=0,
// so any cgo file (e.g. macOS libproc) carries a no-cgo stub sibling.

go 1.25.13

require golang.org/x/sys v0.43.0

require (
	github.com/Microsoft/go-winio v0.6.2
	github.com/pion/ice/v4 v4.4.2
	github.com/pion/stun/v4 v4.0.0
	golang.org/x/crypto v0.50.0
	golang.zx2c4.com/wireguard v0.0.0-20260522210424-ecfc5a8d5446
	golang.zx2c4.com/wireguard/windows v1.0.1
)

require (
	github.com/google/uuid v1.6.0 // indirect
	github.com/pion/dtls/v3 v3.1.8 // indirect
	github.com/pion/logging v0.2.4 // indirect
	github.com/pion/mdns/v2 v2.2.0 // indirect
	github.com/pion/randutil v0.1.0 // indirect
	github.com/pion/transport/v4 v4.1.0 // indirect
	github.com/pion/turn/v5 v5.1.0 // indirect
	github.com/wlynxg/anet v0.0.5 // indirect
	golang.org/x/net v0.53.0 // indirect
	golang.org/x/time v0.14.0 // indirect
	golang.zx2c4.com/wintun v0.0.0-20230126152724-0fa3db229ce2 // indirect
)
