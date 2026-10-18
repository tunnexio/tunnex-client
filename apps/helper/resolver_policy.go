package helper

import (
	"net/netip"
	"sort"
	"strings"
)

// scopedResolverAddresses validates the complete scoped-DNS snapshot before an
// OS resolver or firewall mutation. It never expands a source subnet into an
// allowlist: only the exact resolver addresses in this snapshot are returned.
func scopedResolverAddresses(desired []ResolverForward) ([]netip.Addr, error) {
	byDomain := map[string]netip.Addr{}
	ips := map[netip.Addr]bool{}
	for _, forward := range desired {
		domain, err := safeResolverDomain(forward.Domain)
		if err != nil {
			return nil, err
		}
		ip, err := netip.ParseAddr(strings.TrimSpace(forward.ResolverIP))
		if err != nil || ip.Zone() != "" || !ip.IsGlobalUnicast() || ip.IsLoopback() {
			return nil, &ProtocolError{Code: "invalid_resolver_ip", Msg: "scoped resolver requires a unicast IP address"}
		}
		ip = ip.Unmap()
		if prior, exists := byDomain[domain]; exists && prior != ip {
			return nil, &ProtocolError{Code: "resolver_domain_conflict", Msg: "a domain has conflicting resolver addresses"}
		}
		byDomain[domain] = ip
		ips[ip] = true
	}
	out := make([]netip.Addr, 0, len(ips))
	for ip := range ips {
		out = append(out, ip)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Less(out[j]) })
	return out, nil
}
