-- Candidate migration: apply only to an explicitly selected isolated database.
-- Platform stores no datasource passwords or connection strings.
CREATE TABLE `data_source` (
  `id` varchar(36) NOT NULL PRIMARY KEY,
  `ownerId` varchar(36) NOT NULL,
  `connectorId` varchar(36) NOT NULL,
  `name` varchar(120) NOT NULL,
  `createdAt` datetime(3) NOT NULL,
  `updatedAt` datetime(3) NOT NULL,
  `archivedAt` datetime(3) NULL,
  INDEX `source_owner` (`ownerId`, `createdAt`),
  CONSTRAINT `source_owner_fk` FOREIGN KEY (`ownerId`) REFERENCES `user` (`id`) ON DELETE RESTRICT
) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;

CREATE TABLE `workspace_data_source` (
  `workspaceId` varchar(36) NOT NULL,
  `sourceId` varchar(36) NOT NULL,
  `boundAt` datetime(3) NOT NULL,
  PRIMARY KEY (`workspaceId`, `sourceId`),
  INDEX `binding_source` (`sourceId`),
  CONSTRAINT `binding_workspace_fk` FOREIGN KEY (`workspaceId`) REFERENCES `workspace` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `binding_source_fk` FOREIGN KEY (`sourceId`) REFERENCES `data_source` (`id`) ON DELETE RESTRICT
) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;

CREATE TABLE `workspace_default_source` (
  `workspaceId` varchar(36) NOT NULL PRIMARY KEY,
  `sourceId` varchar(36) NOT NULL,
  CONSTRAINT `default_source_binding_fk` FOREIGN KEY (`workspaceId`, `sourceId`)
    REFERENCES `workspace_data_source` (`workspaceId`, `sourceId`) ON DELETE CASCADE
) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;

CREATE TABLE `schema_scan` (
  `id` varchar(36) NOT NULL PRIMARY KEY,
  `sequence` bigint unsigned NOT NULL AUTO_INCREMENT,
  `ownerId` varchar(36) NOT NULL,
  `workspaceId` varchar(36) NOT NULL,
  `sourceId` varchar(36) NOT NULL,
  `connectorId` varchar(36) NOT NULL,
  `nonce` varchar(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `issuedAt` bigint NOT NULL,
  `expiresEpoch` bigint NOT NULL,
  `status` varchar(16) NOT NULL,
  `errorCode` varchar(32) NULL,
  `createdAt` datetime(3) NOT NULL,
  `expiresAt` datetime(3) NOT NULL,
  `finishedAt` datetime(3) NULL,
  INDEX `scan_workspace_source` (`workspaceId`, `sourceId`, `createdAt`),
  INDEX `scan_dispatch` (`connectorId`, `status`, `sequence`, `expiresAt`),
  UNIQUE KEY `scan_sequence` (`sequence`),
  CONSTRAINT `scan_owner_fk` FOREIGN KEY (`ownerId`) REFERENCES `user` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `scan_workspace_fk` FOREIGN KEY (`workspaceId`) REFERENCES `workspace` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `scan_source_fk` FOREIGN KEY (`sourceId`) REFERENCES `data_source` (`id`) ON DELETE RESTRICT
) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;

CREATE TABLE `schema_snapshot` (
  `id` varchar(36) NOT NULL PRIMARY KEY,
  `scanId` varchar(36) NOT NULL,
  `workspaceId` varchar(36) NOT NULL,
  `sourceId` varchar(36) NOT NULL,
  `contentHash` char(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `content` json NOT NULL,
  `createdAt` datetime(3) NOT NULL,
  UNIQUE KEY `snapshot_scan` (`scanId`),
  INDEX `snapshot_latest` (`workspaceId`, `sourceId`, `createdAt`),
  CONSTRAINT `snapshot_scan_fk` FOREIGN KEY (`scanId`) REFERENCES `schema_scan` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `snapshot_workspace_fk` FOREIGN KEY (`workspaceId`) REFERENCES `workspace` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `snapshot_source_fk` FOREIGN KEY (`sourceId`) REFERENCES `data_source` (`id`) ON DELETE RESTRICT
) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;
