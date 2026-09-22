import { randomUUID } from "node:crypto";
import { rename, unlink, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { InputError, ProtocolError } from "../domain/errors.js";
import {
  evidenceBundleSchema,
  type EvidenceBundle,
  type EvidencePacket,
} from "../workflow/schemas.js";
import { readJsonFile } from "../io/json.js";
import { formatZodError } from "../io/validation.js";

export async function readEvidenceBundle(pathInput: string): Promise<{
  path: string;
  bundle: EvidenceBundle;
}> {
  const path = resolve(pathInput);
  const raw = await readJsonFile(path);
  const parsed = evidenceBundleSchema.safeParse(raw);
  if (!parsed.success) {
    throw new InputError(`Invalid evidence bundle: ${formatZodError(parsed.error)}`);
  }
  return { path, bundle: parsed.data };
}

export async function writeEvidenceBundle(path: string, value: EvidenceBundle): Promise<void> {
  const validated = evidenceBundleSchema.parse(value);
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(validated, null, 2)}\n`, "utf8");
    await rename(temporary, path);
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw new InputError(`Could not update evidence bundle: ${path}`, { cause: error });
  }
}

export function evidencePacket(bundle: EvidenceBundle, candidateId: string): EvidencePacket {
  const packet = bundle.packets.find((item) => item.candidate_id === candidateId);
  if (packet === undefined) throw new ProtocolError(`Unknown evidence candidate: ${candidateId}`);
  return packet;
}

export function appendUnique(values: string[], value: string): void {
  if (!values.includes(value)) values.push(value);
}
