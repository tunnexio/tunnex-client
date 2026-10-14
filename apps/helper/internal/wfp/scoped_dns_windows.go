//go:build windows

package wfp

import (
	"encoding/binary"
	"fmt"
	"net/netip"
	"runtime"
	"syscall"
	"unsafe"

	"golang.org/x/sys/windows"
)

// Only these four exact permit filters are replaced. The existing DNS deny,
// config-DNS permits and kill-switch remain installed for the whole transaction.
var scopedDNSKeys = [4]windows.GUID{
	{Data1: 0x93e83ace, Data2: 0x83ac, Data3: 0x4dd5, Data4: [8]byte{0xae, 0x59, 0xb1, 0x85, 0x22, 0x6a, 0x36, 0x01}},
	{Data1: 0x93e83ace, Data2: 0x83ac, Data3: 0x4dd5, Data4: [8]byte{0xae, 0x59, 0xb1, 0x85, 0x22, 0x6a, 0x36, 0x02}},
	{Data1: 0x93e83ace, Data2: 0x83ac, Data3: 0x4dd5, Data4: [8]byte{0xae, 0x59, 0xb1, 0x85, 0x22, 0x6a, 0x36, 0x03}},
	{Data1: 0x93e83ace, Data2: 0x83ac, Data3: 0x4dd5, Data4: [8]byte{0xae, 0x59, 0xb1, 0x85, 0x22, 0x6a, 0x36, 0x04}},
}

var procFwpmFilterDeleteByKey0 = modfwpuclnt.NewProc("FwpmFilterDeleteByKey0")

func deleteScopedDNSFilter(engine uintptr, key *windows.GUID) error {
	status, _, _ := syscall.SyscallN(procFwpmFilterDeleteByKey0.Addr(), engine, uintptr(unsafe.Pointer(key)))
	if status != 0 { // WFP returns its status directly, not through GetLastError.
		return syscall.Errno(status)
	}
	return nil
}

// ReplaceScopedDNSResolvers grants only UDP/TCP53 to exact resolver addresses on
// the live tunnel interface. Empty removes all scoped permits. It never re-arms
// the firewall: an error aborts this transaction with the old block still intact.
func ReplaceScopedDNSResolvers(luid uint64, addresses []netip.Addr) error {
	if len(addresses) > 0 && luid == 0 {
		return fmt.Errorf("scoped DNS requires an active tunnel interface")
	}
	for _, address := range addresses {
		if !address.IsValid() || address.Zone() != "" || !address.IsGlobalUnicast() || address.IsLoopback() {
			return fmt.Errorf("invalid scoped DNS address")
		}
	}
	var engine uintptr
	session := wtFwpmSession0{txnWaitTimeoutInMSec: 5000}
	if err := fwpmEngineOpen0(nil, cRPC_C_AUTHN_WINNT, nil, &session, unsafe.Pointer(&engine)); err != nil {
		return wrapErr(err)
	}
	defer fwpmEngineClose0(engine)
	return runTransaction(engine, func(engine uintptr) error {
		for i := range scopedDNSKeys {
			if err := deleteScopedDNSFilter(engine, &scopedDNSKeys[i]); err != nil && !isWfpNotFound(err) {
				return err
			}
		}
		return installScopedDNSPermits(engine, luid, addresses, fwpmFilterAdd0)
	})
}

func installScopedDNSPermits(engine uintptr, luid uint64, addresses []netip.Addr,
	add func(uintptr, *wtFwpmFilter0, uintptr, *uint64) error) error {
	layers := [4]windows.GUID{cFWPM_LAYER_ALE_AUTH_CONNECT_V4, cFWPM_LAYER_ALE_AUTH_RECV_ACCEPT_V4,
		cFWPM_LAYER_ALE_AUTH_CONNECT_V6, cFWPM_LAYER_ALE_AUTH_RECV_ACCEPT_V6}
	for family := 0; family < 2; family++ {
		conditions := []wtFwpmFilterCondition0{
			{fieldKey: cFWPM_CONDITION_IP_REMOTE_PORT, matchType: cFWP_MATCH_EQUAL, conditionValue: wtFwpConditionValue0{_type: cFWP_UINT16, value: 53}},
			{fieldKey: cFWPM_CONDITION_IP_PROTOCOL, matchType: cFWP_MATCH_EQUAL, conditionValue: wtFwpConditionValue0{_type: cFWP_UINT8, value: uintptr(cIPPROTO_UDP)}},
			{fieldKey: cFWPM_CONDITION_IP_PROTOCOL, matchType: cFWP_MATCH_EQUAL, conditionValue: wtFwpConditionValue0{_type: cFWP_UINT8, value: uintptr(cIPPROTO_TCP)}},
			{fieldKey: cFWPM_CONDITION_IP_LOCAL_INTERFACE, matchType: cFWP_MATCH_EQUAL, conditionValue: wtFwpConditionValue0{_type: cFWP_UINT64, value: uintptr(unsafe.Pointer(&luid))}},
		}
		var storedPointers []*wtFwpByteArray16
		for _, address := range addresses {
			if address.Is4() != (family == 0) {
				continue
			}
			condition := wtFwpmFilterCondition0{fieldKey: cFWPM_CONDITION_IP_REMOTE_ADDRESS, matchType: cFWP_MATCH_EQUAL}
			if address.Is4() {
				condition.conditionValue = wtFwpConditionValue0{_type: cFWP_UINT32, value: uintptr(binary.BigEndian.Uint32(address.AsSlice()))}
			} else {
				value := &wtFwpByteArray16{byteArray16: address.As16()}
				storedPointers = append(storedPointers, value)
				condition.conditionValue = wtFwpConditionValue0{_type: cFWP_BYTE_ARRAY16_TYPE, value: uintptr(unsafe.Pointer(value))}
			}
			conditions = append(conditions, condition)
		}
		if len(conditions) == 4 {
			continue
		} // never create an any-address DNS permit
		display, err := createWtFwpmDisplayData0("Tunnex scoped DNS on tunnel", "Current authorized private DNS resolvers")
		if err != nil {
			return err
		}
		for direction := 0; direction < 2; direction++ {
			index := family*2 + direction
			filter := wtFwpmFilter0{filterKey: scopedDNSKeys[index], displayData: *display,
				providerKey: &tunnexProviderGUID, subLayerKey: tunnexSublayerGUID, layerKey: layers[index],
				weight: filterWeight(15), numFilterConditions: uint32(len(conditions)), filterCondition: &conditions[0],
				action: wtFwpmAction0{_type: cFWP_ACTION_PERMIT}}
			var id uint64
			if err := add(engine, &filter, 0, &id); err != nil {
				return err
			}
		}
		runtime.KeepAlive(storedPointers)
		runtime.KeepAlive(conditions)
	}
	runtime.KeepAlive(luid)
	return nil
}
