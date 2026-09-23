import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createLedger as baseline } from "../benchmarks/engineering-showcase/baseline.mjs";
import { createLedger as repaired } from "../benchmarks/engineering-showcase/repaired.mjs";
import { runScenario } from "../benchmarks/engineering-showcase/scenarios.mjs";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const fixture = join(root, "benchmarks", "engineering-showcase");
const port = Number(process.env.JEVREV_ENGINEERING_PORT ?? 4178);
if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("invalid JEVREV_ENGINEERING_PORT");
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const sourceHashes = {
  baseline: digest(await readFile(join(fixture, "baseline.mjs"))),
  repaired: digest(await readFile(join(fixture, "repaired.mjs"))),
};
const capture = JSON.parse(await readFile(join(fixture, "capture", "trace.json"), "utf8"));
const send = (response, code, type, body) => {
  response.writeHead(code, { "content-type": type, "cache-control": "no-store", "x-content-type-options": "nosniff" });
  response.end(body);
};
const server = createServer(async (request, response) => {
  if (request.method !== "GET") return send(response, 405, "text/plain; charset=utf-8", "Method not allowed");
  const path = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
  try {
    if (path === "/api/replay") {
      const result = {};
      for (const [revision, factory] of [["baseline", baseline], ["repaired", repaired]]) {
        result[revision] = {};
        for (const id of ["tenant", "race", "retry"]) result[revision][id] = await runScenario(factory, id);
      }
      return send(response, 200, "application/json; charset=utf-8", JSON.stringify({
        source_sha256: sourceHashes, scenarios: result,
        audit: { outcomes: capture.rounds.map(({ outcome }) => outcome), loop_events: capture.loop_event_count, long_events: capture.long_event_count, tamper_rejected: capture.tampered_bridge_rejected, replay_deduplicated: capture.duplicate_bridge_suppressed },
      }));
    }
    if (path === "/" || path === "/workbench.js" || path === "/workbench.css") {
      const file = path === "/" ? "workbench.html" : path.slice(1);
      const type = file.endsWith(".js") ? "text/javascript; charset=utf-8" : file.endsWith(".css") ? "text/css; charset=utf-8" : "text/html; charset=utf-8";
      return send(response, 200, type, await readFile(join(fixture, file)));
    }
    return send(response, 404, "text/plain; charset=utf-8", "Not found");
  } catch (error) {
    return send(response, 500, "text/plain; charset=utf-8", error instanceof Error ? error.message : String(error));
  }
});
server.listen(port, "127.0.0.1", () => {
  const address = server.address();
  process.stdout.write(`Engineering workbench: http://127.0.0.1:${address.port}/\n`);
});
