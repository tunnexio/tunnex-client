//go:build natproof && (darwin || linux)

package helper

import (
	"context"
	"crypto/rand"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync/atomic"
	"syscall"
	"testing"
	"time"

	"github.com/pion/ice/v4"
	"github.com/pion/logging"
	"github.com/pion/stun/v4"
	"golang.org/x/crypto/curve25519"
)

type proofSignal struct {
	User, Password, PublicKey string
	Candidates                []string
}

type proofCPPeer struct {
	GatewayPublicKey string
	ClientPublicKey  string
	ClientAddress    string
}

type proofLog struct {
	t                *testing.T
	unknownAuthority atomic.Bool
}

func (w *proofLog) Write(p []byte) (int, error) {
	if strings.Contains(string(p), "x509: certificate signed by unknown authority") {
		w.unknownAuthority.Store(true)
	}
	for _, category := range []string{"connection refused", "failed to allocate", "Failed to dial", "Failed to resolve", "unknown authority", "certificate is valid for", "Failed to connect", "failed to create", "location tracking", "Discard request with wrong username", "Discard request with broken integrity", "Discard success response with broken integrity", "Ignoring remote candidate", "Role conflict", "Maximum requests reached"} {
		if strings.Contains(string(p), category) {
			w.t.Log("Pion diagnostic category:", category)
		}
	}
	return len(p), nil
}

func proofWrite(t *testing.T, dir, name string, v any) {
	t.Helper()
	data, e := json.Marshal(v)
	if e != nil {
		t.Fatal("signal encoding")
	}
	p := filepath.Join(dir, name)
	if e = os.WriteFile(p+".tmp", data, 0600); e != nil {
		t.Fatal("signal write")
	}
	// Docker Desktop file sharing runs as the desktop user. Keep signals private
	// but owned by the private directory's owner, even when utun tests run as root.
	if os.Geteuid() == 0 {
		info, e := os.Stat(dir)
		if e != nil {
			t.Fatal("signal directory stat")
		}
		st, ok := info.Sys().(*syscall.Stat_t)
		if !ok {
			t.Fatal("signal owner unavailable")
		}
		if e = os.Chown(p+".tmp", int(st.Uid), int(st.Gid)); e != nil {
			t.Fatal("signal ownership")
		}
	}
	if e = os.Rename(p+".tmp", p); e != nil {
		t.Fatal("signal publish")
	}
}
func proofRead(t *testing.T, ctx context.Context, dir, name string, v any) {
	t.Helper()
	for {
		data, e := os.ReadFile(filepath.Join(dir, name))
		if e == nil {
			if json.Unmarshal(data, v) != nil {
				t.Fatal("invalid signal")
			}
			return
		}
		select {
		case <-ctx.Done():
			t.Fatal("signal timeout")
		case <-time.After(50 * time.Millisecond):
		}
	}
}

