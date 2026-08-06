// Load config.json + .env, validate, and decide dry-run ONCE.
// Every script and adapter consumes cfg from here; nobody re-reads env.

import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function loadDotEnv() {
  const envPath = path.join(ROOT, ".env");
  if (!existsSync(envPath)) return;
  for (const line of readFileSync(envPath, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2];
  }
}

const isTodo = (v) => v == null || v === "" || v === "TODO";

/**
 * @param {{dryRun?: boolean}} opts  pass {dryRun:true} for an explicit --dry-run flag
 */
export function loadConfig(opts = {}) {
  loadDotEnv();
  const cfg = JSON.parse(readFileSync(path.join(ROOT, "config.json"), "utf8"));

  // Minimal shape validation — fail loud and early on a broken config.
  for (const key of ["account", "typefully", "figma", "posting", "cta", "paths"]) {
    if (!cfg[key]) throw new Error(`config.json missing "${key}" section`);
  }
  const p = cfg.posting;
  if (p.slots_local.length !== p.posts_per_day) {
    throw new Error(`config: slots_local has ${p.slots_local.length} entries but posts_per_day is ${p.posts_per_day}`);
  }
  if (p.slot_labels.length !== p.slots_local.length) {
    throw new Error("config: slot_labels must match slots_local in length");
  }
  for (const t of p.slots_local) {
    if (!/^\d{2}:\d{2}$/.test(t)) throw new Error(`config: bad slot time "${t}" (want HH:MM)`);
  }
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: p.timezone });
  } catch {
    throw new Error(`config: unknown timezone "${p.timezone}" (want an IANA name like America/Los_Angeles)`);
  }
  if (!["planned", "scheduled"].includes(cfg.typefully.draft_mode)) {
    throw new Error(`config: typefully.draft_mode must be "planned" or "scheduled", got "${cfg.typefully.draft_mode}"`);
  }

  // Dry-run decision, made exactly once.
  const missing = [];
  if (isTodo(process.env.FIGMA_PAT)) missing.push("FIGMA_PAT");
  if (isTodo(cfg.figma.file_key)) missing.push("figma.file_key");
  if (isTodo(process.env.TYPEFULLY_API_KEY)) missing.push("TYPEFULLY_API_KEY");
  if (isTodo(cfg.typefully.social_set_id)) missing.push("typefully.social_set_id");

  cfg.dryRun = Boolean(opts.dryRun) || missing.length > 0;
  cfg.dryRunReason = opts.dryRun ? "--dry-run flag" : missing.length ? `missing: ${missing.join(", ")}` : null;
  cfg.env = {
    FIGMA_PAT: process.env.FIGMA_PAT || null,
    TYPEFULLY_API_KEY: process.env.TYPEFULLY_API_KEY || null,
  };

  // Absolute paths so scripts work from any cwd.
  cfg.abs = {};
  for (const [k, v] of Object.entries(cfg.paths)) cfg.abs[k] = path.join(ROOT, v);

  return cfg;
}

export function banner(cfg) {
  if (!cfg.dryRun) return "=== LIVE RUN — drafts will be created in Typefully ===";
  return `=== DRY RUN (${cfg.dryRunReason}) — nothing will reach Figma or Typefully ===`;
}
