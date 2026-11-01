ALTER TABLE `workspace`
  ADD COLUMN `archivedAt` datetime(3) NULL,
  ADD INDEX `workspace_owner_archive` (`createdByAccountId`, `archivedAt`, `id`);
