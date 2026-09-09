//go:build darwin

package helper

import (
	"golang.zx2c4.com/wireguard/device"
	"testing"
)

func TestDarwinRelayPeerSwapRefusedBeforeMutation(t *testing.T) {
	for _, endpoint := range []string{"192.0.2.1:51820", "192.0.2.2:51820"} {
		b := &darwinBackend{dev: &device.Device{}, relay: &relayNegotiation{}, peerPubKey: "original"}
		err := b.SetGatewayPeer(goodConfig().PeerPublicKey, endpoint)
		if err == nil || codeOf(err) != "relay_rehome_requires_reconnect" || b.peerPubKey != "original" {
			t.Fatalf("unsafe swap: %v", err)
		}
	}
}
