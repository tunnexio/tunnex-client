//go:build darwin

package helper

import (
	"golang.zx2c4.com/wireguard/conn"
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
