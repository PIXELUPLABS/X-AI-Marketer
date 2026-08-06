#!/usr/bin/env node
// Step A of the weekly run: pick unconsumed frames FIFO, export images, compute
// the week's slots, and emit state/runs/<run_id>/batch.json with captions null.
// Claude then QA-passes the images and writes captions into batch.json.
//
// Usage:
//   node scripts/prepare-week.mjs [--dry-run]      # start a new weekly batch
//   node scripts/prepare-week.mjs --reslot <run_id> # re-derive slot assignment
//                                                   # after Claude's QA skips
//
// --reslot exists so slot math NEVER lives in the LLM: Claude only marks
// qa: {skip: true, reason}, then this script reassigns surviving items to
// slots in FIFO order (buffer frames get promoted into vacated slots).

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import path from "node:path";
import { loadConfig, banner } from "../lib/config.mjs";
import { computeSlots, todayInZone } from "../lib/slots.mjs";
import { readJournal, consumedNodeIds } from "../lib/journal.mjs";
import { listCandidateFrames, exportFrames } from "../lib/figma.mjs";

function assignSlots(batch) {
  const survivors = batch.items.filter((i) => !i.qa?.skip);
  const skipped = batch.items.filter((i) => i.qa?.skip);
  survivors.forEach((item, idx) => {
    item.slot = idx < batch.slots.length ? batch.slots[idx] : null; // beyond 14 = buffer
  });
  for (const item of skipped) item.slot = null;
  const filled = survivors.filter((i) => i.slot).length;
  batch.shortfall =
    filled < batch.slots.length
      ? { filled, needed: batch.slots.length, empty_slots: batch.slots.slice(filled).map((s) => s.slot_iso) }
      : null;
  return batch;
}

function reportShortfall(batch) {
  if (!batch.shortfall) return;
  const { filled, needed, empty_slots } = batch.shortfall;
  console.error(`\n!!! SHORTFALL: only ${filled}/${needed} slots filled — the Figma file needs more cleared frames`);
  console.error(`!!! empty slots:\n!!!   ${empty_slots.join("\n!!!   ")}`);
}

async function prepare(cfg) {
  console.log(banner(cfg));

  const needed = cfg.posting.posts_per_day * cfg.posting.horizon_days;
  const consumed = consumedNodeIds(readJournal(cfg.abs.journal));
  const all = await listCandidateFrames(cfg);
  const candidates = all.filter((f) => !consumed.has(f.node_id)).slice(0, needed + cfg.posting.qa_buffer_frames);

  const today = todayInZone(cfg.posting.timezone);
  let runId = today;
  for (let n = 2; existsSync(path.join(cfg.abs.runs_dir, runId)); n++) runId = `${today}-${n}`;
  const runDir = path.join(cfg.abs.runs_dir, runId);
  const imagesDir = path.join(runDir, "images");
  mkdirSync(imagesDir, { recursive: true });

  const images = await exportFrames(cfg, candidates.map((c) => c.node_id), imagesDir);

  const batch = {
    run_id: runId,
    created_ts: new Date().toISOString(),
    dry_run: cfg.dryRun,
    dry_run_reason: cfg.dryRunReason,
    slots: computeSlots(today, cfg.posting),
    items: candidates.map((c) => ({
      node_id: c.node_id,
      name: c.name,
      image_file: images.get(c.node_id),
      qa: null, // Claude sets {skip: true, reason} on rejects
      archetype: null, // Claude: rejected_unused | plain_label | bts_process | opinion
      caption: null, // Claude writes; caption-lint.mjs enforces
      slot: null, // assigned below; null = buffer frame
      status: "pending",
    })),
  };
  assignSlots(batch);

  const batchPath = path.join(runDir, "batch.json");
  writeFileSync(batchPath, JSON.stringify(batch, null, 2) + "\n");

  console.log(`run ${runId}: ${candidates.length} candidates (${all.length} in file, ${consumed.size} consumed)`);
  console.log(`slots: ${batch.slots.length} | filled: ${batch.slots.length - (batch.shortfall?.empty_slots.length ?? 0)} | buffer: ${Math.max(0, candidates.length - needed)}`);
  console.log(`batch: ${batchPath}`);
  reportShortfall(batch);
}

function reslot(runId) {
  const cfg = loadConfig();
  const batchPath = path.join(cfg.abs.runs_dir, runId, "batch.json");
  if (!existsSync(batchPath)) {
    console.error(`no batch at ${batchPath}`);
    process.exit(2);
  }
  const batch = JSON.parse(readFileSync(batchPath, "utf8"));
  assignSlots(batch);
  writeFileSync(batchPath, JSON.stringify(batch, null, 2) + "\n");

  const skips = batch.items.filter((i) => i.qa?.skip);
  console.log(`reslotted ${runId}: ${skips.length} QA skip(s), ${batch.items.filter((i) => i.slot).length}/${batch.slots.length} slots filled`);
  for (const s of skips) console.log(`  skipped ${s.node_id} (${s.name}): ${s.qa.reason}`);
  reportShortfall(batch);
}

const args = process.argv.slice(2);
if (args[0] === "--reslot") {
  reslot(args[1]);
} else {
  await prepare(loadConfig({ dryRun: args.includes("--dry-run") }));
}
