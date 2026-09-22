import { ZodError } from "zod";

function pathLabel(path: readonly PropertyKey[]): string {
  if (path.length === 0) return "input";
  let label = "";
  for (const part of path) {
    if (typeof part === "number") label += `[${part}]`;
    else label += label.length === 0 ? part.toString() : `.${part.toString()}`;
  }
  return label;
}

/** Keep CLI validation errors useful without dumping Zod's internal object. */
export function formatZodError(error: ZodError, maxIssues = 6): string {
  const issues = error.issues.slice(0, maxIssues).map((issue) => `${pathLabel(issue.path)}: ${issue.message}`);
  const remaining = error.issues.length - issues.length;
  return `${issues.join("; ")}${remaining > 0 ? `; and ${remaining} more issue(s)` : ""}`;
}
