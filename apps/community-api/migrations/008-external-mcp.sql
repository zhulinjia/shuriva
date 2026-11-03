CREATE TABLE external_mcp_owner (
 ownerId VARCHAR(36) NOT NULL PRIMARY KEY,
 CONSTRAINT external_mcp_owner_account FOREIGN KEY(ownerId) REFERENCES `user`(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
CREATE TABLE external_mcp_connection (
 id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY,
 ownerId VARCHAR(36) NOT NULL,
 workspaceId CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
 name VARCHAR(80) NOT NULL, config MEDIUMTEXT NOT NULL,
 executionHostId CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
 version INT NOT NULL, credentialRef CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
 disabled BOOLEAN NOT NULL DEFAULT FALSE,
 snapshot MEDIUMTEXT NOT NULL, snapshotHash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin,
 approvedTools TEXT NOT NULL, installationHash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin,
 createdAt DATETIME(3) NOT NULL, updatedAt DATETIME(3) NOT NULL,
 CONSTRAINT external_mcp_conn_owner FOREIGN KEY(ownerId) REFERENCES external_mcp_owner(ownerId) ON DELETE CASCADE,
 INDEX external_mcp_conn_workspace(ownerId,workspaceId,id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
CREATE TABLE external_mcp_call (
 id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY,
 ownerId VARCHAR(36) NOT NULL, connectionId CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
 version INT NOT NULL, tool VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
 toolHash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
 state VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
 sessionId VARCHAR(36) NOT NULL, bootId CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
 commitment CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
 slot CHAR(36) CHARACTER SET ascii COLLATE ascii_bin UNIQUE,
 acknowledged BOOLEAN NOT NULL DEFAULT FALSE,
 createdAt DATETIME(3) NOT NULL, updatedAt DATETIME(3) NOT NULL,
 CONSTRAINT external_mcp_call_connection FOREIGN KEY(connectionId) REFERENCES external_mcp_connection(id) ON DELETE CASCADE,
 INDEX external_mcp_call_owner(ownerId,createdAt), INDEX external_mcp_call_conn(connectionId,createdAt)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
CREATE TABLE external_mcp_schema_version (
 version INT NOT NULL PRIMARY KEY, checksum CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
 shapeHash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
CREATE TABLE external_mcp_runtime (
 id TINYINT NOT NULL PRIMARY KEY,
 bootId CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
CREATE TABLE external_mcp_secret_gc (
 ref CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY,
 connectionId CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
 ownerId VARCHAR(36) NOT NULL, executionHostId CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL, notBefore DATETIME(3) NOT NULL,
 INDEX external_mcp_gc_due(notBefore)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
