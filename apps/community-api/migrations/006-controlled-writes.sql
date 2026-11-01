-- Explicit metadata-only migration. Never applied during normal application startup.
CREATE TABLE `mutation_scope` (
  `ownerId` varchar(36) NOT NULL, `workspaceId` varchar(36) NOT NULL, `sourceId` varchar(36) NOT NULL,
  PRIMARY KEY (`ownerId`,`workspaceId`,`sourceId`)
) ENGINE=InnoDB CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;
CREATE TABLE `mutation_target` (
  `identity` varchar(256) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
  `frozen` tinyint unsigned NOT NULL,
  `code` varchar(48) CHARACTER SET ascii COLLATE ascii_bin NULL,
  PRIMARY KEY (`identity`)
) ENGINE=InnoDB CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;
CREATE TABLE `mutation_preview` (
  `id` varchar(36) NOT NULL, `ownerId` varchar(36) NOT NULL, `workspaceId` varchar(36) NOT NULL, `sourceId` varchar(36) NOT NULL,
  `connectorId` varchar(36) NOT NULL, `commitment` varchar(43) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `revision` int unsigned NOT NULL, `apiBoot` char(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `connectorBoot` char(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `targetIdentity` varchar(256) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
  `targetEpoch` char(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `policyGeneration` varchar(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `installationGeneration` varchar(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `operation` varchar(8) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `tableName` varchar(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
  `rowCount` int unsigned NOT NULL, `expiresAt` datetime(3) NOT NULL,
  `state` varchar(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `createdAt` datetime(3) NOT NULL,
  PRIMARY KEY (`id`), KEY `mutation_preview_scope` (`ownerId`,`workspaceId`,`sourceId`,`state`), KEY `mutation_preview_target` (`targetIdentity`)
) ENGINE=InnoDB CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;
CREATE TABLE `mutation_confirmation` (
  `id` varchar(36) NOT NULL, `previewId` varchar(36) NOT NULL,
  `ownerId` varchar(36) NOT NULL, `workspaceId` varchar(36) NOT NULL, `sourceId` varchar(36) NOT NULL,
  `commitment` varchar(43) CHARACTER SET ascii COLLATE ascii_bin NOT NULL, `revision` int unsigned NOT NULL,
  `state` varchar(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL, `executionId` varchar(36) NULL,
  PRIMARY KEY (`id`), UNIQUE KEY `mutation_confirmation_preview` (`previewId`)
) ENGINE=InnoDB CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;
CREATE TABLE `mutation_execution` (
  `id` varchar(36) NOT NULL, `sequence` bigint unsigned NOT NULL AUTO_INCREMENT, `confirmationId` varchar(36) NOT NULL, `previewId` varchar(36) NOT NULL,
  `sessionId` varchar(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `state` varchar(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `cancelRequested` tinyint unsigned NOT NULL, `code` varchar(48) CHARACTER SET ascii COLLATE ascii_bin NULL,
  `reconciliationExpiresAt` datetime(3) NULL,
  `affectedRows` int unsigned NULL,
  `createdAt` datetime(3) NOT NULL, `updatedAt` datetime(3) NOT NULL,
  PRIMARY KEY (`id`), UNIQUE KEY `mutation_execution_confirmation` (`confirmationId`), UNIQUE KEY `mutation_execution_preview` (`previewId`),
  UNIQUE KEY `mutation_execution_sequence` (`sequence`), KEY `mutation_execution_state` (`state`,`previewId`)
) ENGINE=InnoDB CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;
CREATE TABLE `mutation_permit` (
  `executionId` varchar(36) NOT NULL, `permitId` varchar(36) NOT NULL,
  `request` json NOT NULL, `signature` varchar(86) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  PRIMARY KEY (`executionId`), UNIQUE KEY `mutation_permit_id` (`permitId`)
) ENGINE=InnoDB CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;
CREATE TABLE `mutation_outbox` (
  `id` varchar(36) NOT NULL, `executionId` varchar(36) NOT NULL,
  `ownerId` varchar(36) NOT NULL, `workspaceId` varchar(36) NOT NULL, `sourceId` varchar(36) NOT NULL,
  `event` varchar(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `delivered` tinyint unsigned NOT NULL, `createdAt` datetime(3) NOT NULL,
  PRIMARY KEY (`id`), KEY `mutation_outbox_pending` (`delivered`,`createdAt`,`id`)
) ENGINE=InnoDB CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;
