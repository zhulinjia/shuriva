export class ConnectorError extends Error {
  constructor(
    readonly code: "INVALID" | "DENIED" | "NOT_FOUND" | "CAPACITY" | "INCOMPATIBLE" | "TASK_GONE",
  ) {
    super(code);
  }
}