func TestNativePionProof(t *testing.T) {
	dir, role := os.Getenv("NAT_PROOF_DIR"), os.Getenv("NAT_PROOF_ROLE")
	if dir == "" {
		t.Skip("explicit private native proof fixture required")
	}
	if role != "client" && role != "server" {
		t.Fatal("invalid role")
	}
	timeout := 90 * time.Second
	cpMode := os.Getenv("NAT_PROOF_CP") == "yes"
	if cpMode {
		timeout = 300 * time.Second
	}
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()
	var credential struct{ Username, Password string }
	proofRead(t, ctx, dir, "turn.json", &credential)
	u, e := stun.ParseURI(os.Getenv("TURN_URL"))
	if e != nil || u == nil {
		t.Fatal("invalid TURN URL")
	}
	if u.Proto != stun.ProtoTypeTCP {
		t.Fatal("TCP/TLS required")
	}
	rejectCA := os.Getenv("NAT_PROOF_REJECT_CA") == "yes"
	if rejectCA && u.Scheme != stun.SchemeTypeTURNS {
		t.Fatal("trust negative requires TLS")
	}
	if u.Scheme == stun.SchemeTypeTURNS {
		pem, e := os.ReadFile(filepath.Join(dir, "cert.pem"))
		if e != nil {
			t.Fatal("fixture CA missing")
		}
		pool := x509.NewCertPool()
		if !rejectCA && !pool.AppendCertsFromPEM(pem) {
			t.Fatal("fixture CA invalid")
		}
		// Test-process only: no Keychain mutation and no InsecureSkipVerify.
		t.Setenv("GODEBUG", os.Getenv("GODEBUG")+",x509usefallbackroots=1")
		x509.SetFallbackRoots(pool)
	}
	u.Username, u.Password = credential.Username, credential.Password
	lf := logging.NewDefaultLoggerFactory()
	lf.DefaultLogLevel = logging.LogLevelTrace
	logs := &proofLog{t: t}
	lf.Writer = logs
	expect := os.Getenv("NAT_PROOF_EXPECT_PATH")
	if expect != "" && expect != "direct" && expect != "relay" {
		t.Fatal("invalid expected path")
	}
	config := &ice.AgentConfig{Urls: []*stun.URI{u}, CandidateTypes: []ice.CandidateType{ice.CandidateTypeRelay}, NetworkTypes: []ice.NetworkType{ice.NetworkTypeUDP4}, LoggerFactory: lf}
	var options []ice.AgentOption
	if expect != "" {
		config.CandidateTypes = []ice.CandidateType{ice.CandidateTypeHost, ice.CandidateTypeRelay}
		if role == "server" {
			ip := net.ParseIP(os.Getenv("NAT_PROOF_PUBLIC_IP"))
			if ip == nil || ip.To4() == nil {
				t.Fatal("IPv4 fixture address required")
			}
			config.PortMin, config.PortMax = 15000, 15000
			options = append(options, ice.WithAddressRewriteRules(ice.AddressRewriteRule{External: []string{ip.String()}, AsCandidateType: ice.CandidateTypeHost}))
		}
	}
	var a *ice.Agent
	if expect == "" {
		a, e = ice.NewAgent(config)
	} else {
		options = append(options, ice.WithUrls(config.Urls), ice.WithCandidateTypes(config.CandidateTypes), ice.WithNetworkTypes(config.NetworkTypes), ice.WithLoggerFactory(lf), ice.WithPortRange(config.PortMin, config.PortMax))
		a, e = ice.NewAgentWithOptions(options...)
	}
	if e != nil {
		t.Fatal("ICE create")
	}
	defer a.Close()
	done := make(chan struct{})
	if a.OnCandidate(func(c ice.Candidate) {
		if c == nil {
			close(done)
		}
	}) != nil {
		t.Fatal("candidate callback")
	}
	if a.GatherCandidates() != nil {
		t.Fatal("gather")
	}
	select {
	case <-done:
	case <-ctx.Done():
		t.Fatal("gather timeout")
	}
	var key [32]byte
	if _, e = rand.Read(key[:]); e != nil {
		t.Fatal(e)
	}
	var cpPeer proofCPPeer
	if cpMode {
		proofRead(t, ctx, dir, "cp-peer.json", &cpPeer)
		if role == "client" {
			var issued struct {
				PrivateKey string `json:"private_key"`
			}
			proofRead(t, ctx, dir, "device.json", &issued)
			decoded, err := base64.StdEncoding.DecodeString(issued.PrivateKey)
			if err != nil || len(decoded) != 32 {
				t.Fatal("invalid retained CP key")
			}
			copy(key[:], decoded)
		}
	}
	pub, e := curve25519.X25519(key[:], curve25519.Basepoint)
	if e != nil {
		t.Fatal(e)
	}
	s := proofSignal{PublicKey: base64.StdEncoding.EncodeToString(pub)}
	if cpMode {
		if role == "server" {
			s.PublicKey = cpPeer.GatewayPublicKey
		} else if s.PublicKey != cpPeer.ClientPublicKey {
			t.Fatal("CP device key mismatch")
		}
	}
	s.User, s.Password, e = a.GetLocalUserCredentials()
	if e != nil {
		t.Fatal("ICE credentials")
	}
	cs, e := a.GetLocalCandidates()
	if rejectCA {
		if e != nil || len(cs) != 0 || !logs.unknownAuthority.Load() {
			t.Fatal("expected exact unknown-authority rejection and no candidates")
		}
		t.Log("PASS native process rejects untrusted TURN TLS certificate; no candidates")
		return
	}
	if e != nil || len(cs) == 0 {
		t.Fatal("no candidates")
	}
	for _, c := range cs {
		s.Candidates = append(s.Candidates, c.Marshal())
	}
	proofWrite(t, dir, role+".json", s)
	other := "client"
	if role == "client" {
		other = "server"
	}
	var remote proofSignal
	proofRead(t, ctx, dir, other+".json", &remote)
	if cpMode {
		want := cpPeer.ClientPublicKey
		if role == "client" {
			want = cpPeer.GatewayPublicKey
		}
		if remote.PublicKey != want {
			t.Fatal("CP peer binding mismatch")
		}
	}
	for _, raw := range remote.Candidates {
		c, e := ice.UnmarshalCandidate(raw)
		if e != nil || (c.Type() != ice.CandidateTypeRelay && !(expect != "" && c.Type() == ice.CandidateTypeHost)) {
			t.Fatal("invalid relay candidate")
		}
		if a.AddRemoteCandidate(c) != nil {
			t.Fatal("candidate exchange")
		}
	}
	var session *ice.Conn
	if os.Getenv("NAT_PROOF_START_BARRIER") == "yes" {
		proofWrite(t, dir, role+"-prepared.json", true)
		var start bool
		proofRead(t, ctx, dir, "start.json", &start)
		if !start {
			t.Fatal("invalid start barrier")
		}
	}
	if role == "client" {
		session, e = a.Dial(ctx, remote.User, remote.Password)
	} else {
		session, e = a.Accept(ctx, remote.User, remote.Password)
	}
	if e != nil {
		types := map[string]ice.CandidateType{}
		for _, c := range append(a.GetLocalCandidatesStats(), a.GetRemoteCandidatesStats()...) {
			types[c.ID] = c.CandidateType
		}
		for _, stat := range a.GetCandidatePairsStats() {
			t.Logf("ICE pair diagnostic: %s/%s state=%s requests=%d/%d responses=%d/%d nominated=%t", types[stat.LocalCandidateID], types[stat.RemoteCandidateID], stat.State, stat.RequestsSent, stat.RequestsReceived, stat.ResponsesSent, stat.ResponsesReceived, stat.Nominated)
		}
		t.Fatal("ICE connect")
	}
	pair, e := a.GetSelectedCandidatePair()
	if e != nil || pair == nil {
		t.Fatal("missing selected path")
	}
	relay := pair.Local.Type() == ice.CandidateTypeRelay || pair.Remote.Type() == ice.CandidateTypeRelay
	if expect == "" && (pair.Local.Type() != ice.CandidateTypeRelay || pair.Remote.Type() != ice.CandidateTypeRelay) {
		t.Fatal("relay-only fixture selected a non-relay endpoint")
	}
	if expect == "direct" {
		if relay {
			t.Fatal("direct positive control selected relay")
		}
	} else if !relay {
		t.Fatal("expected relay path")
	}
	t.Logf("selected path: local=%s remote=%s", pair.Local.Type(), pair.Remote.Type())
	if os.Getenv("NAT_PROOF_ICE_ONLY") == "yes" {
		t.Log("PASS ICE-only diagnostic; NOT native traffic evidence")
		return
	}
	private := base64.StdEncoding.EncodeToString(key[:])
	if role == "server" {
		proofKernel(t, session, private, remote.PublicKey, dir, ctx)
		return
	}
	proofDesktop(t, session, private, remote.PublicKey, dir, ctx)
}

