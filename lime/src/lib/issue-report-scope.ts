export type IssueReportScopeKind = "failed" | "needs_review";

export interface IssueReportScope {
  kind: IssueReportScopeKind;
  key: string;
}

export function resolveIssueReportScope(
  kind: string | null,
  key: string | null
): IssueReportScope | null | undefined {
  if (kind == null && key == null) {
    return undefined;
  }

  if ((kind !== "failed" && kind !== "needs_review") || !key) {
    return null;
  }

  return { kind, key };
}

export function getFirstSearchParam(
  value: string | string[] | undefined
): string | null {
  if (typeof value === "string") {
    return value;
  }

  if (Array.isArray(value)) {
    return value[0] ?? null;
  }

  return null;
}

export function buildIssueReportScopeQuery(
  scope: IssueReportScope,
  extraParams?: Record<string, string>
): string {
  const params = new URLSearchParams(extraParams);
  params.set("kind", scope.kind);
  params.set("key", scope.key);
  return params.toString();
}
