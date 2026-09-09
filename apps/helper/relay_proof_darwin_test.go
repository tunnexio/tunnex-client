//go:build darwin

package helper

import (
	"golang.zx2c4.com/wireguard/conn"
	"strings"
	"testing"
)

func TestRelayProofCannotChangeDefaultBackendOrFullTunnel(t *testing.T) {
	if NewBackend().(*darwinBackend).proofBind != nil {
		t.Fatal("production backend selects proof transport")
	}
	called := false
	b := &darwinBackend{proofBind: func(*TunnelConfig) (conn.Bind, error) { called = true; return nil, nil }}
	if err := b.Up(&TunnelConfig{FullTunnel: true}); err == nil {
		t.Fatal("full proof tunnel accepted")
	}
	if called {
		t.Fatal("factory reached before full-tunnel refusal")
	}
}

func TestRelayProofOmitsUDPRebindOnlyForInternalTransport(t *testing.T) {
	cfg := goodConfig()
	direct, err := (&darwinBackend{}).deviceConfig(cfg)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(direct, "listen_port=0\n") {
		t.Fatal("default listener changed")
	}
	b := &darwinBackend{proofBind: func(*TunnelConfig) (conn.Bind, error) { return nil, nil }}
	relay, err := b.deviceConfig(cfg)
	if err != nil {
		t.Fatal(err)
	}
	if relay != strings.Replace(direct, "listen_port=0\n", "", 1) {
		t.Fatal("relay changed unrelated config")
	}
	if strings.Contains(relay, "listen_port=") {
		t.Fatal("relay rebind remains")
	}
}
