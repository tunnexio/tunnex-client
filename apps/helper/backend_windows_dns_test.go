//go:build windows

package helper

import (
	"errors"
	"net/netip"
	"reflect"
	"testing"

	"golang.zx2c4.com/wireguard/device"
)

func TestWindowsScopedDNSReconcilesPermitsBeforeNRPT(t *testing.T) {
	oldPermit, oldInstall := replaceScopedDNSResolvers, installWindowsResolvers
	t.Cleanup(func() { replaceScopedDNSResolvers, installWindowsResolvers = oldPermit, oldInstall })
	backend := &windowsBackend{dev: &device.Device{}, fullTunnel: true, luid: 17, peerAllowedIPs: []string{"0.0.0.0/0"}}
	var events []string
	var permits [][]netip.Addr
	replaceScopedDNSResolvers = func(luid uint64, ips []netip.Addr) error {
		if luid != 17 {
			t.Fatalf("wrong interface: %d", luid)
		}
		events = append(events, "permits")
		permits = append(permits, append([]netip.Addr(nil), ips...))
		return nil
	}
	installWindowsResolvers = func(forwards []ResolverForward) error { events = append(events, "nrpt"); return nil }
	for _, forwards := range [][]ResolverForward{{{Domain: "aws.tunnex.app", ResolverIP: "10.99.0.1"}}, nil} {
		if err := backend.SetResolvers(forwards); err != nil {
			t.Fatal(err)
		}
	}
	if !reflect.DeepEqual(events, []string{"permits", "nrpt", "permits", "nrpt"}) {
		t.Fatal(events)
	}
	if len(permits) != 2 || len(permits[0]) != 1 || permits[0][0].String() != "10.99.0.1" || len(permits[1]) != 0 {
		t.Fatalf("scoped permission retained or expanded: %v", permits)
	}
	events = nil
	replaceScopedDNSResolvers = func(uint64, []netip.Addr) error { return errors.New("transaction failed") }
	if err := backend.SetResolvers([]ResolverForward{{Domain: "aws.tunnex.app", ResolverIP: "10.99.0.1"}}); err == nil || len(events) != 0 {
		t.Fatalf("NRPT changed after firewall refusal: %v %v", err, events)
	}
}

func TestWindowsScopedDNSRefusesUnroutedIPv6AndCleansLateSession(t *testing.T) {
	oldPermit, oldInstall := replaceScopedDNSResolvers, installWindowsResolvers
	t.Cleanup(func() { replaceScopedDNSResolvers, installWindowsResolvers = oldPermit, oldInstall })
	backend := &windowsBackend{dev: &device.Device{}, fullTunnel: true, luid: 17, peerAllowedIPs: []string{"0.0.0.0/0"}}
	calls := 0
	replaceScopedDNSResolvers = func(uint64, []netip.Addr) error { calls++; return nil }
	installWindowsResolvers = func([]ResolverForward) error { calls++; return nil }
	if err := backend.SetResolvers([]ResolverForward{{Domain: "v6.internal", ResolverIP: "fd00::53"}}); err == nil || calls != 0 {
		t.Fatalf("untunneled IPv6 allowed: %v calls%d", err, calls)
	}
	var installed []int
	installWindowsResolvers = func(f []ResolverForward) error {
		installed = append(installed, len(f))
		backend.mu.Lock()
		backend.dev = nil
		backend.mu.Unlock()
		return nil
	}
	if err := backend.SetResolvers([]ResolverForward{{Domain: "aws.tunnex.app", ResolverIP: "10.99.0.1"}}); err == nil {
		t.Fatal("stale apply reported success")
	}
	if !reflect.DeepEqual(installed, []int{1, 0}) {
		t.Fatalf("late NRPT not swept: %v", installed)
	}
	calls = 0
	if err := backend.SetResolvers([]ResolverForward{{Domain: "aws.tunnex.app", ResolverIP: "10.99.0.1"}}); err == nil || calls != 0 {
		t.Fatalf("down session mutated permits: %v", err)
	}
}
