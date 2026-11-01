package agent

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"testing"
	"time"

	"example.com/ai-database-workspace/connector/internal/datasource"
	"example.com/ai-database-workspace/connector/internal/protocol"
)

type blockingReadSource struct {
	started chan struct{}
	resume  chan struct{}
}

type failingTransport struct{}

func (failingTransport) RoundTrip(*http.Request) (*http.Response, error) {
	return nil, errors.New("offline fixture")
}

func TestClientCancelsBeforeRunnerStarts(t *testing.T) {
	public, platformPrivate, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	_, connectorPrivate, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	connector := "22222222-2222-4222-8222-222222222222"
	workspace := "33333333-3333-4333-8333-333333333333"
	source := "44444444-4444-4444-8444-444444444444"
	cfg := Config{ConnectorID: connector, PlatformPublicKey: protocol.Encode(public)}
	vault := &memoryVault{data: map[string]KeyState{connector: {Active: "fixture"}}}
	sources := &blockingReadSource{started: make(chan struct{}), resume: make(chan struct{})}
	close(sources.resume)
	runner := NewReadRunner(cfg, vault, sources)
	// Prevent Execute from beginning until the cancellation has arrived.
	runner.permit <- struct{}{}
	client := &Client{Server: "http://localhost", HTTP: &http.Client{Transport: failingTransport{}}, readRunner: runner}
	payload, _ := json.Marshal(protocol.ReadRequest{SQL: "SELECT id FROM customers", Parameters: []protocol.ReadParameter{}, MaxRows: 10})
	now := time.Now().Unix()
	read := protocol.ReadTask{ID: "11111111-1111-4111-8111-111111111111", ConnectorID: connector, ActorID: "owner", WorkspaceID: workspace, SourceID: source, Operation: "read_query", Payload: protocol.Encode(payload), IssuedAt: now, ExpiresAt: now + 60, Nonce: protocol.Encode(make([]byte, 32)), Protocol: 1}
	read.Signature = protocol.Encode(ed25519.Sign(platformPrivate, []byte(strings.Join(protocol.ReadTaskFields(read), "\n"))))
	task := protocol.Task{ID: read.ID, ConnectorID: connector, ActorID: read.ActorID, WorkspaceID: workspace, SourceID: source, Operation: read.Operation, Payload: read.Payload, IssuedAt: now, ExpiresAt: now + 60, Nonce: read.Nonce, Protocol: 1, Signature: read.Signature}
	ctx, stop := context.WithCancel(context.Background())
	defer stop()
	if err := client.dispatchRead(ctx, cfg, task, connectorPrivate); err != nil {
		t.Fatal(err)
	}
	cancel := protocol.ReadCancel{TaskID: read.ID, ConnectorID: connector, ActorID: read.ActorID, WorkspaceID: workspace, SourceID: source, IssuedAt: now, ExpiresAt: now + 60, Nonce: protocol.Encode(make([]byte, 32))}
	cancel.Signature = protocol.Encode(ed25519.Sign(platformPrivate, []byte(strings.Join(protocol.ReadCancelFields(cancel), "\n"))))
	cancelTask := protocol.Task{ID: cancel.TaskID, ConnectorID: connector, ActorID: cancel.ActorID, WorkspaceID: workspace, SourceID: source, Operation: "cancel_read", IssuedAt: now, ExpiresAt: now + 60, Nonce: cancel.Nonce, Protocol: 1, Signature: cancel.Signature}
	if err := client.cancelRead(context.Background(), cancelTask, connectorPrivate); err != nil {
		t.Fatal(err)
	}
	stop()
	<-runner.permit
	client.readWait.Wait()
	select {
	case <-sources.started:
		t.Fatal("cancelled task accessed local data source")
	default:
	}
}

func (v *blockingReadSource) Get(string) (datasource.Profile, error) {
	close(v.started)
	<-v.resume
	return datasource.Profile{}, nil
}
func (*blockingReadSource) Set(datasource.Profile) error { return errors.New("unsupported") }
func (*blockingReadSource) Delete(string) error          { return errors.New("unsupported") }

func TestReadRunnerCancellationIsSignedAndBoundToActiveTask(t *testing.T) {
	public, private, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	connector := "22222222-2222-4222-8222-222222222222"
	workspace := "33333333-3333-4333-8333-333333333333"
	source := "44444444-4444-4444-8444-444444444444"
	vault := &memoryVault{data: map[string]KeyState{connector: {Active: "fixture"}}}
	sources := &blockingReadSource{started: make(chan struct{}), resume: make(chan struct{})}
	runner := NewReadRunner(Config{ConnectorID: connector, PlatformPublicKey: protocol.Encode(public)}, vault, sources)
	payload, _ := json.Marshal(protocol.ReadRequest{SQL: "SELECT id FROM customers", Parameters: []protocol.ReadParameter{}, MaxRows: 10})
	now := time.Now().Unix()
	task := protocol.ReadTask{ID: "11111111-1111-4111-8111-111111111111", ConnectorID: connector, ActorID: "owner", WorkspaceID: workspace, SourceID: source, Operation: "read_query", Payload: protocol.Encode(payload), IssuedAt: now, ExpiresAt: now + 60, Nonce: protocol.Encode(make([]byte, 32)), Protocol: 1}
	task.Signature = protocol.Encode(ed25519.Sign(private, []byte(strings.Join(protocol.ReadTaskFields(task), "\n"))))
	finished := make(chan error, 1)
	go func() { _, err := runner.Execute(context.Background(), task); finished <- err }()
	select {
	case <-sources.started:
	case <-time.After(5 * time.Second):
		t.Fatal("read did not start")
	}
	cancel := protocol.ReadCancel{TaskID: task.ID, ConnectorID: connector, ActorID: "owner", WorkspaceID: workspace, SourceID: source, IssuedAt: now, ExpiresAt: now + 60, Nonce: protocol.Encode(make([]byte, 32))}
	cancel.Signature = protocol.Encode(ed25519.Sign(private, []byte(strings.Join(protocol.ReadCancelFields(cancel), "\n"))))
	forged := cancel
	forged.WorkspaceID = "55555555-5555-4555-8555-555555555555"
	if ok, err := runner.Cancel(forged); err == nil || ok {
		t.Fatal("forged cancellation accepted")
	}
	other := cancel
	other.TaskID = "55555555-5555-4555-8555-555555555555"
	other.Signature = protocol.Encode(ed25519.Sign(private, []byte(strings.Join(protocol.ReadCancelFields(other), "\n"))))
	if ok, err := runner.Cancel(other); err != nil || ok {
		t.Fatal("other task cancellation accepted")
	}
	if ok, err := runner.Cancel(cancel); err != nil || !ok {
		t.Fatal("valid cancellation rejected")
	}
	close(sources.resume)
	select {
	case err := <-finished:
		if !errors.Is(err, datasource.ErrQueryCancelled) {
			t.Fatalf("read did not report cancellation: %v", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("read did not stop")
	}
	if ok, err := runner.Cancel(cancel); err != nil || ok {
		t.Fatal("completed task cancellation accepted")
	}
}
