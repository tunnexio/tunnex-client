package helper

import (
	"context"
	"crypto/ecdh"
	"encoding/base64"
	"encoding/json"
	"net/netip"
	"net/url"
	"runtime"
	"strings"
	"sync"
	"time"

	"github.com/tunnexio/tunnex/apps/helper/internal/icewire"
	"github.com/tunnexio/tunnex/apps/helper/internal/relaybind"
	"golang.zx2c4.com/wireguard/conn"
)

// Only short-lived scoped TURN credentials cross IPC, not the CP bearer token.
type RelayPreparation struct {
	ID               string    `json:"id"`
	DevicePublicKey  string    `json:"device_public_key"`
	GatewayPublicKey string    `json:"gateway_public_key"`
	URL              string    `json:"url"`
	Username         string    `json:"username"`
	Password         string    `json:"password"`
	ExpiresAt        time.Time `json:"expires_at"`
}
type relayNegotiation struct {
	mu       sync.Mutex
	prep     RelayPreparation
	endpoint *icewire.Endpoint
	ctx      context.Context
	cancel   context.CancelFunc
	lease    *time.Timer
	used     bool
	closed   bool
	remote   string
}

func relayError() error {
	return &ProtocolError{Code: "relay_unavailable", Msg: "relay negotiation unavailable"}
}

func relayPlatformSupported(platform string) bool {
	return platform == "darwin" || platform == "windows"
}

// A negotiated carrier has no UDP listen socket. Reapplying listen_port would
// close the single-use bind if the adapter became up before IpcSet.
func relayUAPIConfig(cfg *TunnelConfig) (string, error) {
	uapi, err := uapiConfig(cfg)
	if err == nil && cfg.relay != nil {
		uapi = strings.Replace(uapi, "listen_port=0\n", "", 1)
	}
	return uapi, err
}

