-- Explicit local history migration; never applied during startup.
CREATE TABLE `history_entry` (
  `id` varchar(36) NOT NULL,
  `sequence` bigint unsigned NOT NULL AUTO_INCREMENT,
  `ownerId` varchar(36) NOT NULL,
  `workspaceId` varchar(36) NULL,
  `sourceId` varchar(36) NULL,
  `kind` varchar(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `revision` int unsigned NOT NULL,
  `content` json NOT NULL,
  `deletedAt` datetime(3) NULL,
  `createdAt` datetime(3) NOT NULL,
  `updatedAt` datetime(3) NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `history_sequence` (`sequence`),
  KEY `history_scope` (`ownerId`,`workspaceId`,`sourceId`,`kind`,`deletedAt`,`sequence`),
  KEY `history_owner_kind` (`ownerId`,`kind`,`sequence`),
  KEY `history_workspace` (`workspaceId`),
  KEY `history_source` (`sourceId`),
  CONSTRAINT `history_owner_fk` FOREIGN KEY (`ownerId`) REFERENCES `user` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `history_workspace_fk` FOREIGN KEY (`workspaceId`) REFERENCES `workspace` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `history_source_fk` FOREIGN KEY (`sourceId`) REFERENCES `data_source` (`id`) ON DELETE RESTRICT
) ENGINE=InnoDB CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;
