// Package relaybind adapts an already negotiated datagram session to WireGuard.
// Experimental: no signaling, raw TCP framing, automatic fallback or public IPC.
package relaybind

import (
	"encoding/binary"
	"errors"
	"io"
	"net"
	"net/netip"
	"sync"

	"golang.zx2c4.com/wireguard/conn"
)

// Session must preserve datagram boundaries (e.g. Pion ICE Conn, NOT net.TCPConn).
// Close must unblock Read and Write. Read must error rather than truncate.
type Session interface {
	io.Reader
	io.Writer
	io.Closer
}

// Factory transfers a fresh, already-negotiated session on each Open. It must
// return promptly, without network negotiation. A failed reconnect must return
// an error, never the closed session or a direct transport fallback.
type Factory func() (Session, error)

type Bind struct {
	mu      sync.Mutex
	peer    endpoint
	factory Factory
	active  *generation
}
type generation struct {
	session Session
	done    chan struct{}
}
type endpoint struct {
	owner *Bind
	addr  netip.AddrPort
}

var _ conn.Bind = (*Bind)(nil)

func New(peer netip.AddrPort, factory Factory) (*Bind, error) {
	if !peer.IsValid() || peer.Port() == 0 || peer.Addr().IsLoopback() || peer.Addr().IsUnspecified() || peer.Addr().IsMulticast() || peer.Addr().IsLinkLocalUnicast() || peer.Addr().Zone() != "" || factory == nil {
		return nil, errors.New("invalid relay peer or factory")
	}
	b := &Bind{factory: factory}
	b.peer = endpoint{owner: b, addr: peer}
	return b, nil
}

func (b *Bind) Open(port uint16) ([]conn.ReceiveFunc, uint16, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.active != nil {
		return nil, 0, conn.ErrBindAlreadyOpen
	}
	if port != 0 {
		return nil, 0, errors.New("relay bind does not expose a UDP listen port")
	}
	s, err := b.factory()
	if err != nil {
		return nil, 0, errors.New("relay session unavailable")
	}
	if s == nil {
		return nil, 0, errors.New("nil relay session")
	}
	g := &generation{session: s, done: make(chan struct{})}
	b.active = g
	recv := func(packets [][]byte, sizes []int, eps []conn.Endpoint) (int, error) {
		if len(packets) < 1 || len(sizes) < 1 || len(eps) < 1 {
			return 0, errors.New("missing receive buffer")
		}
		select {
		case <-g.done:
			return 0, net.ErrClosed
		default:
		}
		n, err := g.session.Read(packets[0])
		select {
		case <-g.done:
			return 0, net.ErrClosed
		default:
		}
		if err != nil {
			return 0, err
		}
		sizes[0] = n
		eps[0] = &b.peer
		return 1, nil
	}
	return []conn.ReceiveFunc{recv}, 0, nil
}

func (b *Bind) Close() error {
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.active == nil {
		return nil
	}
	g := b.active
	b.active = nil
	close(g.done)
	return g.session.Close()
}
func (b *Bind) BatchSize() int { return 1 }
func (b *Bind) SetMark(mark uint32) error {
	if mark != 0 {
		return errors.New("relay socket marks unsupported")
	}
	return nil
}
func (b *Bind) ParseEndpoint(s string) (conn.Endpoint, error) {
	a, err := netip.ParseAddrPort(s)
	if err != nil || a != b.peer.addr {
		return nil, conn.ErrWrongEndpointType
	}
	return &b.peer, nil
}
func (b *Bind) Send(bufs [][]byte, ep conn.Endpoint) error {
	e, ok := ep.(*endpoint)
	if !ok || e.owner != b || e.addr != b.peer.addr {
		return conn.ErrWrongEndpointType
	}
	if len(bufs) != 1 {
		return errors.New("relay bind requires one datagram")
	}
	b.mu.Lock()
	g := b.active
	b.mu.Unlock()
	if g == nil {
		return net.ErrClosed
	}
	select {
	case <-g.done:
		return net.ErrClosed
	default:
	}
	n, err := g.session.Write(bufs[0])
	if err != nil {
		return err
	}
	if n != len(bufs[0]) {
		return io.ErrShortWrite
	}
	return nil
}
func (e *endpoint) ClearSrc()           {}
func (e *endpoint) SrcToString() string { return "" }
func (e *endpoint) DstToString() string { return e.addr.String() }
func (e *endpoint) DstIP() netip.Addr   { return e.addr.Addr() }
func (e *endpoint) SrcIP() netip.Addr   { return netip.Addr{} }
func (e *endpoint) DstToBytes() []byte {
	b := append([]byte(nil), e.addr.Addr().AsSlice()...)
	return binary.BigEndian.AppendUint16(b, e.addr.Port())
}
