//go:build windows

package helper

import (
	"golang.zx2c4.com/wireguard/device"
	"testing"
)

func TestWindowsRelayPeerSwapRefusedBeforeMutation(t *testing.T) {
	for _, endpoint := range []string{"192.0.2.1:51820", "192.0.2.2:51820"} {
		b := &windowsBackend{dev: &device.Device{}, relay: &relayNegotiation{}, peerPubKey: "original"}
		err := b.SetGatewayPeer(goodConfig().PeerPublicKey, endpoint)
		if err == nil || codeOf(err) != "relay_rehome_requires_reconnect" || b.peerPubKey != "original" {
			t.Fatalf("unsafe swap: %v", err)
		}
	}
}

func TestWindowsRelayFullTunnelRefusedBeforeHostChanges(t *testing.T) {
	b := &windowsBackend{}
	cfg := goodConfig()
	cfg.FullTunnel = true
	// Deliberately no live endpoint: the guard must run before negotiation or
	// Wintun/WFP access. This is not a native forwarding acceptance test.
	cfg.relay = &relayNegotiation{}
	if err := b.Up(cfg); err == nil || codeOf(err) != "relay_unavailable" {
		t.Fatalf("expected clean relay refusal, got %v", err)
	}
	if b.dev != nil || b.armed || b.relay != nil || b.luid != 0 {
		t.Fatal("unsupported mode changed backend state")
	}
}
