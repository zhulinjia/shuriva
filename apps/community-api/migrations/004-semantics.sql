-- Explicit migration for the platform database; never applied automatically.
CREATE TABLE `semantic_model` (
  `workspaceId` varchar(36) NOT NULL,
  `sourceId` varchar(36) NOT NULL,
  `snapshotId` varchar(36) NOT NULL,
  `revision` int unsigned NOT NULL,
  `content` json NOT NULL,
  `updatedAt` datetime(3) NOT NULL,
  PRIMARY KEY (`workspaceId`, `sourceId`),
  CONSTRAINT `semantic_workspace_fk` FOREIGN KEY (`workspaceId`) REFERENCES `workspace` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `semantic_source_fk` FOREIGN KEY (`sourceId`) REFERENCES `data_source` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `semantic_snapshot_fk` FOREIGN KEY (`snapshotId`) REFERENCES `schema_snapshot` (`id`) ON DELETE RESTRICT
) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;
