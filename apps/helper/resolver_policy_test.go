package helper

import (
	"net/netip"
	"reflect"
	"testing"
)

func TestScopedResolverAddressesExactCurrentSnapshot(t *testing.T) {
	first := []ResolverForward{{Domain: "static.internal", ResolverIP: "10.99.0.1"}, {Domain: "aws.tunnex.app", ResolverIP: "10.99.0.1"}, {Domain: "v6.internal", ResolverIP: "fd00::53"}}
	got, err := scopedResolverAddresses(first)
	if err != nil || !reflect.DeepEqual(got, []netip.Addr{netip.MustParseAddr("10.99.0.1"), netip.MustParseAddr("fd00::53")}) {
		t.Fatalf("current resolver addresses: %v %v", got, err)
	}
	got, err = scopedResolverAddresses(first[:2])
	if err != nil || !reflect.DeepEqual(got, []netip.Addr{netip.MustParseAddr("10.99.0.1")}) {
		t.Fatalf("withdrawn IPv6 resolver survived: %v %v", got, err)
	}
	got, err = scopedResolverAddresses(nil)
	if err != nil || len(got) != 0 {
		t.Fatalf("empty must remove scoped permits: %v %v", got, err)
	}
}

func TestScopedResolverAddressesRejectConflictAndBroadAddresses(t *testing.T) {
	for _, invalid := range [][]ResolverForward{
		{{Domain: "aws.tunnex.app", ResolverIP: "10.99.0.1"}, {Domain: "AWS.TUNNEX.APP.", ResolverIP: "10.99.0.2"}},
		{{Domain: "aws.tunnex.app", ResolverIP: "0.0.0.0"}},
		{{Domain: "aws.tunnex.app", ResolverIP: "10.99.0.0/24"}},
		{{Domain: "aws.tunnex.app", ResolverIP: "224.0.0.53"}},
		{{Domain: "aws.tunnex.app", ResolverIP: "fe80::1%en0"}},
		{{Domain: "../resolver", ResolverIP: "10.99.0.1"}},
	} {
		if _, err := scopedResolverAddresses(invalid); err == nil {
			t.Fatalf("accepted invalid scoped resolver %v", invalid)
		}
	}
}
