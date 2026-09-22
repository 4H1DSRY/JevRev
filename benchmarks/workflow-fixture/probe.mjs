import { performance } from "node:perf_hooks";

const candidateName = process.argv[2];
const mode = process.argv[3];
const modules = {
  "regex-shortcut": "./regex-shortcut.mjs",
  "indexed-state-machine": "./indexed-state-machine.mjs",
};
const modulePath = modules[candidateName];
if (modulePath === undefined || !["correctness", "benchmark"].includes(mode)) {
  process.stderr.write("usage: node probe.mjs <regex-shortcut|indexed-state-machine> <correctness|benchmark>\n");
  process.exitCode = 2;
} else {
  const [{ countDelimiters }, { countDelimiters: baseline }] = await Promise.all([
    import(modulePath),
    import("./baseline.mjs"),
  ]);

  if (mode === "correctness") {
    const cases = [
      "alpha,beta,gamma",
      "alpha,\"beta,gamma\",delta",
      "\"alpha,beta\",\"gamma,delta\"",
      "alpha,\"escaped \"\" quote, comma\",omega",
      "no-delimiter",
    ];
    const failures = cases.flatMap((input) => {
      const expected = baseline(input);
      const actual = countDelimiters(input);
      return actual === expected ? [] : [{ input, expected, actual }];
    });
    process.stdout.write(`${JSON.stringify({ candidate: candidateName, cases: cases.length, failures })}\n`);
    if (failures.length > 0) process.exitCode = 1;
  } else {
    const input = 'alpha,beta,"gamma,delta",epsilon,"escaped "" quote, comma"\n'.repeat(1_500);
    const iterations = 35;
    const measure = (fn) => {
      let checksum = 0;
      const started = performance.now();
      for (let iteration = 0; iteration < iterations; iteration += 1) checksum += fn(input);
      const durationMs = performance.now() - started;
      if (checksum === 0) throw new Error("benchmark checksum was zero");
      return iterations / (durationMs / 1_000);
    };
    for (let warmup = 0; warmup < 5; warmup += 1) {
      baseline(input);
      countDelimiters(input);
    }
    const baselineSamples = [];
    const candidateSamples = [];
    for (let sample = 0; sample < 7; sample += 1) {
      if (sample % 2 === 0) {
        baselineSamples.push(measure(baseline));
        candidateSamples.push(measure(countDelimiters));
      } else {
        candidateSamples.push(measure(countDelimiters));
        baselineSamples.push(measure(baseline));
      }
    }
    process.stdout.write(`${JSON.stringify({
      candidate: candidateName,
      unit: "runs/s",
      direction: "higher",
      baseline_samples: baselineSamples,
      candidate_samples: candidateSamples,
    })}\n`);
  }
}
