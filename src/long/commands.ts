import { readFile } from "node:fs/promises";
import { InputError } from "../domain/errors.js";
import { longSpecSchema, type LongSpec } from "./schemas.js";
import { normalizeExternalEvent } from "./normalize.js";
import { createLongStore, ingestLongBatch, loadLongStore } from "./store.js";
import { reduceLongSignals } from "./signals.js";
import { evaluateLongPolicy } from "./policy.js";

async function readJson(path: string): Promise<unknown> {
  try { return JSON.parse(await readFile(path, "utf8")) as unknown; }
  catch (error) { throw new InputError(`Could not read Long JSON ${path}`, { cause: error }); }
}
export async function readLongSpec(path: string): Promise<LongSpec> {
  try { return longSpecSchema.parse(await readJson(path)); }
  catch (error) { throw new InputError(`Invalid Long spec: ${error instanceof Error ? error.message : String(error)}`, { cause: error }); }
}

export async function createLongCommand(directory: string, spec: LongSpec) { return createLongStore(directory, spec); }

export async function ingestLongJsonlCommand(directory: string, inputPath: string, receivedAt = new Date()) {
  const raw = await readFile(inputPath, "utf8").catch((error) => { throw new InputError(`Could not read Long input ${inputPath}`, { cause: error }); });
  const loop = await loadLongStore(directory);
  const lines = raw.trim() === "" ? [] : raw.trimEnd().split("\n");
  if (lines.length > 256) throw new InputError("Long ingest batch exceeds 256 events");
  const drafts = lines.map((line, index) => {
    try { return normalizeExternalEvent(JSON.parse(line) as unknown, { spec: loop.spec, receivedAt }); }
    catch (error) { throw new InputError(`Invalid Long input event ${index + 1}`, { cause: error }); }
  });
  return ingestLongBatch(directory, drafts, { receivedAt });
}

export async function longStatusCommand(directory: string, evaluatedAt = new Date(), previousAlerts: readonly import("./schemas.js").LongAlert[] = []) {
  const store = await loadLongStore(directory);
  const signals = reduceLongSignals(store.spec, store.events.map((event) => event.payload), { evaluatedAt });
  const policy = evaluateLongPolicy(store.spec, signals, store.events.map((event) => event.payload), { alerts: previousAlerts }, evaluatedAt);
  return { store, signals, policy };
}

export function renderLongHuman(result: Awaited<ReturnType<typeof longStatusCommand>>): string {
  const { store, signals, policy } = result;
  return [
    `session ${store.spec.session_id}`,
    `events: ${store.snapshot.sequence}  activity: ${signals.activity}  progress: ${String(signals.progress_index)}`,
    `stall ${signals.stall_score.toFixed(2)}  failure ${signals.failure_score.toFixed(2)}  drift ${signals.drift_score.toFixed(2)}  budget ${signals.budget_risk.toFixed(2)}`,
    `alerts: ${policy.alerts.filter((alert) => alert.status === "open").length}`,
  ].join("\n") + "\n";
}
