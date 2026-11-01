package g2

// These are executable protocol experiments, not the platform's write service.
// The mutex models one atomic database transaction. Passing these tests does not
// prove MySQL transaction isolation, crash recovery, OS suspend behavior or auth.
import (
	"bytes"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"sync"
	"testing"
	"time"
)

type protocolScope struct{ Platform, Actor, Workspace, Source string }
type protocolBinding struct {
	Scope      protocolScope
	Preview    string
	Commitment string
	Revision   uint64
}
type protocolPreview struct {
	Binding protocolBinding
	Used    bool
	Closed  bool
}
type protocolConfirmation struct {
	Binding protocolBinding
	Exec    string
	Closed  bool
}
type protocolExecution struct {
	ID, Confirmation, Status string
	Binding                  protocolBinding
}
type protocolRegistry struct {
	mu            sync.Mutex
	previews      map[string]protocolPreview
	confirmations map[string]protocolConfirmation
	executions    map[string]protocolExecution
	outbox        []string
}

var errProtocolRefused = errors.New("reference protocol refused")

func protocolFixture() (*protocolRegistry, protocolBinding) {
	b := protocolBinding{protocolScope{"platform", "admin", "space", "source"}, "preview", "opaque-hmac", 1}
	return &protocolRegistry{
		previews:      map[string]protocolPreview{b.Preview: {Binding: b}},
		confirmations: make(map[string]protocolConfirmation),
		executions:    make(map[string]protocolExecution),
	}, b
}

func (r *protocolRegistry) confirm(id string, b protocolBinding) (string, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if old, exists := r.confirmations[id]; exists {
		if old.Binding != b || old.Closed {
			return "", errProtocolRefused
		}
		return old.Exec, nil
	}
	p, exists := r.previews[b.Preview]
	if !exists || p.Binding != b || p.Used || p.Closed || id == "" {
		return "", errProtocolRefused
	}
	p.Used = true
	r.previews[b.Preview] = p
	execution := fmt.Sprintf("execution-%d", len(r.executions)+1)
	r.confirmations[id] = protocolConfirmation{Binding: b, Exec: execution}
	r.executions[execution] = protocolExecution{execution, id, "registered", b}
	r.outbox = append(r.outbox, execution)
	return execution, nil
}

func (r *protocolRegistry) close(id string, b protocolBinding) (string, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if old, exists := r.confirmations[id]; exists {
		if old.Binding != b {
			return "", errProtocolRefused
		}
		return old.Exec, nil // registered operations are observed, never "unexecuted"
	}
	p, exists := r.previews[b.Preview]
	if !exists || p.Binding != b || p.Used || id == "" {
		return "", errProtocolRefused
	}
	p.Closed = true
	r.previews[b.Preview] = p
	r.confirmations[id] = protocolConfirmation{Binding: b, Closed: true}
	return "", nil
}

func (r *protocolRegistry) recover(scope protocolScope) []protocolExecution {
	r.mu.Lock()
	defer r.mu.Unlock()
	for id, p := range r.previews {
		if p.Binding.Scope == scope && !p.Used {
			p.Closed = true
			r.previews[id] = p
		}
	}
	var found []protocolExecution
	for _, e := range r.executions {
		if e.Binding.Scope == scope {
			found = append(found, e) // includes terminal facts, not just pending tasks
		}
	}
	return found
}

func (r *protocolRegistry) query(id string, scope protocolScope) (protocolConfirmation, bool) {
	r.mu.Lock()
	defer r.mu.Unlock()
	c, ok := r.confirmations[id]
	return c, ok && c.Binding.Scope == scope
}

