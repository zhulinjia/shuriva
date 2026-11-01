package mutationmysql

import (
	"context"
	"errors"
	"io"
	"net"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"example.com/ai-database-workspace/connector/internal/mutationguard"
	"example.com/ai-database-workspace/connector/internal/mutationrunner"
	"example.com/ai-database-workspace/connector/internal/testmysql"
)

// A loopback TCP relay for this fixed isolated server, never a product proxy.
// It forwards complete MySQL packets without retaining/logging their contents.
// Only an armed COM_QUERY COMMIT is interrupted. TLS is disabled by the local
// guarded fixture, so this is not a claim about parsing encrypted traffic.
type commitFaultRelay struct {
	listener    net.Listener
	mu          sync.Mutex
	connections map[net.Conn]bool
	workers     sync.WaitGroup
	armed       atomic.Bool
	seen        atomic.Bool
	commits     atomic.Int32
	dropBefore  bool
	dropped     chan struct{}
}

func newCommitFaultRelay(t *testing.T, dropBefore bool) *commitFaultRelay {
	t.Helper()
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	r := &commitFaultRelay{listener: listener, connections: map[net.Conn]bool{}, dropBefore: dropBefore, dropped: make(chan struct{})}
	r.workers.Add(1)
	go func() {
		defer r.workers.Done()
		for {
			client, err := listener.Accept()
			if err != nil {
				return
			}
			r.track(client, true)
			r.workers.Add(1)
			go r.serve(client)
		}
	}()
	t.Cleanup(func() {
		listener.Close()
		r.mu.Lock()
		for connection := range r.connections {
			connection.Close()
		}
		r.mu.Unlock()
		r.workers.Wait()
	})
	return r
}

func (r *commitFaultRelay) track(c net.Conn, add bool) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if add {
		r.connections[c] = true
	} else {
		delete(r.connections, c)
	}
}
func (r *commitFaultRelay) dial(ctx context.Context, network, address string) (net.Conn, error) {
	if network != "tcp" || address != "127.0.0.1:13308" {
		return nil, errors.New("relay target refused")
	}
	return (&net.Dialer{Timeout: time.Second}).DialContext(ctx, "tcp", r.listener.Addr().String())
}
func readMySQLPacket(c net.Conn) ([]byte, error) {
	var header [4]byte
	if _, err := io.ReadFull(c, header[:]); err != nil {
		return nil, err
	}
	size := int(header[0]) | int(header[1])<<8 | int(header[2])<<16
	if size > 2<<20 {
		return nil, errors.New("test packet exceeds fixed budget")
	}
	packet := make([]byte, 4+size)
	copy(packet, header[:])
	_, err := io.ReadFull(c, packet[4:])
	return packet, err
}
func writePacket(c net.Conn, packet []byte) error {
	for len(packet) > 0 {
		n, err := c.Write(packet)
		if err != nil {
			return err
		}
		if n == 0 {
			return io.ErrShortWrite
		}
		packet = packet[n:]
	}
	return nil
}
func (r *commitFaultRelay) serve(client net.Conn) {
	defer r.workers.Done()
	defer r.track(client, false)
	defer client.Close()
	server, err := net.DialTimeout("tcp", "127.0.0.1:13308", time.Second)
	if err != nil {
		return
	}
	r.track(server, true)
	defer r.track(server, false)
	defer server.Close()
	_ = client.SetDeadline(time.Now().Add(30 * time.Second))
	_ = server.SetDeadline(time.Now().Add(30 * time.Second))
	var committing atomic.Bool
	done := make(chan struct{})
	go func() {
		defer close(done)
		defer server.Close()
		defer client.Close()
		for {
			packet, err := readMySQLPacket(client)
			if err != nil {
				return
			}
			commit := r.armed.Load() && len(packet) > 5 && packet[4] == 3 && strings.EqualFold(strings.TrimSpace(string(packet[5:])), "COMMIT")
			if commit {
				r.commits.Add(1)
				if !r.seen.CompareAndSwap(false, true) {
					return
				}
				if r.dropBefore {
					close(r.dropped)
					return
				}
				committing.Store(true)
			}
			if writePacket(server, packet) != nil {
				return
			}
		}
	}()
	for {
		packet, err := readMySQLPacket(server)
		if err != nil {
			break
		}
		if committing.Load() {
			// The server's actual COMMIT OK is received on a separate socket;
			// the client socket is closed without forwarding a single reply byte.
			if len(packet) > 4 && packet[4] == 0 {
				close(r.dropped)
			}
			break
		}
		if writePacket(client, packet) != nil {
			break
		}
	}
	client.Close()
	server.Close()
	<-done
}

func TestG4TCPCommitLossPreservesUnknownAndOriginalReceipt(t *testing.T) {
	for _, before := range []bool{false, true} {
		name := "commit-OK-dropped"
		if before {
			name = "commit-not-forwarded"
		}
		t.Run(name, func(t *testing.T) {
			l := newLab(t)
			relay := newCommitFaultRelay(t, before)
			writer, err := testmysql.OpenAccountWithDial(l.fixture.Manifest, l.profile.Writer.Username, l.profile.Writer.Password, relay.dial)
			if err != nil {
				t.Fatal(err)
			}
			defer writer.Close()
			recovery := l.fixture.Open(t, l.profile.Recovery.Username, l.profile.Recovery.Password)
			controller, err := NewWithDatabases(l.profile.Target(), l.manifest, writer, recovery)
			if err != nil {
				t.Fatal(err)
			}
			runner := newCoreRunner(t, l, controller)
			e := corePreviewExecution(t, runner, mutationguard.Plan{Operation: "update", Table: "orders", Changes: []mutationguard.Assignment{{Column: "label", Value: mutationguard.Value{Kind: "string", Value: "G4-network-once"}}}, Where: integerWhere("1")})
			relay.armed.Store(true)
			result, err := runner.Execute(context.Background(), e)
			if !errors.Is(err, mutationrunner.ErrUnknown) || result.State != "outcome_unknown" {
				t.Fatalf("lost response was not unknown: %s %v", result.State, err)
			}
			select {
			case <-relay.dropped:
			case <-time.After(time.Second):
				t.Fatal("fault was never reached on the actual socket")
			}
			repeated, _ := runner.Execute(context.Background(), e)
			if repeated.ExecutionID != e.ExecutionID || repeated.State != "outcome_unknown" || relay.commits.Load() != 1 {
				t.Fatal("unknown transport delivery retried the mutation")
			}
			var label string
			if err := l.fixture.Admin.QueryRow("SELECT label FROM " + qualified(l.manifest.Spec.Catalog, "orders") + " WHERE id=1").Scan(&label); err != nil {
				t.Fatal(err)
			}
			want := "G4-network-once"
			if before {
				want = "first"
			}
			if label != want {
				t.Fatal("business outcome disagrees with network fault boundary")
			}
			status, err := runner.Status(context.Background(), e.Scope, e.ExecutionID)
			if err != nil {
				t.Fatal(err)
			}
			if before && status.State != "outcome_unknown" {
				t.Fatal("absence of receipt falsely proved rollback")
			}
			if !before && status.State != "committed" {
				t.Fatal("original committed receipt not recovered")
			}
			if _, err := runner.Preview(context.Background(), mutationguard.Plan{Operation: "delete", Table: "orders", Where: integerWhere("1")}); !errors.Is(err, mutationrunner.ErrFrozen) {
				t.Fatal("network unknown did not freeze target")
			}
			if !relay.seen.Load() {
				t.Fatal("no COMMIT observed")
			}
		})
	}
}