func prepareRelay(p *RelayPreparation) (*relayNegotiation, string, error) {
	if !relayPlatformSupported(runtime.GOOS) || p == nil || len(p.ID) < 1 || len(p.ID) > 128 || validKey(p.DevicePublicKey) != nil || validKey(p.GatewayPublicKey) != nil || len(p.Username) < 1 || len(p.Username) > 512 || len(p.Password) < 1 || len(p.Password) > 512 {
		return nil, "", relayError()
	}
	if !p.ExpiresAt.After(time.Now()) {
		return nil, "", &ProtocolError{Code: "relay_session_expired", Msg: "relay session expired"}
	}
	if p.ExpiresAt.After(time.Now().Add(10 * time.Minute)) {
		return nil, "", &ProtocolError{Code: "relay_clock_skew", Msg: "relay deadline exceeds local clock bound"}
	}
	// Parse using the TURN URI shape, applying the same safe endpoint rules as
	// ordinary WireGuard config. The transport library validates TLS normally.
	if !strings.HasPrefix(p.URL, "turns:") || len(p.URL) > 512 {
		return nil, "", relayError()
	}
	parts := strings.Split(strings.TrimPrefix(p.URL, "turns:"), "?")
	if len(parts) != 2 || parts[1] != "transport=tcp" || !validEndpoint(parts[0]) {
		return nil, "", relayError()
	}
	if u, err := url.Parse("https://" + parts[0]); err != nil || u.User != nil || u.Path != "" {
		return nil, "", relayError()
	}
	ctx, cancel := context.WithDeadline(context.Background(), p.ExpiresAt)
	neg, stop := icewire.Deadline(ctx)
	defer stop()
	ep, offer, err := icewire.Gather(neg, icewire.Relay{URL: p.URL, Username: p.Username, Password: p.Password}, p.DevicePublicKey)
	if err != nil {
		cancel()
		return nil, "", &ProtocolError{Code: "relay_gather_failed", Msg: "relay candidate gathering failed"}
	}
	r := &relayNegotiation{prep: *p, endpoint: ep, ctx: ctx, cancel: cancel}
	r.lease = time.AfterFunc(30*time.Second, r.close)
	go func() { <-ctx.Done(); r.close() }()
	raw, _ := json.Marshal(offer)
	return r, string(raw), nil
}
func (r *relayNegotiation) close() {
	if r == nil {
		return
	}
	r.mu.Lock()
	if r.closed {
		r.mu.Unlock()
		return
	}
	r.closed = true
	if r.lease != nil {
		r.lease.Stop()
	}
	r.cancel()
	r.mu.Unlock()
	r.endpoint.Close()
}
func (r *relayNegotiation) authorize(id string) error {
	if r == nil {
		return relayError()
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.closed || r.ctx.Err() != nil || id != r.prep.ID {
		return relayError()
	}
	r.lease.Reset(30 * time.Second)
	return nil
}

func (r *relayNegotiation) path() string {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.closed || r.ctx.Err() != nil || r.endpoint == nil {
		return "unknown"
	}
	return r.endpoint.Path()
}
func (r *relayNegotiation) bind(cfg *TunnelConfig) (conn.Bind, error) {
	r.mu.Lock()
	if r.closed || r.used || cfg.FullTunnel || cfg.PeerPublicKey != r.prep.GatewayPublicKey {
		r.mu.Unlock()
		return nil, relayError()
	}
	r.used = true
	r.mu.Unlock()
	priv, err := base64.StdEncoding.DecodeString(cfg.PrivateKey)
	if err != nil {
		return nil, relayError()
	}
	k, err := ecdh.X25519().NewPrivateKey(priv)
	if err != nil || base64.StdEncoding.EncodeToString(k.PublicKey().Bytes()) != r.prep.DevicePublicKey {
		return nil, relayError()
	}
	remote, err := icewire.Decode(r.remote, r.prep.GatewayPublicKey)
	if err != nil {
		return nil, relayError()
	}
	ctx, cancel := icewire.Deadline(r.ctx)
	defer cancel()
	carrier, err := r.endpoint.Connect(ctx, remote, true)
	if err != nil {
		return nil, relayError()
	}
	peer, err := netip.ParseAddrPort(cfg.Endpoint)
	if err != nil {
		carrier.Close()
		return nil, relayError()
	}
	var once sync.Once
	return relaybind.New(peer, func() (relaybind.Session, error) {
		var session relaybind.Session
		once.Do(func() { session = carrier })
		if session == nil {
			return nil, relayError()
		}
		return session, nil
	})
}

// The negotiation object lives on one authenticated IPC connection. A second
// connection cannot consume it, renew it, or steal its TURN allocation.
func (s *Server) dispatchRelay(req *Request, pending **relayNegotiation) *Response {
	if err := ValidateRequest(req); err != nil {
		return errorResponse(codeOf(err), err.Error())
	}
	if _, err := Negotiate(req.AuthMode, s.verify.Mode()); err != nil {
		return errorResponse(codeOf(err), err.Error())
	}
	switch req.Verb {
	case VerbRelayPrepare:
		if s.sup.State() != StateDown {
			return errorResponse("relay_busy", "disconnect before relay preparation")
		}
		(*pending).close()
		prepared, offer, err := prepareRelay(req.RelayPrepare)
		if err != nil {
			return errorResponse(codeOf(err), err.Error())
		}
		*pending = prepared
		return &Response{Version: ProtocolVersion, OK: true, RelayOffer: offer}
	case VerbRelayAuthorize:
		if err := (*pending).authorize(req.RelayID); err != nil {
			return errorResponse(codeOf(err), err.Error())
		}
		return okResponse(nil)
	case VerbTunnelUp:
		if req.RelayRemote != "" {
			if *pending == nil || len(req.RelayRemote) > 16384 || req.Config.FullTunnel {
				return errorResponse("relay_unavailable", "relay preparation required")
			}
			(*pending).remote = req.RelayRemote
			req.Config.relay = *pending
		}
	case VerbTunnelDown:
		(*pending).close()
		*pending = nil
	}
	return s.dispatch(req)
}