func TestProtocolConfirmationSingleConsumption(t *testing.T) {
	for _, sameID := range []bool{true, false} {
		t.Run(fmt.Sprintf("same-confirmation=%v", sameID), func(t *testing.T) {
			r, b := protocolFixture()
			const workers = 64
			start := make(chan struct{})
			results := make(chan string, workers)
			var wg sync.WaitGroup
			for i := 0; i < workers; i++ {
				wg.Add(1)
				go func(i int) {
					defer wg.Done()
					<-start
					id := "confirmation"
					if !sameID {
						id = fmt.Sprintf("confirmation-%d", i)
					}
					if e, err := r.confirm(id, b); err == nil {
						results <- e
					}
				}(i)
			}
			close(start)
			wg.Wait()
			close(results)
			successes := 0
			for e := range results {
				successes++
				if e != "execution-1" {
					t.Fatalf("duplicate identity: %q", e)
				}
			}
			want := 1
			if sameID {
				want = workers
			}
			if successes != want || len(r.executions) != 1 || len(r.outbox) != 1 {
				t.Fatalf("success=%d executions=%d outbox=%d", successes, len(r.executions), len(r.outbox))
			}
		})
	}
	r, b := protocolFixture()
	if _, err := r.confirm("confirmation", b); err != nil {
		t.Fatal(err)
	}
	for _, mutate := range []func(*protocolBinding){
		func(b *protocolBinding) { b.Commitment = "other" },
		func(b *protocolBinding) { b.Revision++ },
		func(b *protocolBinding) { b.Preview = "other" },
		func(b *protocolBinding) { b.Scope.Actor = "other" },
		func(b *protocolBinding) { b.Scope.Source = "other" },
	} {
		changed := b
		mutate(&changed)
		if _, err := r.confirm("confirmation", changed); err == nil {
			t.Fatal("same confirmation accepted different content or scope")
		}
	}
	for i := 0; i < 5; i++ {
		if _, ok := r.query("confirmation", b.Scope); !ok {
			t.Fatal("original confirmation unavailable")
		}
	}
	other := b.Scope
	other.Workspace = "other"
	if _, ok := r.query("confirmation", other); ok || len(r.outbox) != 1 {
		t.Fatal("query leaked scope or dispatched another execution")
	}
	t.Log("reference only: 64 concurrent registrations yield one preview consumption and one outbox identity")
}

func TestProtocolCloseRecoveryAndLateConfirmation(t *testing.T) {
	for _, recovery := range []bool{false, true} {
		for iteration := 0; iteration < 128; iteration++ {
			r, b := protocolFixture()
			start := make(chan struct{})
			var wg sync.WaitGroup
			var confirmed, observed string
			var list []protocolExecution
			wg.Add(2)
			go func() { defer wg.Done(); <-start; confirmed, _ = r.confirm("confirmation", b) }()
			go func() {
				defer wg.Done()
				<-start
				if recovery {
					list = r.recover(b.Scope)
				} else {
					observed, _ = r.close("confirmation", b)
				}
			}()
			close(start)
			wg.Wait()
			if len(r.executions) > 1 || len(r.outbox) != len(r.executions) {
				t.Fatal("non-atomic execution/outbox registration")
			}
			if confirmed != "" {
				if (!recovery && observed != confirmed) || (recovery && (len(list) != 1 || list[0].ID != confirmed)) {
					t.Fatal("registration won but recovery hid its identity")
				}
			} else if len(r.executions) != 0 {
				t.Fatal("barrier won but an execution was allocated")
			}
			if _, err := r.confirm("late-new-confirmation", b); err == nil {
				t.Fatal("old preview was reusable after close/recovery race")
			}
		}
	}
	// An empty query is not a fence: a request may arrive after that read.
	r, b := protocolFixture()
	if _, ok := r.query("confirmation", b.Scope); ok {
		t.Fatal("unexpected fixture registration")
	}
	if _, err := r.confirm("confirmation", b); err != nil {
		t.Fatal("the experiment should expose the read-then-late-request schedule")
	}
	e := r.executions["execution-1"]
	e.Status = "committed"
	r.executions[e.ID] = e
	if found := r.recover(b.Scope); len(found) != 1 || found[0].Status != "committed" {
		t.Fatal("recovery discarded the terminal execution whose acknowledgement was lost")
	}
	other := b
	other.Preview = "other-preview"
	other.Scope.Workspace = "other-workspace"
	r.previews[other.Preview] = protocolPreview{Binding: other}
	if found := r.recover(other.Scope); len(found) != 0 {
		t.Fatal("scope recovery revealed another workspace's execution")
	}
	if _, err := r.confirm("other-confirmation", other); err == nil {
		t.Fatal("recovery did not invalidate the other scope's own outstanding preview")
	}
	t.Log("reference only: 256 registration/barrier schedules; an empty GET alone is deliberately demonstrated insufficient")
}

type protocolPermitRequest struct {
	Execution, Commitment, Connector, Boot string
	Scope                                  protocolScope
	PolicyGeneration                       uint64
	Challenge                              [32]byte
	BudgetNanos                            uint64
}
type protocolSignedPermit struct{ Body, Signature []byte }

