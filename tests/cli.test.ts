import { spawnSync } from "node:child_process";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "..");
const tsx = resolve(root, "node_modules", "tsx", "dist", "cli.mjs");
const cli = resolve(root, "src", "cli.ts");
const request = resolve(root, "examples", "parser-speedup.json");
const replay = resolve(root, "examples", "parser-jev-response.json");

function run(args: string[], stdin?: string, env = process.env) {
  return spawnSync(process.execPath, [tsx, cli, ...args], {
    cwd: root,
    encoding: "utf8",
    env,
    ...(stdin === undefined ? {} : { input: stdin }),
  });
}

describe("jevrev CLI", () => {
  it("runs the parser demonstration in JSON mode", () => {
    const result = run([
      "rank",
      "--input",
      request,
      "--replay",
      replay,
      "--format",
      "json",
    ]);

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    const output = JSON.parse(result.stdout) as {
      selected: string[];
      policy: { provider_profile: string };
    };
    expect(output.selected).toEqual(["allocation-cut", "byte-fast-path"]);
    expect(output.policy.provider_profile).toBe("replay");
  });

  it("keeps replay mode independent from provider configuration", () => {
    const result = run([
      "rank",
      "--input",
      request,
      "--replay",
      replay,
      "--provider",
      "local",
      "--local-url",
      "not-a-url",
      "--format",
      "json",
    ]);

    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout).selected).toEqual([
      "allocation-cut",
      "byte-fast-path",
    ]);
  });

  it("accepts the rank request from stdin", () => {
    const result = run(
      ["rank", "--input", "-", "--replay", replay, "--format", "json"],
      readFileSync(request, "utf8"),
    );

    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      summary: { evaluated: 7, kept: 2, shortlisted: 2, rejected: 5 },
    });
  });

  it("rejects replay against a differently ordered request", () => {
    const reorderedRequest = resolve(root, "tests", "tmp-reordered-request.json");
    const parsed = JSON.parse(readFileSync(request, "utf8")) as {
      candidates: unknown[];
    };
    parsed.candidates.reverse();
    writeFileSync(reorderedRequest, `${JSON.stringify(parsed)}\n`, "utf8");

    try {
      const result = run([
        "rank",
        "--input",
        reorderedRequest,
        "--replay",
        replay,
      ]);

      expect(result.status).toBe(4);
      expect(result.stderr).toContain("candidate_order");
    } finally {
      rmSync(reorderedRequest, { force: true });
    }
  });

  it("uses the documented invalid-input exit code", () => {
    const result = run(["rank", "--input", "-", "--replay", replay], "{}");

    expect(result.status).toBe(2);
    expect(result.stderr).toContain("Invalid rank request");
    expect(result.stdout).toBe("");
  });

  it("honors a survivor-budget override", () => {
    const result = run([
      "rank",
      "--input",
      request,
      "--replay",
      replay,
      "--format",
      "json",
      "--top",
      "1",
    ]);

    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout).selected).toEqual(["allocation-cut"]);
  });

  it("reports a missing live API key as a provider failure", () => {
    const env = { ...process.env };
    delete env.TYPESAFE_API_KEY;
    delete env.JEVREV_JEV_API_KEY;
    const result = run(["rank", "--input", request], undefined, env);

    expect(result.status).toBe(3);
    expect(result.stderr).toContain("provider error");
  });

  it("rejects an unknown provider", () => {
    const result = run([
      "rank",
      "--input",
      request,
      "--replay",
      replay,
      "--provider",
      "unknown",
    ]);

    expect(result.status).toBe(2);
    expect(result.stderr).toContain("must be jev, semif, or local");
  });

  it("supports the primary run command with JSON as its default format", () => {
    const result = run([
      "run",
      "--input",
      request,
      "--replay",
      replay,
    ]);

    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      run_id: expect.stringMatching(/^jvr_/),
      selected: ["allocation-cut", "byte-fast-path"],
    });
  });

  it("prints the configured Jev input address", () => {
    const result = run(["doctor", "--format", "json"]);

    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      endpoints: {
        jev: {
          request_url: "https://api.typesafe.ai/v1/systemone",
        },
      },
    });
  });

  it("normalizes local provider URLs that already include /v1", () => {
    const result = run([
      "doctor",
      "--format",
      "json",
      "--semif-url",
      "http://localhost:4878/v1/",
      "--local-url",
      "http://localhost:4877/v1",
    ]);

    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      endpoints: {
        semif: {
          request_url: "http://localhost:4878/v1/chat/completions",
        },
        local: {
          request_url: "http://localhost:4877/v1/score",
        },
      },
    });
  });

  it("rejects malformed doctor endpoint overrides", () => {
    const result = run(["doctor", "--semif-url", "not-a-url"]);

    expect(result.status).toBe(2);
    expect(result.stderr).toContain("Invalid SemIf URL");
  });

  it("accepts the JevRev API key environment name", () => {
    const env = { ...process.env, JEVREV_JEV_API_KEY: "test-key" };
    delete env.TYPESAFE_API_KEY;
    const result = run(
      ["run", "--input", request, "--jev-url", "not-a-url"],
      undefined,
      env,
    );

    expect(result.status).toBe(3);
    expect(result.stderr).toContain("provider error");
  });

  it("writes a JSON handoff to --output without contaminating stdout", () => {
    const output = resolve(root, "tests", "tmp-result.json");
    const result = run([
      "run",
      "--input",
      request,
      "--replay",
      replay,
      "--output",
      output,
    ]);

    try {
      expect(result.status).toBe(0);
      expect(result.stdout).toBe("");
      expect(JSON.parse(readFileSync(output, "utf8"))).toMatchObject({
        run_id: expect.stringMatching(/^jvr_/),
      });
    } finally {
      rmSync(output, { force: true });
    }
  });

  it("reports an invalid local scorer URL as a provider failure", () => {
    const result = run([
      "rank",
      "--input",
      request,
      "--provider",
      "local",
      "--local-url",
      "not-a-url",
    ]);

    expect(result.status).toBe(3);
    expect(result.stderr).toContain("Invalid local scorer URL");
  });

  it("reads the default local scorer URL from the environment", () => {
    const result = run(
      ["rank", "--input", request, "--provider", "local"],
      undefined,
      { ...process.env, SPECJEV_LOCAL_URL: "from-environment" },
    );

    expect(result.status).toBe(3);
    expect(result.stderr).toContain("Invalid local scorer URL: from-environment");
  });

  it("accepts a SemIf URL override", () => {
    const result = run([
      "rank",
      "--input",
      request,
      "--provider",
      "semif",
      "--semif-url",
      "not-a-url",
    ]);

    expect(result.status).toBe(3);
    expect(result.stderr).toContain("Invalid SemIf server URL");
  });

  it("reports a missing input file as invalid input", () => {
    const result = run([
      "rank",
      "--input",
      resolve(root, "examples", "does-not-exist.json"),
      "--replay",
      replay,
    ]);

    expect(result.status).toBe(2);
    expect(result.stderr).toContain("Could not read");
  });

  it("returns exit code 2 for Commander usage errors", () => {
    const result = run(["run"]);

    expect(result.status).toBe(2);
    expect(result.stderr).toContain("required option");
  });
});
