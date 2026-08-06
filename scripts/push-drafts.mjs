#!/usr/bin/env node
// Step E of the weekly run: for each slotted, captioned, QA-passed item —
// upload media, create the Typefully draft (planned = inert until Arjun
// confirms in the app), journal it, and render report.md.
//
// Crash-safe: batch.json is saved and the journal appended after EACH item,
// and items that already carry a typefully_draft_id are skipped — so a retry
// after a mid-batch failure never double-posts.
//
// Usage:
//   node scripts/push-drafts.mjs state/runs/<run_id>/batch.json [--dry-run]
//   node scripts/push-drafts.mjs --check       # verify key + list social sets
//
// A batch prepared in dry-run mode is ALWAYS pushed dry (its images are
// fixtures — they must never reach Typefully).

import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { loadConfig, banner } from "../lib/config.mjs";
import { buildCtaTweet, buildCtaUrl } from "../lib/slots.mjs";
import { appendJournal } from "../lib/journal.mjs";
import { TypefullyClient } from "../lib/typefully.mjs";

const args = process.argv.slice(2);

if (args[0] === "--check") {
  const cfg = loadConfig();
  // --check exists to verify the key BEFORE the rest of the config is filled in,
  // so it goes live whenever the key itself is present — unlike the pipeline.
  cfg.dryRun = !cfg.env.TYPEFULLY_API_KEY;
  console.log(cfg.dryRun ? "no TYPEFULLY_API_KEY — cannot check" : "checking live Typefully API...");
  const client = new TypefullyClient(cfg, "check");
  const sets = await client.getSocialSets();
  console.log("social sets:", JSON.stringify(sets.results ?? sets, null, 2));
  console.log(`config social_set_id: ${cfg.typefully.social_set_id}`);
  process.exit(0);
}

const batchPath = args[0];
if (!batchPath) {
  console.error("usage: push-drafts.mjs <batch.json> [--dry-run] | --check");
  process.exit(2);
}

const batch = JSON.parse(readFileSync(batchPath, "utf8"));
const cfg = loadConfig({ dryRun: args.includes("--dry-run") || batch.dry_run });
if (batch.dry_run && !args.includes("--dry-run")) {
  console.error("note: batch was PREPARED dry-run (fixture images) — forcing dry push");
}
console.log(banner(cfg));

const client = new TypefullyClient(cfg, batch.run_id);
const saveBatch = () => writeFileSync(batchPath, JSON.stringify(batch, null, 2) + "\n");
const ts = () => new Date().toISOString();

let pushed = 0;
let errors = 0;

for (const item of batch.items) {
  // Journal QA skips exactly once, so rejected frames stop being re-offered.
  if (item.qa?.skip && !item.journaled) {
    appendJournal(cfg.abs.journal, {
      ts: ts(),
      run_id: batch.run_id,
      node_id: item.node_id,
      status: "skipped_qa",
      dry_run: cfg.dryRun,
      skip_reason: item.qa.reason ?? null,
      caption: null,
    });
    item.status = "skipped_qa";
    item.journaled = true;
    saveBatch();
    continue;
  }
  if (!item.slot || item.qa?.skip) continue; // buffer frame or already-journaled skip
  if (item.typefully_draft_id) continue; // retry-safe: already pushed

  try {
    if (!item.caption) throw new Error("caption is empty — run the caption pass + lint first");

    const { media_id } = await client.uploadMedia(item.image_file);
    const { id, outbox_file } = await client.createDraft({
      posts: [
        { text: item.caption, media_ids: [media_id] },
        { text: buildCtaTweet(cfg.cta) },
      ],
      slotIso: item.slot.slot_iso,
    });

    item.media_id = media_id;
    item.typefully_draft_id = id;
    if (outbox_file) item.outbox_file = outbox_file;
    item.status = "planned";
    item.journaled = true;
    saveBatch();

    appendJournal(cfg.abs.journal, {
      ts: ts(),
      run_id: batch.run_id,
      node_id: item.node_id,
      status: "planned",
      dry_run: cfg.dryRun,
      slot_iso: item.slot.slot_iso,
      slot_slug: item.slot.slot_slug,
      archetype: item.archetype,
      caption: item.caption,
      utm_content: cfg.cta.utm.utm_content ?? null,
      typefully_draft_id: id,
      media_id,
      image_file: path.basename(item.image_file),
      skip_reason: null,
    });
    pushed++;
    console.log(`planned ${item.slot.slot_slug} <- "${item.caption}" (${id})`);
  } catch (err) {
    item.status = "error";
    item.error = String(err.message ?? err);
    saveBatch();
    errors++;
    console.error(`ERROR ${item.slot.slot_slug} (${item.node_id}): ${item.error}`);
  }
}

// --- report.md ---

const lines = [];
lines.push(`# Worksnap run ${batch.run_id} — ${cfg.dryRun ? "DRY RUN" : "LIVE"}`);
lines.push("");
if (batch.shortfall) {
  lines.push(`## SHORTFALL — ${batch.shortfall.needed - batch.shortfall.filled} empty slot(s)`);
  lines.push("");
  lines.push("The dedicated Figma file needs more cleared frames. Empty slots:");
  for (const s of batch.shortfall.empty_slots) lines.push(`- ${s}`);
  lines.push("");
}
if (errors) {
  lines.push(`## ${errors} ERROR(S) — see items below, rerun this script to retry`);
  lines.push("");
}
lines.push(`| slot | frame | archetype | caption | status | draft |`);
lines.push(`| --- | --- | --- | --- | --- | --- |`);
for (const item of batch.items.filter((i) => i.slot)) {
  lines.push(
    `| ${item.slot.slot_slug} | ${item.name} | ${item.archetype ?? ""} | ${item.caption ?? ""} | ${item.status} | ${item.typefully_draft_id ?? ""} |`,
  );
}
lines.push("");
const skips = batch.items.filter((i) => i.qa?.skip);
if (skips.length) {
  lines.push(`## QA skips (pull these from the Figma file)`);
  for (const s of skips) lines.push(`- ${s.name} (${s.node_id}): ${s.qa.reason}`);
  lines.push("");
}
const sample = batch.items.find((i) => i.slot);
if (sample) {
  lines.push(`CTA URL shape: ${buildCtaUrl(cfg.cta)}`);
  lines.push("");
}
lines.push(
  cfg.dryRun
    ? `Would-be payloads: ${path.join(cfg.paths.outbox_dir, batch.run_id)}/`
    : `Next: review + confirm the ${pushed} planned draft(s) in Typefully.`,
);

const reportPath = path.join(path.dirname(batchPath), "report.md");
writeFileSync(reportPath, lines.join("\n") + "\n");

console.log(`\n${pushed} pushed, ${skips.length} qa-skipped, ${errors} error(s)`);
console.log(`report: ${reportPath}`);
process.exit(errors ? 1 : 0);
