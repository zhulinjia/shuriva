export type Connector = { id: string; name: string; status: string };
export type Source = {
  id: string;
  name: string;
  connectorId: string;
  isDefault?: number | boolean;
  scanStatus?: string | null;
  errorCode?: string | null;
};
export type Scan = { status: string; errorCode: string | null } | null;

export const connectorStatus: Record<string, string> = {
  online: "在线",
  offline: "离线",
  incompatible: "版本不兼容",
  revoked: "已撤销",
};
