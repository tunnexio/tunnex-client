//go:build windows

package wfp

import (
	"errors"
	"net/netip"
	"testing"
	"unsafe"

	"golang.org/x/sys/windows"
)

func TestScopedDNSFiltersAlwaysConstrainAddressPortProtocolAndTunnel(t *testing.T) {
	calls := 0
	add := func(_ uintptr, filter *wtFwpmFilter0, _ uintptr, _ *uint64) error {
		expectedLayers := [4]windows.GUID{cFWPM_LAYER_ALE_AUTH_CONNECT_V4, cFWPM_LAYER_ALE_AUTH_RECV_ACCEPT_V4, cFWPM_LAYER_ALE_AUTH_CONNECT_V6, cFWPM_LAYER_ALE_AUTH_RECV_ACCEPT_V6}
		if filter.filterKey != scopedDNSKeys[calls] || filter.layerKey != expectedLayers[calls] || filter.subLayerKey != tunnexSublayerGUID {
			t.Fatal("wrong owned key, layer or sublayer")
		}
		calls++
		if filter.action._type != cFWP_ACTION_PERMIT || filter.weight.value != 15 || filter.providerKey == nil || *filter.providerKey != tunnexProviderGUID {
			t.Fatal("unexpected permission scope")
		}
		conditions := unsafe.Slice(filter.filterCondition, filter.numFilterConditions)
		if len(conditions) != 5 {
			t.Fatalf("missing exact conditions: %v", len(conditions))
		}
		if conditions[0].fieldKey != cFWPM_CONDITION_IP_REMOTE_PORT || conditions[0].conditionValue.value != 53 {
			t.Fatal("permit is not DNS-only")
		}
		if conditions[1].conditionValue.value != uintptr(cIPPROTO_UDP) || conditions[2].conditionValue.value != uintptr(cIPPROTO_TCP) {
			t.Fatal("wrong protocols")
		}
		if conditions[3].fieldKey != cFWPM_CONDITION_IP_LOCAL_INTERFACE || *(*uint64)(unsafe.Pointer(conditions[3].conditionValue.value)) != 17 {
			t.Fatal("permit is not tunnel-bound")
		}
		if conditions[4].fieldKey != cFWPM_CONDITION_IP_REMOTE_ADDRESS || conditions[4].matchType != cFWP_MATCH_EQUAL {
			t.Fatal("missing exact address")
		}
		return nil
	}
	if err := installScopedDNSPermits(1, 17, []netip.Addr{netip.MustParseAddr("10.99.0.1"), netip.MustParseAddr("fd00::53")}, add); err != nil || calls != 4 {
		t.Fatalf("filters=%d err=%v", calls, err)
	}
	calls = 0
	if err := installScopedDNSPermits(1, 17, nil, add); err != nil || calls != 0 {
		t.Fatal("empty addresses created broad DNS permit")
	}
	failure := errors.New("WFP refusal")
	if err := installScopedDNSPermits(1, 17, []netip.Addr{netip.MustParseAddr("10.99.0.1")}, func(uintptr, *wtFwpmFilter0, uintptr, *uint64) error { return failure }); !errors.Is(err, failure) {
		t.Fatal(err)
	}
}
