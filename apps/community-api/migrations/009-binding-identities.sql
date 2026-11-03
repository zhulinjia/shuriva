-- Explicit feature migration. It never alters or deletes existing binding or preview rows.
CREATE TABLE `source_binding_identity` (
  `workspaceId` varchar(36) NOT NULL,
  `sourceId` varchar(36) NOT NULL,
  `generation` char(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  PRIMARY KEY (`workspaceId`,`sourceId`),
  UNIQUE KEY `source_binding_generation` (`generation`),
  CONSTRAINT `source_binding_identity_fk` FOREIGN KEY (`workspaceId`,`sourceId`)
    REFERENCES `workspace_data_source` (`workspaceId`,`sourceId`) ON DELETE CASCADE
) ENGINE=InnoDB CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;
CREATE TABLE `mutation_preview_binding` (
  `previewId` varchar(36) NOT NULL,
  `generation` char(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  PRIMARY KEY (`previewId`),
  CONSTRAINT `mutation_preview_binding_fk` FOREIGN KEY (`previewId`)
    REFERENCES `mutation_preview` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;
CREATE TABLE `binding_identity_schema` (
  `version` int unsigned NOT NULL,
  `checksum` char(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  PRIMARY KEY (`version`)
) ENGINE=InnoDB CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;
