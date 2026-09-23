import { writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { runScenario } from "./scenarios.mjs";

const [, , sourcePath, caseId, reportPath] = process.argv;
if (!sourcePath || !caseId || !reportPath) {
  throw new Error("usage: node check.mjs <source> <tenant|race|retry> <report.json>");
}
const { createLedger } = await import(pathToFileURL(sourcePath).href);
const report = await runScenario(createLedger, caseId);
await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
process.stdout.write(`${caseId.toUpperCase()} ${report.passed ? "PASS" : "FAIL"} ${JSON.stringify(report)}\n`);
if (!report.passed) process.exitCode = 1;
