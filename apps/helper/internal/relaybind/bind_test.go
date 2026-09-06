package relaybind

import (
	"errors"
	"golang.zx2c4.com/wireguard/conn"
	"io"
	"net"
	"net/netip"
	"sync"
	"testing"
	"time"
)

type messages struct {
	in, out chan []byte
	done    chan struct{}
	once    sync.Once
}

func (m *messages) Read(b []byte) (int, error) {
	select {
	case <-m.done:
		return 0, net.ErrClosed
	case p := <-m.in:
		if len(p) > len(b) {
			return 0, io.ErrShortBuffer
		}
		return copy(b, p), nil
	}
}
func (m *messages) Write(b []byte) (int, error) {
	select {
	case <-m.done:
		return 0, net.ErrClosed
	case m.out <- append([]byte(nil), b...):
		return len(b), nil
	}
}
func (m *messages) Close() error { m.once.Do(func() { close(m.done) }); return nil }
func msg() *messages {
	return &messages{in: make(chan []byte, 4), out: make(chan []byte, 4), done: make(chan struct{})}
}
func newBind(t *testing.T, s Session) *Bind {
	t.Helper()
	b, e := New(netip.MustParseAddrPort("192.0.2.1:51820"), func() (Session, error) { return s, nil })
	if e != nil {
		t.Fatal(e)
	}
	t.Cleanup(func() { b.Close() })
	return b
}
func receive(f conn.ReceiveFunc) (string, error) {
	p := [][]byte{make([]byte, 1500)}
	sizes := make([]int, 1)
	eps := make([]conn.Endpoint, 1)
	_, e := f(p, sizes, eps)
	return string(p[0][:sizes[0]]), e
}
func TestDatagramsAndPeerOwnership(t *testing.T) {
	s := msg()
	b := newBind(t, s)
	f, _, err := b.Open(0)
	if err != nil {
		t.Fatal(err)
	}
	ep, _ := b.ParseEndpoint("192.0.2.1:51820")
	for _, data := range []string{"first", "second"} {
		if e := b.Send([][]byte{[]byte(data)}, ep); e != nil {
			t.Fatal(e)
		}
		if string(<-s.out) != data {
			t.Fatal("datagram changed")
		}
		s.in <- []byte(data)
		got, e := receive(f[0])
		if e != nil || got != data {
			t.Fatal("receive changed")
		}
	}
	other := newBind(t, msg())
	foreign, _ := other.ParseEndpoint("192.0.2.1:51820")
	if !errors.Is(b.Send([][]byte{{1}}, foreign), conn.ErrWrongEndpointType) {
		t.Fatal("foreign owner accepted")
	}
	if _, e := b.ParseEndpoint("192.0.2.2:51820"); e == nil {
		t.Fatal("peer redirect accepted")
	}
	if _, _, e := b.Open(0); !errors.Is(e, conn.ErrBindAlreadyOpen) {
		t.Fatal("duplicate open")
	}
}
func TestCloseUnblocksAndOldReceiveCannotUseNewSession(t *testing.T) {
	sessions := []*messages{msg(), msg()}
	next := 0
	b, _ := New(netip.MustParseAddrPort("192.0.2.1:51820"), func() (Session, error) { s := sessions[next]; next++; return s, nil })
	defer b.Close()
	old, _, _ := b.Open(0)
	done := make(chan error, 1)
	go func() { _, e := receive(old[0]); done <- e }()
	b.Close()
	select {
	case e := <-done:
		if !errors.Is(e, net.ErrClosed) {
			t.Fatal(e)
		}
	case <-time.After(time.Second):
		t.Fatal("read stranded")
	}
	fresh, _, e := b.Open(0)
	if e != nil {
		t.Fatal(e)
	}
	sessions[1].in <- []byte("new")
	if _, e := receive(old[0]); !errors.Is(e, net.ErrClosed) {
		t.Fatal("old generation reactivated")
	}
	if got, e := receive(fresh[0]); e != nil || got != "new" {
		t.Fatal("new generation failed")
	}
}
func TestFailureAndUnsupportedOptions(t *testing.T) {
	b, _ := New(netip.MustParseAddrPort("192.0.2.1:1"), func() (Session, error) { return nil, errors.New("secret fixture detail") })
	if _, _, e := b.Open(0); e == nil || e.Error() != "relay session unavailable" {
		t.Fatal("failure exposed or fallback")
	}
	if _, _, e := b.Open(12); e == nil {
		t.Fatal("UDP port accepted")
	}
	if b.SetMark(1) == nil {
		t.Fatal("mark accepted")
	}
	for _, a := range []string{"127.0.0.1:1", "0.0.0.0:1", "192.0.2.1:0"} {
		if _, e := New(netip.MustParseAddrPort(a), func() (Session, error) { return msg(), nil }); e == nil {
			t.Fatal("unsafe peer")
		}
	}
}

func TestCloseUnblocksPendingSend(t *testing.T) {
	s := msg()
	s.out = make(chan []byte) // no reader: Write must be interruptible by Close
	b := newBind(t, s)
	if _, _, e := b.Open(0); e != nil {
		t.Fatal(e)
	}
	ep, _ := b.ParseEndpoint("192.0.2.1:51820")
	done := make(chan error, 1)
	go func() { done <- b.Send([][]byte{[]byte("blocked")}, ep) }()
	b.Close()
	select {
	case e := <-done:
		if !errors.Is(e, net.ErrClosed) {
			t.Fatal(e)
		}
	case <-time.After(time.Second):
		t.Fatal("send stranded after close")
	}
}
