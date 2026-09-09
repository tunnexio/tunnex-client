//go:build natproductprobe

package helper

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/cookiejar"
	"os"
	"testing"
	"time"

	"github.com/tunnexio/tunnex/apps/helper/internal/icewire"
)

// Explicit live diagnostic: real CP/device authorization and gateway mTLS/ICE.
// Does not create a TUN or claim native WireGuard application traffic.
func TestProductCPRelayNegotiation(t *testing.T) {
	base := os.Getenv("NAT_PRODUCT_CP")
	if base != "https://cp.13.126.184.110.sslip.io" {
		t.Skip("explicit AWS fixture required")
	}
	data, err := os.ReadFile(os.Getenv("NAT_PRODUCT_CREDENTIAL_FILE"))
	if err != nil {
		t.Fatal("credential file unavailable")
	}
	var credential struct {
		Email    string `json:"email"`
		Password string `json:"password"`
	}
	if json.Unmarshal(data, &credential) != nil {
		t.Fatal("credential file invalid")
	}
	jar, _ := cookiejar.New(nil)
	hc := &http.Client{Jar: jar, Timeout: 12 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	defer hc.CloseIdleConnections()
	request := func(method, path string, body any, result any) {
		t.Helper()
		encoded, _ := json.Marshal(body)
		req, _ := http.NewRequest(method, base+path, bytes.NewReader(encoded))
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("X-Tunnex-CSRF", "1")
		res, e := hc.Do(req)
		if e != nil {
			t.Fatal("CP request failed")
		}
		defer res.Body.Close()
		if res.StatusCode < 200 || res.StatusCode >= 300 {
			t.Fatalf("CP response %d", res.StatusCode)
		}
		if result != nil && json.NewDecoder(io.LimitReader(res.Body, 131072)).Decode(result) != nil {
			t.Fatal("CP response invalid")
		}
	}
	request("POST", "/api/v1/auth/login", credential, nil)
	path := "/api/v1/organizations/01a07601-54e2-716f-aa1d-de547106223f/devices/01a0772d-a350-7fe8-a9fc-bec9247b2203/connectivity-sessions"
	type mailbox struct {
		ID             string `json:"session_id"`
		Generation     int64  `json:"generation"`
		DeviceKey      string `json:"device_public_key"`
		GatewayKey     string `json:"gateway_public_key"`
		GatewayPayload string `json:"gateway_payload"`
		Relay          struct {
			URL      string `json:"url"`
			Username string `json:"username"`
			Password string `json:"password"`
		} `json:"relay"`
	}
	var s mailbox
	request("POST", path, nil, &s)
	path += fmt.Sprintf("/%s?generation=%d", s.ID, s.Generation)
	defer request("DELETE", path, nil, nil)
	ctx, cancel := context.WithTimeout(context.Background(), 45*time.Second)
	defer cancel()
	ep, offer, err := icewire.Gather(ctx, icewire.Relay{URL: s.Relay.URL, Username: s.Relay.Username, Password: s.Relay.Password}, s.DeviceKey)
	if err != nil {
		t.Fatal("production credential ICE gather failed")
	}
	defer ep.Close()
	payload, _ := json.Marshal(offer)
	request("PUT", path, map[string]any{"sequence": 1, "payload": string(payload)}, &s)
	for s.GatewayPayload == "{}" || s.GatewayPayload == "" {
		select {
		case <-ctx.Done():
			t.Fatal("gateway did not publish")
		case <-time.After(time.Second):
		}
		request("GET", path, nil, &s)
	}
	remote, err := icewire.Decode(s.GatewayPayload, s.GatewayKey)
	if err != nil {
		t.Fatal("gateway offer invalid")
	}
	carrier, err := ep.Connect(ctx, remote, true)
	if err != nil {
		t.Fatal("product ICE connection failed")
	}
	defer carrier.Close()
	if ep.Path() != "relay" {
		t.Fatal("expected relay with direct UDP inaccessible")
	}
	t.Log("PASS real CP-issued credentials, gateway mTLS signaling and TLS relay nomination; NOT native application traffic")
}
