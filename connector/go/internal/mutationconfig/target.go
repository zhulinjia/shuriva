// Package mutationconfig defines the shared, local-only target connection and
// scope values. It has no dependency on the credential vault or MySQL driver.
package mutationconfig

import (
	"errors"
	"net"
	"strings"
)

var ErrCredentials = errors.New("mutation credentials unavailable; writes remain disabled")

// Credential never crosses a platform DTO or enters a diagnostic record.
type Credential struct {
	Host     string `json:"host"`
	Port     int    `json:"port"`
	Database string `json:"database"`
	Username string `json:"username"`
	Password string `json:"password"`
	TLS      string `json:"tls"`
}

func (c Credential) Validate() error {
	if c.Host == "" || strings.ContainsAny(c.Host, "\x00\r\n/\\") || c.Port < 1 || c.Port > 65535 || c.Database == "" || c.Username == "" || c.Password == "" || len(c.Password) > 1024 {
		return ErrCredentials
	}
	if c.TLS == "local" {
		ip := net.ParseIP(c.Host)
		if c.Host != "localhost" && (ip == nil || !ip.IsLoopback()) {
			return ErrCredentials
		}
	} else if c.TLS != "required" {
		return ErrCredentials
	}
	return nil
}

// Target contains only what a target adapter actually needs. Vault metadata,
// artifact paths and encryption roots are owned by the storage layer.
type Target struct {
	SourceID     string
	ConnectorID  string
	WorkspaceIDs []string
	Writer       Credential
	Recovery     Credential
}

func (p Target) Validate() error {
	if p.SourceID == "" || p.ConnectorID == "" || len(p.WorkspaceIDs) == 0 || len(p.WorkspaceIDs) > 32 {
		return ErrCredentials
	}
	seen := map[string]bool{}
	for _, id := range p.WorkspaceIDs {
		if id == "" || seen[id] {
			return ErrCredentials
		}
		seen[id] = true
	}
	if p.Writer.Validate() != nil || p.Recovery.Validate() != nil || p.Writer.Username == p.Recovery.Username || p.Writer.Host != p.Recovery.Host || p.Writer.Port != p.Recovery.Port || p.Writer.Database != p.Recovery.Database {
		return ErrCredentials
	}
	return nil
}
func (p Target) Allows(connector, workspace, source string) bool {
	if p.SourceID != source || p.ConnectorID != connector {
		return false
	}
	for _, id := range p.WorkspaceIDs {
		if id == workspace {
			return true
		}
	}
	return false
}
