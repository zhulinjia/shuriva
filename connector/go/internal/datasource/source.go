// Package datasource owns local datasource configuration and metadata access.
package datasource

import (
	"crypto/rand"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"regexp"
	"strings"
	"time"
	"unicode/utf8"

	"example.com/ai-database-workspace/connector/internal/queryguard"
	"github.com/zalando/go-keyring"
)

const service = "ai-database-workspace-datasource-v1"

var idPattern = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`)
var hostPattern = regexp.MustCompile(`^[a-zA-Z0-9](?:[a-zA-Z0-9.-]*[a-zA-Z0-9])?$`)

// Profile is stored in the Connector's OS credential store, never sent to the platform.
type Profile struct {
	ID              string                         `json:"id"`
	ConnectorID     string                         `json:"connectorId"`
	WorkspaceIDs    []string                       `json:"workspaceIds"`
	Host            string                         `json:"host"`
	Port            int                            `json:"port"`
	Database        string                         `json:"database"`
	Username        string                         `json:"username"`
	Password        string                         `json:"password"`
	TLS             string                         `json:"tls"` // required, or local for explicitly chosen loopback TCP
	ReadScopes      map[string]map[string][]string `json:"readScopes,omitempty"`
	ModelLeaseUntil int64                          `json:"modelLeaseUntil,omitempty"`
	Revision        string                         `json:"revision,omitempty"`
}

type Vault interface {
	Get(id string) (Profile, error)
	Set(profile Profile) error
	Delete(id string) error
}

type SystemVault struct{}

var ErrModelLease = errors.New("模型发送授权正在使用中，请稍后重试修改本机数据源")

func modelLeaseActive(p Profile, now time.Time) bool {
	return p.ModelLeaseUntil > now.Unix()
}

// AcquireModelLease is called under the connector's exclusive process lock.
// Persist before returning so an unexpected connector exit cannot release it.
func (v SystemVault) AcquireModelLease(id, connectorID string, until int64) (Profile, error) {
	p, err := v.Get(id)
	if err != nil {
		return Profile{}, err
	}
	now := time.Now().Unix()
	if p.ConnectorID != connectorID || until <= now || until > now+36 {
		return Profile{}, errors.New("invalid model authorization lease")
	}
	if until > p.ModelLeaseUntil {
		p.ModelLeaseUntil = until
	}
	raw, err := json.Marshal(p)
	if err != nil || keyring.Set(service, id, string(raw)) != nil {
		return Profile{}, errors.New("credential store unavailable")
	}
	verified, err := v.Get(id)
	if err != nil || verified.ModelLeaseUntil < until {
		return Profile{}, errors.New("model authorization lease unavailable")
	}
	return verified, nil
}

// IDs are indexed per connector so operators can inspect and remove credentials
// before resetting an identity. Callers serialize mutations with the connector lock.
func (SystemVault) List(connectorID string) ([]string, error) {
	if !ValidID(connectorID) {
		return nil, errors.New("invalid connector ID")
	}
	raw, err := keyring.Get(service, "index-"+connectorID)
	if errors.Is(err, keyring.ErrNotFound) {
		return []string{}, nil
	}
	if err != nil {
		return nil, errors.New("credential store unavailable")
	}
	var ids []string
	if json.Unmarshal([]byte(raw), &ids) != nil {
		return nil, errors.New("invalid data source index")
	}
	seen := map[string]bool{}
	for _, id := range ids {
		if !ValidID(id) || seen[id] {
			return nil, errors.New("invalid data source index")
		}
		seen[id] = true
	}
	return ids, nil
}

func writeIndex(connectorID string, ids []string) error {
	raw, err := json.Marshal(ids)
	if err != nil || keyring.Set(service, "index-"+connectorID, string(raw)) != nil {
		return errors.New("credential store unavailable")
	}
	return nil
}

// Adopt explicitly transfers a local profile to a newly paired connector.
// The caller must stop both connector processes and hold the new identity lock.
func (v SystemVault) Adopt(id, oldConnector, newConnector string) error {
	if !ValidID(oldConnector) || !ValidID(newConnector) || oldConnector == newConnector {
		return errors.New("invalid connector identity")
	}
	p, err := v.Get(id)
	if err != nil {
		return err
	}
	if modelLeaseActive(p, time.Now()) {
		return ErrModelLease
	}
	if p.ConnectorID != oldConnector && p.ConnectorID != newConnector {
		return errors.New("data source belongs to another connector")
	}
	newIDs, err := v.List(newConnector)
	if err != nil {
		return err
	}
	oldIDs, err := v.List(oldConnector)
	if err != nil {
		return err
	}
	indexed := false
	for _, item := range newIDs {
		if item == id {
			indexed = true
		}
	}
	if !indexed {
		if err := writeIndex(newConnector, append(newIDs, id)); err != nil {
			return err
		}
	}
	if p.ConnectorID == oldConnector {
		p.ConnectorID = newConnector
		p.Revision, err = NewID()
		if err != nil {
			return errors.New("cannot create data source revision")
		}
		raw, err := json.Marshal(p)
		if err != nil {
			return errors.New("cannot encode data source")
		}
		if err := keyring.Set(service, id, string(raw)); err != nil {
			return errors.New("credential store unavailable; retry adopt")
		}
	}
	remaining := make([]string, 0, len(oldIDs))
	for _, item := range oldIDs {
		if item != id {
			remaining = append(remaining, item)
		}
	}
	if err := writeIndex(oldConnector, remaining); err != nil {
		return errors.New("profile moved; old connector index cleanup failed")
	}
	return nil
}

// ForgetMissing removes only a stale index entry; it never deletes a credential.
func (v SystemVault) ForgetMissing(connectorID, id string) error {
	if !ValidID(id) {
		return errors.New("invalid data source ID")
	}
	ids, err := v.List(connectorID)
	if err != nil {
		return err
	}
	_, err = keyring.Get(service, id)
	if !errors.Is(err, keyring.ErrNotFound) {
		return errors.New("credential exists or credential store unavailable")
	}
	remaining := make([]string, 0, len(ids))
	found := false
	for _, item := range ids {
		if item == id {
			found = true
		} else {
			remaining = append(remaining, item)
		}
	}
	if !found {
		return errors.New("data source is not indexed")
	}
	return writeIndex(connectorID, remaining)
}

func (SystemVault) Get(id string) (Profile, error) {
	var p Profile
	if !idPattern.MatchString(id) {
		return p, errors.New("invalid data source ID")
	}
	raw, err := keyring.Get(service, id)
	if err != nil {
		return p, errors.New("data source credential unavailable")
	}
	if json.Unmarshal([]byte(raw), &p) != nil || p.ID != id || p.Validate() != nil {
		return Profile{}, errors.New("invalid stored data source configuration")
	}
	return p, nil
}

func (SystemVault) Set(p Profile) error {
	if err := p.Validate(); err != nil {
		return err
	}
	var revisionErr error
	p.Revision, revisionErr = NewID()
	if revisionErr != nil {
		return errors.New("cannot create data source revision")
	}
	_, err := keyring.Get(service, p.ID)
	if err == nil {
		return errors.New("data source already exists")
	}
	if !errors.Is(err, keyring.ErrNotFound) {
		return errors.New("credential store unavailable")
	}
	raw, err := json.Marshal(p)
	if err != nil {
		return errors.New("cannot encode data source")
	}
	ids, err := (SystemVault{}).List(p.ConnectorID)
	if err != nil {
		return err
	}
	for _, id := range ids {
		if id == p.ID {
			return errors.New("data source ID already indexed")
		}
	}
	if err := writeIndex(p.ConnectorID, append(ids, p.ID)); err != nil {
		return err
	}
	if err := keyring.Set(service, p.ID, string(raw)); err != nil {
		_ = writeIndex(p.ConnectorID, ids)
		return errors.New("credential store unavailable")
	}
	return nil
}

// Replace updates a locally owned profile after the caller has acquired its
// Connector lock. The Connector identity cannot be changed through this path.
func (v SystemVault) Replace(p Profile) error {
	if err := p.Validate(); err != nil {
		return err
	}
	old, err := v.Get(p.ID)
	if err != nil {
		return err
	}
	if modelLeaseActive(old, time.Now()) {
		return ErrModelLease
	}
	if old.ConnectorID != p.ConnectorID {
		return errors.New("connector identity cannot be changed")
	}
	p.Revision, err = NewID()
	if err != nil {
		return errors.New("cannot create data source revision")
	}
	raw, err := json.Marshal(p)
	if err != nil {
		return errors.New("cannot encode data source")
	}
	if keyring.Set(service, p.ID, string(raw)) != nil {
		return errors.New("credential store unavailable")
	}
	return nil
}

func (SystemVault) Delete(id string) error {
	if !idPattern.MatchString(id) {
		return errors.New("invalid data source ID")
	}
	p, err := (SystemVault{}).Get(id)
	if err != nil {
		return err
	}
	if modelLeaseActive(p, time.Now()) {
		return ErrModelLease
	}
	ids, err := (SystemVault{}).List(p.ConnectorID)
	if err != nil {
		return err
	}
	if err := keyring.Delete(service, id); err != nil {
		return errors.New("data source credential unavailable")
	}
	remaining := make([]string, 0, len(ids))
	for _, item := range ids {
		if item != id {
			remaining = append(remaining, item)
		}
	}
	if err := writeIndex(p.ConnectorID, remaining); err != nil {
		return err
	}
	return nil
}

func ValidID(id string) bool { return idPattern.MatchString(id) }

func NewID() (string, error) {
	b := make([]byte, 16)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	b[6] = (b[6] & 0x0f) | 0x40
	b[8] = (b[8] & 0x3f) | 0x80
	return fmt.Sprintf("%08x-%04x-%04x-%04x-%012x", b[0:4], b[4:6], b[6:8], b[8:10], b[10:16]), nil
}

func safe(value string, max int) bool {
	return utf8.ValidString(value) && len(value) > 0 && len(value) <= max && !strings.ContainsFunc(value, func(r rune) bool { return r < 32 || r == 127 })
}

func (p Profile) Validate() error {
	if p.ModelLeaseUntil < 0 || (p.Revision != "" && !ValidID(p.Revision)) || !ValidID(p.ID) || !ValidID(p.ConnectorID) || len(p.WorkspaceIDs) > 100 || !safe(p.Host, 253) || p.Port < 1 || p.Port > 65535 || !safe(p.Database, 256) || utf8.RuneCountInString(p.Database) > 64 || !safe(p.Username, 128) || !safe(p.Password, 512) {
		return errors.New("invalid data source configuration")
	}
	seen := make(map[string]bool, len(p.WorkspaceIDs))
	for _, id := range p.WorkspaceIDs {
		if !ValidID(id) || seen[id] {
			return errors.New("invalid workspace scope")
		}
		seen[id] = true
	}
	if len(p.ReadScopes) > 100 {
		return errors.New("invalid query policy")
	}
	for workspace, tables := range p.ReadScopes {
		if !seen[workspace] || len(tables) > 256 {
			return errors.New("invalid query policy")
		}
		for table, columns := range tables {
			if !queryguard.ValidIdentifier(table) || len(columns) == 0 || len(columns) > 256 {
				return errors.New("invalid query policy")
			}
			unique := make(map[string]bool, len(columns))
			for _, column := range columns {
				if !queryguard.ValidIdentifier(column) || unique[column] {
					return errors.New("invalid query policy")
				}
				unique[column] = true
			}
		}
	}
	if net.ParseIP(p.Host) == nil && (!hostPattern.MatchString(p.Host) || strings.Contains(p.Host, "..")) {
		return errors.New("invalid database host")
	}
	switch strings.ToLower(p.Database) {
	case "mysql", "sys", "performance_schema", "information_schema":
		return errors.New("system databases are not supported")
	}
	if p.TLS != "required" && p.TLS != "local" {
		return errors.New("invalid database TLS policy")
	}
	if p.TLS == "local" {
		ip := net.ParseIP(p.Host)
		if p.Host != "localhost" && (ip == nil || !ip.IsLoopback()) {
			return errors.New("unencrypted connections require a loopback address")
		}
	}
	return nil
}

func (p Profile) Allows(workspaceID string) bool {
	for _, id := range p.WorkspaceIDs {
		if id == workspaceID {
			return true
		}
	}
	return false
}
