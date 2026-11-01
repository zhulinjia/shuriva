export interface SignedMessage {
  connectorId: string;
  agentVersion: string;
  protocol: number;
  timestamp: number;
  nonce: string;
  signature: string;
}

export const signedMessageBodyFields = [
  "connectorId",
  "agentVersion",
  "nonce",
  "signature",
  "protocol",
  "timestamp",
] as const;
