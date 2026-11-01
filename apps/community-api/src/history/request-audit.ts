import type { AuditEntry } from "./model.js";
import { validId } from "../datasources/public.js";

const slot = "declaredBusinessAudit";
const contextSlot = "declaredAuditContext";
type ResponseContext = { locals: Record<string, unknown> };
type DeclaredAudit = {
  entry: Omit<AuditEntry, "outcome">;
  scope: { workspaceId: string; sourceId: string } | null;
  failureOnly: boolean;
};
type AuditTarget = {
  connectorId?: string;
  targetId?: string;
  workspaceId?: string;
  sourceId?: string;
};
type AuditContext = {
  identifiers: Pick<
    AuditEntry,
    "connectorId" | "targetId" | "attemptedWorkspaceId" | "attemptedSourceId"
  >;
  scope: DeclaredAudit["scope"];
};
function describeTarget(target: AuditTarget): AuditContext {
  const valid = (value: string | undefined): value is string =>
    value !== undefined && validId(value);
  return {
    identifiers: {
      ...(valid(target.connectorId) ? { connectorId: target.connectorId } : {}),
      ...(valid(target.targetId) ? { targetId: target.targetId } : {}),
      ...(valid(target.workspaceId) ? { attemptedWorkspaceId: target.workspaceId } : {}),
      ...(valid(target.sourceId) ? { attemptedSourceId: target.sourceId } : {}),
    },
    // A route parameter is an attempted target, never a verified foreign key.
    // Services with proven authority may still record an actual AuditScope.
    scope: null,
  };
}
/** Identifiers describe an attempt only; they never establish a database scope. */
export function auditTargetIdentifiers(target: AuditTarget): AuditContext["identifiers"] {
  return describeTarget(target).identifiers;
}
/** A declared router namespace supplies attempted UUIDs before its Origin
 * guard. This never declares a business action or proves object ownership. */
export function declareRequestAuditContext(response: ResponseContext, target: AuditTarget): void {
  const context = describeTarget(target);
  if (context.scope || Object.keys(context.identifiers).length)
    response.locals[contextSlot] = context;
}
export function requestAuditContext(response: ResponseContext): AuditContext | undefined {
  return response.locals[contextSlot] as AuditContext | undefined;
}
/** The matched business handler declares its event. Neither URLs nor request
 * bodies are used to infer an operation or retained as audit content. */
export function declareRequestAudit(
  response: ResponseContext,
  event: AuditEntry["event"],
  target: {
    connectorId?: string;
    targetId?: string;
    workspaceId?: string;
    sourceId?: string;
    failureOnly?: boolean;
  } = {},
): void {
  const context = describeTarget(target);
  response.locals[slot] = {
    entry: {
      event,
      ...context.identifiers,
    },
    scope: context.scope,
    failureOnly: target.failureOnly === true,
  };
}
export function declaredRequestAudit(response: ResponseContext): DeclaredAudit | undefined {
  return response.locals[slot] as DeclaredAudit | undefined;
}