func protocolCopyPermit(p protocolSignedPermit) protocolSignedPermit {
	return protocolSignedPermit{bytes.Clone(p.Body), bytes.Clone(p.Signature)}
}

type protocolPermitAuthority struct {
	mu      sync.Mutex
	private ed25519.PrivateKey
	public  ed25519.PublicKey
	first   map[string]protocolSignedPermit
	allowed protocolPermitRequest
	revoked bool
}

const protocolPermitBudget = uint64(3 * time.Second)

func protocolNewAuthority(t *testing.T, req protocolPermitRequest) *protocolPermitAuthority {
	t.Helper()
	pub, private, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	return &protocolPermitAuthority{private: private, public: pub, first: make(map[string]protocolSignedPermit), allowed: req}
}
func protocolPermitBytes(req protocolPermitRequest) []byte {
	body, _ := json.Marshal(req) // fixed Go-produced fields; no cross-language reconstruction
	return append([]byte("stage8-g2-permit-reference\x00"), body...)
}
func (a *protocolPermitAuthority) issue(req protocolPermitRequest) (protocolSignedPermit, error) {
	a.mu.Lock()
	defer a.mu.Unlock()
	if first, ok := a.first[req.Execution]; ok {
		if !bytes.Equal(first.Body, protocolPermitBytes(req)) {
			return protocolSignedPermit{}, errProtocolRefused
		}
		return protocolCopyPermit(first), nil
	}
	if a.revoked || req != a.allowed || req.BudgetNanos != protocolPermitBudget || req.Challenge == [32]byte{} {
		return protocolSignedPermit{}, errProtocolRefused
	}
	body := protocolPermitBytes(req)
	p := protocolSignedPermit{body, ed25519.Sign(a.private, body)}
	a.first[req.Execution] = p
	return protocolCopyPermit(p), nil
}
func (a *protocolPermitAuthority) revoke() {
	a.mu.Lock()
	defer a.mu.Unlock()
	a.revoked = true
}

type protocolPermitAttempt struct {
	mu                    sync.Mutex
	request               protocolPermitRequest
	public                ed25519.PublicKey
	start, deadline, last uint64
	cancelled, started    bool
	invalid               bool
}

func protocolNewAttempt(t *testing.T, start, transactionDeadline uint64) (*protocolPermitAttempt, *protocolPermitAuthority) {
	t.Helper()
	req := protocolPermitRequest{
		Execution: "execution", Commitment: "opaque-hmac", Connector: "connector", Boot: "boot-one",
		Scope: protocolScope{"platform", "admin", "space", "source"}, PolicyGeneration: 4, BudgetNanos: protocolPermitBudget,
	}
	if _, err := rand.Read(req.Challenge[:]); err != nil {
		t.Fatal(err)
	}
	a := protocolNewAuthority(t, req)
	deadline := start + protocolPermitBudget
	if transactionDeadline < deadline {
		deadline = transactionDeadline
	}
	return &protocolPermitAttempt{request: req, public: a.public, start: start, deadline: deadline, last: start}, a
}
func (c *protocolPermitAttempt) cancel() {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.cancelled = true
}
func (c *protocolPermitAttempt) beginCommit(p protocolSignedPermit, now uint64, boot string, policy uint64, continuity bool) bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.cancelled || c.started || c.invalid {
		return false
	}
	if !continuity || now < c.last || boot != c.request.Boot || policy != c.request.PolicyGeneration {
		c.invalid = true
		return false
	}
	c.last = now
	if now < c.start || now >= c.deadline {
		c.invalid = true
		return false
	}
	if !ed25519.Verify(c.public, p.Body, p.Signature) || !bytes.Equal(p.Body, protocolPermitBytes(c.request)) {
		return false
	}
	c.started = true // models the policy-lock linearization, not a MySQL commit
	return true
}

