import { describe, expect, it } from "vitest";
import { decodeJsonBytes, parseJsonBytes } from "../src/io/json.js";

describe("JSON input decoding", () => {
  const document = { version: "1", value: "PowerShell-safe" };

  it.each([
    ["utf8", Buffer.from(JSON.stringify(document), "utf8")],
    ["utf8 BOM", Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(JSON.stringify(document), "utf8")])],
    ["utf16le BOM", Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(JSON.stringify(document), "utf16le")])],
    ["utf16be BOM", Buffer.concat([Buffer.from([0xfe, 0xff]), Buffer.from(JSON.stringify(document), "utf16le").swap16()])],
    ["utf16le without BOM", Buffer.from(JSON.stringify(document), "utf16le")],
  ])("parses %s JSON", (_name, bytes) => {
    expect(parseJsonBytes(bytes, "fixture.json")).toEqual(document);
  });

  it("strips a UTF-8 BOM before exposing text", () => {
    const bytes = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("{}")]);
    expect(decodeJsonBytes(bytes, "fixture.json")).toBe("{}");
  });

  it("reports the source and a repair hint for malformed JSON", () => {
    expect(() => parseJsonBytes(Buffer.from("{broken"), "bad.json")).toThrow(
      "Could not parse JSON from bad.json. Save it as UTF-8 or use --output.",
    );
  });
});
