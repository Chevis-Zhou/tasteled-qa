/**
 * Two severities, nothing in between. `fail` blocks a launch; `warn` is worth a look but
 * never blocks on its own (unless the caller runs with `--strict`).
 */
export type Severity = "fail" | "warn";

export interface CheckFinding {
  severity: Severity;
  check: string;
  message: string;
  url?: string;
  selector?: string;
  expected?: string;
  actual?: string;
}

export interface CheckResult {
  check: string;
  ok: boolean;
  findings: CheckFinding[];
  /** Evidence that never gates anything — screenshot paths, recorded scores. */
  evidence?: Record<string, unknown>;
}

export interface QAResult {
  target: string;
  pages: string[];
  ranAt: string;
  results: CheckResult[];
}

export function failures(result: QAResult): CheckFinding[] {
  return result.results.flatMap((r) => r.findings.filter((f) => f.severity === "fail"));
}

export function warnings(result: QAResult): CheckFinding[] {
  return result.results.flatMap((r) => r.findings.filter((f) => f.severity === "warn"));
}

export type Verdict = "FAIL" | "WARN" | "PASS";

export function verdictOf(result: QAResult): Verdict {
  if (failures(result).length > 0) return "FAIL";
  if (warnings(result).length > 0) return "WARN";
  return "PASS";
}