func TestProtocolPermitSignatureBindingAndFixedDeadline(t *testing.T) {
	for _, tc := range []struct {
		name       string
		elapsed    uint64
		boot       string
		policy     uint64
		continuity bool
		want       bool
	}{
		{"before-deadline", uint64(2 * time.Second), "boot-one", 4, true, true},
		{"exact-deadline", protocolPermitBudget, "boot-one", 4, true, false},
		{"delayed-response", uint64(7 * time.Second), "boot-one", 4, true, false},
		{"restart", uint64(time.Second), "boot-two", 4, true, false},
		{"policy-revoked", uint64(time.Second), "boot-one", 5, true, false},
		{"suspend-continuity-unproved", uint64(time.Second), "boot-one", 4, false, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			const start = uint64(100 * time.Second)
			attempt, api := protocolNewAttempt(t, start, start+uint64(15*time.Second))
			p, err := api.issue(attempt.request)
			if err != nil {
				t.Fatal(err)
			}
			if got := attempt.beginCommit(p, start+tc.elapsed, tc.boot, tc.policy, tc.continuity); got != tc.want {
				t.Fatalf("beginCommit=%v want %v", got, tc.want)
			}
		})
	}
	start := uint64(100 * time.Second)
	attempt, api := protocolNewAttempt(t, start, start+uint64(15*time.Second))
	p, err := api.issue(attempt.request)
	if err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 5; i++ {
		again, err := api.issue(attempt.request)
		if err != nil || !bytes.Equal(p.Body, again.Body) || !bytes.Equal(p.Signature, again.Signature) {
			t.Fatal("same request did not recover the same first permit")
		}
	}
	if attempt.beginCommit(p, start+uint64(4*time.Second), "boot-one", 4, true) {
		t.Fatal("duplicate responses extended the local deadline")
	}
	for _, change := range []func(*protocolPermitRequest){
		func(r *protocolPermitRequest) { r.Challenge[0] ^= 1 },
		func(r *protocolPermitRequest) { r.Boot = "boot-two" },
		func(r *protocolPermitRequest) { r.Commitment = "changed" },
		func(r *protocolPermitRequest) { r.Scope.Source = "other" },
		func(r *protocolPermitRequest) { r.PolicyGeneration++ },
		func(r *protocolPermitRequest) { r.BudgetNanos++ },
	} {
		changed := attempt.request
		change(&changed)
		if _, err := api.issue(changed); err == nil {
			t.Fatal("same execution obtained a replacement permit binding")
		}
	}
	clean, api := protocolNewAttempt(t, start, start+uint64(time.Second))
	p, err = api.issue(clean.request)
	if err != nil {
		t.Fatal(err)
	}
	if clean.beginCommit(p, start+uint64(time.Second), "boot-one", 4, true) {
		t.Fatal("permit exceeded the shorter transaction deadline")
	}
	clean, api = protocolNewAttempt(t, start, start+protocolPermitBudget)
	p, err = api.issue(clean.request)
	if err != nil {
		t.Fatal(err)
	}
	tampered := protocolSignedPermit{append([]byte(nil), p.Body...), append([]byte(nil), p.Signature...)}
	tampered.Body[len(tampered.Body)-1] ^= 1
	if clean.beginCommit(tampered, start+1, "boot-one", 4, true) {
		t.Fatal("tampered signed bytes accepted")
	}
	if !clean.beginCommit(p, start+2, "boot-one", 4, true) || clean.beginCommit(p, start+3, "boot-one", 4, true) {
		t.Fatal("commit start was not single-use")
	}
	clean, api = protocolNewAttempt(t, start, start+protocolPermitBudget)
	p, err = api.issue(clean.request)
	if err != nil {
		t.Fatal(err)
	}
	if clean.beginCommit(p, start+1, "boot-one", 4, false) || clean.beginCommit(p, start+2, "boot-one", 4, true) {
		t.Fatal("a permit with unproved clock continuity became usable again")
	}
	clean, api = protocolNewAttempt(t, start, start+protocolPermitBudget)
	p, err = api.issue(clean.request)
	if err != nil {
		t.Fatal(err)
	}
	clean.last = start + uint64(time.Second)
	if clean.beginCommit(p, start+1, "boot-one", 4, true) || clean.beginCommit(p, start+uint64(2*time.Second), "boot-one", 4, true) {
		t.Fatal("a backwards monotonic clock was not latched invalid")
	}
	t.Log("synthetic clock vectors and real Ed25519 signatures only; no wall clock was adjusted and no database was committed")
}

