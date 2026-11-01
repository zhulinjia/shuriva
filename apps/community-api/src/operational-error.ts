/** Fixed operator guidance only. Never construct these messages from external errors or configuration values. */
export const operationalMessages = {
  AUTH_CONFIG_REQUIRED: "DATABASE_URL, BETTER_AUTH_SECRET and APP_ORIGIN are required",
  AUTH_SESSION_CHECK_TIMEOUT: "会话核验超过两秒，已拒绝本次操作；请检查平台数据库和连接池",
  AUTH_SESSION_CHECK_CAPACITY: "会话核验等待已满，已拒绝本次操作；请检查平台数据库连接池",
  AUTH_CREDENTIAL_CAPACITY: "认证请求繁忙，请稍后重试；没有排队占用平台数据库连接",
  AUTH_REQUEST_CAPACITY: "认证请求读取已满，请稍后重试；没有占用平台数据库事务",
  AUTH_SESSION_REVOCATION_FAILED: "会话尚未撤销，退出失败；请重试或通过本机终端重设密码",
  AUTH_ADAPTER_NOT_READY: "认证事务尚未就绪，请检查平台初始化和数据库适配器",
  LOG_LEVEL_INVALID: "Invalid LOG_LEVEL: choose debug, info, warn or error",
  LOG_STDOUT_ONLY_INVALID: "Invalid LOG_STDOUT_ONLY: choose 0 or 1",
  LOG_LIMITS_INVALID:
    "Invalid logging limits: LOG_MAX_BYTES must be 1024–104857600 and LOG_MAX_FILES 1–30",
  LOG_DIR_INVALID: "LOG_DIR must be absolute",
  LOG_DIRECTORY_LINK: "Log directory and its ancestors cannot be symlinks",
  LOG_FILE_LINK: "Log files cannot be symlinks",
  MIGRATION_DATABASE_REQUIRED: "DATABASE_URL must be a MySQL database URL",
  MIGRATION_OPTION_INVALID:
    "Unknown migration option: use only --stage3, --stage6, --stage7 or --stage8",
  MIGRATION_SCHEMA_INVALID:
    "平台数据库结构或迁移记录与当前源码不符；请核查迁移，禁止自动修复或重置数据库",
  MIGRATION_LOCK_UNAVAILABLE:
    "Could not acquire migration lock; wait for the other migration process to finish",
  MIGRATION_NO_DATABASE: "No database selected; set an explicit platform database in DATABASE_URL",
  AUTH_SECRET_TOO_SHORT: "BETTER_AUTH_SECRET must contain at least 32 characters",
  DATABASE_URL_INVALID: "DATABASE_URL must be a valid MySQL database URL",
  DATABASE_TLS_INVALID: "DATABASE_URL tls must be required, or local for a loopback database only",
  APP_ORIGIN_INVALID: "APP_ORIGIN must be an HTTP(S) origin without a trailing slash",
  APP_ORIGIN_INSECURE: "APP_ORIGIN must use HTTPS except on localhost",
  API_HOST_INVALID: "API_HOST must be a loopback address until external deployment is hardened",
  API_PORT_INVALID: "API_PORT must be an integer between 1 and 65535",
  STAGE3_FLAG_INVALID: "ENABLE_STAGE3_DATASOURCES must be 0 or 1",
  STAGE4_FLAG_INVALID: "ENABLE_STAGE4_READS must be 0 or 1",
  STAGE4_DEPENDENCY: "ENABLE_STAGE4_READS requires ENABLE_STAGE3_DATASOURCES=1",
  STAGE6_FLAG_INVALID: "ENABLE_STAGE6_SEMANTICS must be 0 or 1",
  STAGE6_DEPENDENCY: "ENABLE_STAGE6_SEMANTICS requires ENABLE_STAGE4_READS=1",
  STAGE7_FLAG_INVALID: "ENABLE_STAGE7_HISTORY must be 0 or 1",
  STAGE7_DEPENDENCY: "ENABLE_STAGE7_HISTORY requires ENABLE_STAGE6_SEMANTICS=1",
  WRITES_NOT_ACCEPTED: "Controlled writes remain closed until stage 8 security acceptance",
  ADMIN_TERMINAL_REQUIRED: "管理员操作需要交互式终端",
  ADMIN_SETUP_LOCK_UNAVAILABLE: "无法取得初始化锁，请确认没有其他初始化进程后重试",
  ADMIN_ALREADY_EXISTS: "已有账号，不能重复初始化管理员",
  ADMIN_CANCELLED: "已取消管理员操作",
  ADMIN_PASSWORD_MISMATCH: "两次输入的密码不一致",
  ADMIN_PASSWORD_LENGTH: "密码长度须为 12 至 128 个字符",
  ADMIN_COUNT_INVALID: "只有存在且仅存在一个管理员时才能重设密码",
  ADMIN_CREDENTIAL_INVALID: "账号凭据状态异常，请检查专用平台数据库",
  ADMIN_PASSWORD_UPDATE_FAILED: "无法更新管理员凭据",
} as const;
export type OperationalErrorCode = keyof typeof operationalMessages;
export class OperationalError extends Error {
  constructor(readonly code: OperationalErrorCode) {
    super(operationalMessages[code]);
    this.name = "OperationalError";
  }
}
