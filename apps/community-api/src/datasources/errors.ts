export class DataSourceError extends Error {
  constructor(readonly code: "INVALID" | "NOT_FOUND" | "CONFLICT") {
    super(code);
  }
}