func proofHTTP(t *testing.T, dir string, ctx context.Context) {
	var count atomic.Int64
	srv := &http.Server{ReadHeaderTimeout: time.Second, Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/count" {
			fmt.Fprint(w, count.Load())
			return
		}
		count.Add(1)
		fmt.Fprint(w, "native-pion-proof")
	})}
	l, e := net.Listen("tcp4", "0.0.0.0:8080")
	if e != nil {
		t.Fatal(e)
	}
	defer srv.Close()
	go srv.Serve(l)
	proofWrite(t, dir, "ready.json", true)
	var done bool
	proofRead(t, ctx, dir, "done.json", &done)
	if !done {
		t.Fatal("client incomplete")
	}
	t.Log("PASS Linux kernel fixture completed; application arrivals", count.Load())
}

func proofRequests(t *testing.T, restrict func(), closeRelay func()) {
	t.Helper()
	hc := &http.Client{Timeout: 5 * time.Second, Transport: &http.Transport{Proxy: nil, DisableKeepAlives: true}}
	defer hc.CloseIdleConnections()
	get := func(url string) string {
		t.Helper()
		r, e := hc.Get(url)
		if e != nil {
			t.Fatal("private HTTP failed:", e)
		}
		defer r.Body.Close()
		b, e := io.ReadAll(r.Body)
		if e != nil || r.StatusCode != 200 {
			t.Fatal("HTTP response")
		}
		return string(b)
	}
	for _, ip := range []string{"10.250.0.2", "10.250.0.3"} {
		if get("http://"+ip+":8080/") != "native-pion-proof" {
			t.Fatal("body mismatch")
		}
	}
	before, e := strconv.Atoi(get("http://10.250.0.2:8080/count"))
	if e != nil {
		t.Fatal(e)
	}
	restrict()
	hc.Timeout = time.Second
	r, e := hc.Get("http://10.250.0.3:8080/")
	if e == nil {
		r.Body.Close()
		t.Fatal("denied destination reached")
	}
	hc.Timeout = 5 * time.Second
	if get("http://10.250.0.2:8080/count") != strconv.Itoa(before) {
		t.Fatal("denied request reached handler")
	}
	if get("http://10.250.0.2:8080/") != "native-pion-proof" {
		t.Fatal("allowed liveness")
	}
	closeRelay()
	hc.Timeout = time.Second
	r, e = hc.Get("http://10.250.0.2:8080/")
	if e == nil {
		r.Body.Close()
		t.Fatal("closed relay carried traffic")
	}
	if os.Getenv("NAT_PROOF_CP") == "yes" {
		t.Log("PASS real macOS backend: encrypted HTTP, reachable deny control, CP-controlled denial, allowed liveness, relay-close failure")
	} else {
		t.Log("PASS real macOS backend: encrypted HTTP, reachable deny control, cryptokey denial, allowed liveness, relay-close failure; NOT CP policy or cross-network acceptance")
	}
}
