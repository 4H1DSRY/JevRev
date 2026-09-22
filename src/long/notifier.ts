import { appendFile } from "node:fs/promises";
import type { LongAlert } from "./schemas.js";

export interface LongNotifier { notify(alerts: readonly LongAlert[]): Promise<void> }

export class NullNotifier implements LongNotifier {
  async notify(_alerts: readonly LongAlert[]): Promise<void> { }
}
export class FileNotifier implements LongNotifier {
  constructor(private readonly path: string) { }
  async notify(alerts: readonly LongAlert[]): Promise<void> {
    if (alerts.length === 0) return;
    await appendFile(this.path, `${alerts.map((alert) => JSON.stringify(alert)).join("\n")}\n`, "utf8");
  }
}

export interface FetchLike { (input: string | URL, init?: RequestInit): Promise<Response> }

export class WebhookNotifier implements LongNotifier {
  constructor(private readonly url: string, private readonly fetcher: FetchLike = globalThis.fetch) { }
  async notify(alerts: readonly LongAlert[]): Promise<void> {
    if (alerts.length === 0) return;
    const response = await this.fetcher(this.url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ alerts }) });
    if (!response.ok) throw new Error(`Long webhook returned HTTP ${response.status}`);
  }
}
