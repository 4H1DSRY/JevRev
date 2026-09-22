import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";

const root = resolve(import.meta.dirname, "..");
const fixtureRoot = resolve(root, "benchmarks", "one-shot-showcase");
const input = JSON.parse(await readFile(resolve(fixtureRoot, "input.json"), "utf8"));
const conditions = ["direct", "routed"];

function fail(message) {
  process.stderr.write(`one-shot showcase: ${message}\n`);
  process.exitCode = 1;
}

function visibleText(html) {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

for (const condition of conditions) {
  const path = resolve(fixtureRoot, condition, "index.html");
  const html = await readFile(path, "utf8");
  const text = visibleText(html);

  for (const [key, value] of Object.entries(input.shared_copy)) {
    if (!text.includes(value)) fail(`${condition} is missing shared_copy.${key}`);
  }

  for (const id of ["top", "workflow", "proof", "install"]) {
    if (!html.includes(`id="${id}"`)) fail(`${condition} is missing #${id}`);
  }

  for (const target of ["#top", "#workflow", "#proof", "#install"]) {
    if (!html.includes(`href="${target}"`)) fail(`${condition} is missing anchor link ${target}`);
  }

  if (condition === "routed" && !html.includes(input.available_asset)) {
    fail("routed does not use the available JevRev banner asset");
  }
  if (condition === "direct" && /<img\b/i.test(html)) {
    fail("direct should express its selected image-free direction without an image element");
  }
  if (/(?:src|href)=["'](?:https?:)?\/\//i.test(html)) fail(`${condition} has an external asset or link`);
  if (/[—–]/.test(text)) fail(`${condition} contains a visible em dash or en dash`);
  if (!html.includes("prefers-color-scheme:")) fail(`${condition} does not define a system color-scheme override`);
  if (!html.includes("prefers-reduced-motion: reduce")) fail(`${condition} does not define reduced motion`);
  if (!html.includes("navigator.clipboard.writeText")) fail(`${condition} does not implement command copy`);
  if (!html.includes('<meta name="viewport"')) fail(`${condition} is missing a viewport meta tag`);
}

const result = spawnSync(
  process.execPath,
  [
    resolve(root, "dist", "cli.js"),
    "sift",
    "--input",
    resolve(fixtureRoot, "sift-input.json"),
    "--replay",
    resolve(fixtureRoot, "sift-replay.json"),
    "--format",
    "json",
  ],
  { cwd: root, encoding: "utf8" },
);

if (result.status !== 0) {
  fail(`Sift replay failed: ${result.stderr.trim()}`);
} else {
  const campaign = JSON.parse(result.stdout);
  if (campaign.sift.selected.length !== 1 || campaign.sift.selected[0] !== "painterly-evidence-dossier") {
    fail("Sift replay did not select only painterly-evidence-dossier");
  }
  const resultsRoot = resolve(root, "benchmarks", "results", "one-shot-showcase");
  await mkdir(resultsRoot, { recursive: true });
  await writeFile(resolve(resultsRoot, "campaign.json"), `${JSON.stringify(campaign, null, 2)}\n`);
}

if (process.exitCode) process.exit(process.exitCode);
process.stdout.write(
  "One-shot showcase validated: frozen brief and copy, local-only assets, responsive modes, functional interactions, and deterministic JevRev route.\n",
);
