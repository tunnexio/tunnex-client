//go:build natproof && linux

package helper

import (
	"context"
	"fmt"
	"net"
	"os"
	"os/exec"
	"strings"
	"testing"

	"github.com/pion/ice/v4"
)

func proofKernel(t *testing.T, s *ice.Conn, private, public, dir string, ctx context.Context) {
	if os.Getenv("NAT_PROOF_CONTAINER") != "yes" {
		t.Fatal("isolated fixture required")
	}
	run := func(args ...string) {
		t.Helper()
		if exec.Command("ip", args...).Run() != nil {
			t.Fatal("fixture interface command failed")
		}
	}
	run("link", "add", "nat0-wg", "type", "wireguard")
	defer exec.Command("ip", "link", "del", "nat0-wg").Run()
	u, e := net.DialUDP("udp4", &net.UDPAddr{IP: net.IPv4(127, 0, 0, 1)}, &net.UDPAddr{IP: net.IPv4(127, 0, 0, 1), Port: 51829})
	if e != nil {
		t.Fatal(e)
	}
	defer u.Close()
	c := exec.Command("wg", "setconf", "nat0-wg", "/dev/stdin")
	c.Stdin = strings.NewReader(fmt.Sprintf("[Interface]\nPrivateKey=%s\nListenPort=51829\n[Peer]\nPublicKey=%s\nAllowedIPs=10.250.0.1/32\nEndpoint=%s\n", private, public, u.LocalAddr()))
	if c.Run() != nil {
		t.Fatal("kernel configure")
	}
	run("addr", "add", "10.250.0.2/24", "dev", "nat0-wg")
	run("addr", "add", "10.250.0.3/32", "dev", "nat0-wg")
	run("link", "set", "nat0-wg", "up")
	go func() {
		b := make([]byte, 65535)
		for {
			n, e := u.Read(b)
			if e != nil {
				return
			}
			if _, e = s.Write(b[:n]); e != nil {
				return
			}
		}
	}()
	go func() {
		b := make([]byte, 65535)
		for {
			n, e := s.Read(b)
			if e != nil {
				return
			}
			if _, e = u.Write(b[:n]); e != nil {
				return
			}
		}
	}()
	proofHTTP(t, dir, ctx)
}
func proofDesktop(t *testing.T, _ *ice.Conn, _, _, _ string, _ context.Context) {
	t.Fatal("desktop role requires macOS")
}