func TestProtocolPermitRevocationAndCancellationOrdering(t *testing.T) {
	for i := 0; i < 128; i++ {
		attempt, api := protocolNewAttempt(t, 100, 100+protocolPermitBudget)
		gate := make(chan struct{})
		var wg sync.WaitGroup
		var p protocolSignedPermit
		var issued bool
		wg.Add(2)
		go func() {
			defer wg.Done()
			<-gate
			var err error
			p, err = api.issue(attempt.request)
			issued = err == nil
		}()
		go func() { defer wg.Done(); <-gate; api.revoke() }()
		close(gate)
		wg.Wait()
		if issued {
			// A permit that linearized before revocation cannot promise instant
			// cross-network cancellation. The local cancel lock still wins if first.
			attempt.cancel()
			if attempt.beginCommit(p, 101, "boot-one", 4, true) {
				t.Fatal("a local cancellation that won before commit was ignored")
			}
		} else if len(api.first) != 0 {
			t.Fatal("revocation won but a first permit was persisted")
		}
	}
	attempt, api := protocolNewAttempt(t, 100, 100+protocolPermitBudget)
	api.revoke()
	if _, err := api.issue(attempt.request); err == nil {
		t.Fatal("revoked scope received its first permit")
	}
	attempt, api = protocolNewAttempt(t, 100, 100+protocolPermitBudget)
	p, err := api.issue(attempt.request)
	if err != nil || !attempt.beginCommit(p, 101, "boot-one", 4, true) {
		t.Fatal("reference commit did not start")
	}
	attempt.cancel()
	if !attempt.started {
		t.Fatal("late cancel invented rollback of a commit that had started")
	}
	// Simulates the API retaining its durable first-permit row on restart.
	restarted := &protocolPermitAuthority{private: api.private, public: api.public, first: api.first, allowed: api.allowed}
	old, err := restarted.issue(attempt.request)
	if err != nil || !bytes.Equal(old.Signature, p.Signature) {
		t.Fatal("restored first permit changed after API restart")
	}
	t.Log("reference ordering only: scope revocation serializes with first issuance; later local cancellation never proves rollback")
}

type protocolPhysicalIdentity struct {
	Verified, Ambiguous bool
	ServerUUID, Catalog string
	LowerCaseTableNames int
}

func protocolPhysicalKey(i protocolPhysicalIdentity) (string, error) {
	compact := strings.ReplaceAll(i.ServerUUID, "-", "")
	if !i.Verified || i.Ambiguous || len(compact) != 32 || i.Catalog == "" || i.LowerCaseTableNames < 0 || i.LowerCaseTableNames > 2 {
		return "", errProtocolRefused
	}
	if _, err := hex.DecodeString(compact); err != nil {
		return "", errProtocolRefused
	}
	catalog := i.Catalog
	if i.LowerCaseTableNames != 0 {
		catalog = strings.ToLower(catalog)
	}
	return strings.ToLower(compact) + "\x00" + catalog, nil
}

func TestProtocolPhysicalAliasFreeze(t *testing.T) {
	identity := protocolPhysicalIdentity{true, false, "7b09a5a8-a09c-4eac-aa6d-a3d2d4028141", "CustomerDB", 1}
	key, err := protocolPhysicalKey(identity)
	if err != nil {
		t.Fatal(err)
	}
	frozen := map[string]bool{key: true}
	// Source IDs, host aliases and account names are deliberately not part of
	// this key. This does not claim automatically discovering physical identity.
	alias := identity
	alias.Catalog = "customerdb"
	alias.ServerUUID = strings.ToUpper(alias.ServerUUID)
	aliasKey, err := protocolPhysicalKey(alias)
	if err != nil || !frozen[aliasKey] {
		t.Fatal("equivalent verified source escaped the shared freeze")
	}
	for _, bad := range []protocolPhysicalIdentity{
		{false, false, identity.ServerUUID, identity.Catalog, 1},
		{true, true, identity.ServerUUID, identity.Catalog, 1},
		{true, false, "unverified", identity.Catalog, 1},
		{true, false, identity.ServerUUID, "", 1},
		{true, false, identity.ServerUUID, identity.Catalog, 3},
	} {
		if _, err := protocolPhysicalKey(bad); err == nil {
			t.Fatal("unproven physical identity gained a writable grouping key")
		}
	}
	caseSensitive := identity
	caseSensitive.LowerCaseTableNames = 0
	a, _ := protocolPhysicalKey(caseSensitive)
	caseSensitive.Catalog = strings.ToLower(caseSensitive.Catalog)
	b, _ := protocolPhysicalKey(caseSensitive)
	if a == b {
		t.Fatal("distinct case-sensitive catalogs were incorrectly merged")
	}
	t.Log("reference grouping only: verified UUID/catalog aliases share freeze; cloned UUIDs and proxy/topology ambiguity still require rejection or an independently proven mapping")
}
