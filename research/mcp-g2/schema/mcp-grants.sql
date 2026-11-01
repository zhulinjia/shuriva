-- G2 application-grant draft. Tested only inside a freshly guarded fixture.
-- Auth owns the session table: keep its public ID without a cross-module FK
-- which could erase the approval identity when a session is deleted.
CREATE TABLE mcp_grant (
  id CHAR(36) NOT NULL PRIMARY KEY,
  ownerId CHAR(36) NOT NULL,
  clientId VARCHAR(255) NOT NULL,
  approvalSessionId CHAR(36) NOT NULL,
  resource VARCHAR(512) NOT NULL,
  generation BIGINT UNSIGNED NOT NULL,
  revokedAt DATETIME(3) NULL,
  expiresAt DATETIME(3) NOT NULL,
  createdAt DATETIME(3) NOT NULL,
  INDEX mcp_grant_owner_page (ownerId, createdAt, id),
  INDEX mcp_grant_approval (ownerId, approvalSessionId)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE mcp_grant_token (
  tokenHash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY,
  grantId CHAR(36) NOT NULL,
  issuedGeneration BIGINT UNSIGNED NOT NULL,
  CONSTRAINT mcp_grant_token_grant FOREIGN KEY (grantId) REFERENCES mcp_grant(id) ON DELETE RESTRICT,
  INDEX mcp_grant_token_family (grantId)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
