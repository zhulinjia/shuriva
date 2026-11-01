CREATE TABLE `user` (
  `id` varchar(36) NOT NULL PRIMARY KEY,
  `name` varchar(100) NOT NULL,
  `email` varchar(255) NOT NULL UNIQUE,
  `emailVerified` boolean NOT NULL DEFAULT false,
  `image` text,
  `username` varchar(64) UNIQUE,
  `displayUsername` varchar(64),
  `createdAt` datetime(3) NOT NULL,
  `updatedAt` datetime(3) NOT NULL
) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;

CREATE TABLE `session` (
  `id` varchar(36) NOT NULL PRIMARY KEY,
  `expiresAt` datetime(3) NOT NULL,
  `token` varchar(255) CHARACTER SET ascii COLLATE ascii_bin NOT NULL UNIQUE,
  `createdAt` datetime(3) NOT NULL,
  `updatedAt` datetime(3) NOT NULL,
  `ipAddress` text,
  `userAgent` text,
  `userId` varchar(36) NOT NULL,
  INDEX `session_user_id` (`userId`),
  CONSTRAINT `session_user_fk` FOREIGN KEY (`userId`) REFERENCES `user` (`id`) ON DELETE CASCADE
) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;

CREATE TABLE `account` (
  `id` varchar(36) NOT NULL PRIMARY KEY,
  `accountId` varchar(255) NOT NULL,
  `providerId` varchar(100) NOT NULL,
  `userId` varchar(36) NOT NULL,
  `accessToken` text,
  `refreshToken` text,
  `idToken` text,
  `accessTokenExpiresAt` datetime(3),
  `refreshTokenExpiresAt` datetime(3),
  `scope` text,
  `password` text,
  `createdAt` datetime(3) NOT NULL,
  `updatedAt` datetime(3) NOT NULL,
  INDEX `account_user_id` (`userId`),
  UNIQUE KEY `account_provider_identity` (`providerId`, `accountId`),
  CONSTRAINT `account_user_fk` FOREIGN KEY (`userId`) REFERENCES `user` (`id`) ON DELETE CASCADE
) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;

CREATE TABLE `verification` (
  `id` varchar(36) NOT NULL PRIMARY KEY,
  `identifier` varchar(255) NOT NULL,
  `value` text NOT NULL,
  `expiresAt` datetime(3) NOT NULL,
  `createdAt` datetime(3) NOT NULL,
  `updatedAt` datetime(3) NOT NULL,
  INDEX `verification_identifier` (`identifier`)
) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;

CREATE TABLE `workspace` (
  `id` varchar(36) NOT NULL PRIMARY KEY,
  `name` varchar(120) NOT NULL,
  `description` text,
  `createdByAccountId` varchar(36) NOT NULL,
  `createdAt` datetime(3) NOT NULL,
  `updatedAt` datetime(3) NOT NULL,
  INDEX `workspace_owner` (`createdByAccountId`, `createdAt`),
  CONSTRAINT `workspace_owner_fk` FOREIGN KEY (`createdByAccountId`) REFERENCES `user` (`id`) ON DELETE RESTRICT
) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;
