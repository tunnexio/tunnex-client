package helper

import (
	"context"
	"encoding/base64"
	"runtime"
	"strings"
	"testing"
	"time"
)

func TestRelayPlatformBoundary(t *testing.T) {
	for _, platform := range []string{"darwin", "windows", "linux", "freebsd", ""} {
		want := platform == "darwin" || platform == "windows"
		if relayPlatformSupported(platform) != want {
			t.Fatalf("unexpected relay support for %q", platform)
		}
	}
}

func TestRelayUAPIHasNoListenPortAndPreservesDirectConfig(t *testing.T) {
	cfg := goodConfig()
	direct, err := uapiConfig(cfg)
	if err != nil {
		t.Fatal(err)
	}
	got, err := relayUAPIConfig(cfg)
	if err != nil || got != direct || !strings.Contains(got, "listen_port=0\n") {
		t.Fatal("ordinary direct configuration changed")
	}
	cfg.relay = &relayNegotiation{}
	got, err = relayUAPIConfig(cfg)
	if err != nil || got != strings.Replace(direct, "listen_port=0\n", "", 1) {
		t.Fatal("relay configuration must remove only the UDP listen update")
	}
}

func TestRelayEnvelopeRefusesCrossVerbFields(t *testing.T) {
	for _, request := range []*Request{
		{Version: 1, AuthMode: AuthModePathCheck, Verb: VerbStatus, RelayPrepare: &RelayPreparation{}},
		{Version: 1, AuthMode: AuthModePathCheck, Verb: VerbStatus, RelayRemote: "{}"},
		{Version: 1, AuthMode: AuthModePathCheck, Verb: VerbStatus, RelayID: "session"},
		{Version: 1, AuthMode: AuthModePathCheck, Verb: VerbRelayPrepare},
		{Version: 1, AuthMode: AuthModePathCheck, Verb: VerbRelayAuthorize},
	} {
		if ValidateRequest(request) == nil {
			t.Fatal("accepted misplaced relay fields")
		}
	}
}

func TestRelayCannotUseAnotherConnectionsPreparation(t *testing.T) {
	s, _ := newServer(t, &fakeBackend{}, trustedResolver)
	var absent *relayNegotiation
	request := req(VerbTunnelUp, goodConfig())
	request.RelayRemote = "{}"
	if result := s.dispatchRelay(request, &absent); result.OK {
		t.Fatal("accepted missing connection preparation")
	}
	if err := absent.authorize("someone-elses-session"); err == nil {
		t.Fatal("authorized missing connection session")
	}
}

func TestRelayAuthorizationCannotReviveClosedSession(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	r := &relayNegotiation{ctx: ctx, cancel: cancel, prep: RelayPreparation{ID: "one"}}
	r.lease = time.AfterFunc(time.Hour, func() {})
	defer r.close()
	if err := r.authorize("other"); err == nil {
		t.Fatal("renewed wrong session")
	}
	if err := r.authorize("one"); err != nil {
		t.Fatal(err)
	}
	r.close()
	if err := r.authorize("one"); err == nil {
		t.Fatal("revived closed session")
	}
}

func TestRelayPreparationRejectsInvalidMaterialBeforeGather(t *testing.T) {
	if _, _, err := prepareRelay(&RelayPreparation{ID: "test"}); err == nil {
		t.Fatal("accepted missing keys and credentials")
	}
}

func TestRelayPreparationReportsTimingRefusals(t *testing.T) {
	if !relayPlatformSupported(runtime.GOOS) {
		t.Skip("native relay platform required")
	}
	key := base64.StdEncoding.EncodeToString(make([]byte, 32))
	for _, tc := range []struct {
		delta time.Duration
		code  string
	}{{-time.Second, "relay_session_expired"}, {609 * time.Second, "relay_clock_skew"}} {
		_, _, err := prepareRelay(&RelayPreparation{ID: "test", DevicePublicKey: key, GatewayPublicKey: key, Username: "test", Password: "test", ExpiresAt: time.Now().Add(tc.delta)})
		if err == nil || codeOf(err) != tc.code {
			t.Fatalf("expected %s, got %v", tc.code, err)
		}
	}
}
