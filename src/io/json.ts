import { readFile } from "node:fs/promises";
import { InputError } from "../domain/errors.js";

/**
 * Decode JSON files produced by common Windows shells as well as UTF-8 tools.
 * PowerShell 5.1's `>` writes UTF-16LE by default; treating that file as UTF-8
 * leaves NUL bytes in the JSON and produces a misleading parse error.
 */
export function decodeJsonBytes(bytes: Uint8Array, source: string): string {
  const buffer = Buffer.from(bytes);
  if (buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) {
    return buffer.subarray(3).toString("utf8");
  }
  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) {
    return buffer.subarray(2).toString("utf16le");
  }
  if (buffer.length >= 2 && buffer[0] === 0xfe && buffer[1] === 0xff) {
    return Buffer.from(buffer.subarray(2)).swap16().toString("utf16le");
  }
  // Some Windows writers omit the BOM. JSON is ASCII-heavy, so a strong NUL
  // pattern is enough to distinguish UTF-16 from ordinary UTF-8 safely.
  if (buffer.length >= 4 && buffer.length % 2 === 0) {
    let oddNuls = 0;
    let evenNuls = 0;
    for (let index = 0; index < buffer.length; index += 2) {
      if (buffer[index] === 0) evenNuls += 1;
      if (buffer[index + 1] === 0) oddNuls += 1;
    }
    const pairs = buffer.length / 2;
    if (oddNuls / pairs > 0.35) return buffer.toString("utf16le");
    if (evenNuls / pairs > 0.35) return Buffer.from(buffer).swap16().toString("utf16le");
  }
  return buffer.toString("utf8");
}

export function parseJsonBytes(bytes: Uint8Array, source: string): unknown {
  const content = decodeJsonBytes(bytes, source);
  try {
    return JSON.parse(content) as unknown;
  } catch (error) {
    throw new InputError(`Could not parse JSON from ${source}. Save it as UTF-8 or use --output.`, { cause: error });
  }
}

export async function readJsonFile(path: string): Promise<unknown> {
  let bytes: Buffer;
  try {
    bytes = await readFile(path);
  } catch (error) {
    throw new InputError(`Could not read ${path}`, { cause: error });
  }
  return parseJsonBytes(bytes, path);
}
