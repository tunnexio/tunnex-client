//go:build natproof && darwin

package helper

import (
	"context"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"net/netip"
	"os"
	"testing"

	"github.com/pion/ice/v4"
	"github.com/tunnexio/tunnex/apps/helper/internal/relaybind"
	"golang.zx2c4.com/wireguard/conn"
)

func proofDesktop(t *testing.T, s *ice.Conn, private, public, dir string, ctx context.Context) {
	if os.Geteuid() != 0 {
		t.Fatal("native utun proof needs administrator")
	}
	if os.Getenv("NAT_PROOF_HELPER_STOPPED") != "yes" {
		t.Fatal("installed helper must be stopped")
	}
	used := false
	b := &darwinBackend{proofBind: func(c *TunnelConfig) (conn.Bind, error) {
		return relaybind.New(netip.MustParseAddrPort(c.Endpoint), func() (relaybind.Session, error) {
			if used {
				return nil, errors.New("proof session exhausted")
			}
			used = true
			return s, nil
		})
	}}
	cfg := &TunnelConfig{PrivateKey: private, PeerPublicKey: public, Endpoint: "192.0.2.1:51820", Address: "10.250.0.1/32", AllowedIPs: []string{"10.250.0.2/32", "10.250.0.3/32"}, MTU: 1280}
	if e := cfg.Validate(); e != nil {
		t.Fatal(e)
	}
	defer func() {
		if e := b.Down(); e != nil {
			t.Error("backend cleanup:", e)
		}
	}()
	if e := b.Up(cfg); e != nil {
		t.Fatal("backend up:", e)
	}
	var ready bool
	proofRead(t, ctx, dir, "ready.json", &ready)
	proofRequests(t, func() {
		key, _ := base64.StdEncoding.DecodeString(public)
		// Keep both owned OS routes so denied packets cannot escape the default
		// interface. Exercise cryptokey denial, NOT the CP policy compiler.
		if e := b.dev.IpcSet("public_key=" + hex.EncodeToString(key) + "\nreplace_allowed_ips=true\nallowed_ip=10.250.0.2/32\n"); e != nil {
			t.Fatal("restrict peer")
		}
	}, func() { s.Close() })
	proofWrite(t, dir, "done.json", true)
}
func proofKernel(t *testing.T, _ *ice.Conn, _, _, _ string, _ context.Context) {
	t.Fatal("kernel role requires Linux")
}
