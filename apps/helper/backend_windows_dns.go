//go:build windows

package helper

import (
	"fmt"

	"github.com/tunnexio/tunnex/apps/helper/internal/wfp"
)

var replaceScopedDNSResolvers = wfp.ReplaceScopedDNSResolvers
var installWindowsResolvers = setResolvers

// SetResolvers preserves the existing IPC verb while pairing Windows NRPT with
// narrowly scoped full-tunnel WFP permits. PowerShell never holds b.mu, so owner
// loss can close the tunnel immediately. A late NRPT result is swept before the
// next resolver request can run, including after a disconnect/reconnect.
func (b *windowsBackend) SetResolvers(desired []ResolverForward) error {
	b.resolverMu.Lock()
	defer b.resolverMu.Unlock()
	addresses, err := scopedResolverAddresses(desired)
	if err != nil {
		return err
	}
	b.mu.Lock()
	current := b.dev
	if current == nil && len(desired) > 0 {
		b.mu.Unlock()
		return &ProtocolError{Code: "not_up", Msg: "no tunnel is up"}
	}
	if b.fullTunnel && current != nil {
		if !hasV6Default(b.peerAllowedIPs) {
			for _, address := range addresses {
				if address.Is6() {
					b.mu.Unlock()
					return &ProtocolError{Code: "invalid_resolver_ip", Msg: "IPv6 resolver requires a tunneled IPv6 route"}
				}
			}
		}
		// Replace before NRPT: withdrawn destinations lose permission even if a
		// later resolver write fails. The default DNS filters stay untouched.
		if err := replaceScopedDNSResolvers(b.luid, addresses); err != nil {
			b.mu.Unlock()
			return &ProtocolError{Code: "resolver_firewall_failed", Msg: fmt.Sprintf("updating scoped DNS permissions: %v", err)}
		}
	}
	b.mu.Unlock()
	err = installWindowsResolvers(desired)
	b.mu.Lock()
	stale := b.dev != current
	b.mu.Unlock()
	if stale {
		if cleanup := installWindowsResolvers(nil); cleanup != nil {
			return cleanup
		}
		return &ProtocolError{Code: "not_up", Msg: "resolver session changed during apply"}
	}
	return err
}
