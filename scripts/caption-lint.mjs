#!/usr/bin/env node
// Deterministic backstop on LLM-written captions — the 8 rules from voice/persona.md.
// Rules 1–6, 8 are hard rejects. Rule 7 (leading capital) is a WARNING that requires
// Claude to confirm the word is a proper noun.
//
// Usage:
//   node scripts/caption-lint.mjs state/runs/<run_id>/batch.json   # lint a batch
//   node scripts/caption-lint.mjs --caption "some caption"         # lint one string
//
// Exit code: 0 = no hard failures (warnings allowed), 1 = at least one hard failure.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { loadConfig } from "../lib/config.mjs";
import { readJournal, captionHistory, closestCaption } from "../lib/journal.mjs";

const BANNED_PHRASES = [
  "excited to share",
  "thrilled",
  "check out",
  "dm me",
  "let me know what you think",
  "swipe",
  "dropping soon",
  // Arjun 2026-08-06: reads immature — name the industry instead ("a sales tech client")
  "ai startup",
  "ai company",
];

const SIMILARITY_THRESHOLD = 0.85;

/**
 * @param {string} caption
 * @param {string[]} history captions this one must not repeat (journal + earlier batch items)
 * @returns {{failures: string[], warnings: string[]}}
 */
export function lintCaption(caption, history) {
  const failures = [];
  const warnings = [];
  const text = caption ?? "";
  const words = text.trim().split(/\s+/).filter(Boolean);

  // 1. length
  if (words.length > 15) failures.push(`rule 1: ${words.length} words (max 15)`);
  if (text.length > 100) failures.push(`rule 1: ${text.length} chars (max 100)`);

  // 2. hashtags / emoji
  if (text.includes("#")) failures.push("rule 2: contains #");
  const emoji = text.match(/\p{Extended_Pictographic}/gu) ?? [];
  if (emoji.length > 1) failures.push(`rule 2: ${emoji.length} emoji (max 1)`);

  // 3. terminal punctuation
  if (/[.!]\s*$/.test(text)) failures.push("rule 3: ends with . or !");

  // 4. banned phrases
  const lower = text.toLowerCase();
  for (const p of BANNED_PHRASES) {
    if (lower.includes(p)) failures.push(`rule 4: banned phrase "${p}"`);
  }

  // 5. em dash
  if (text.includes("—")) failures.push("rule 5: contains em dash");

  // 6. line count
  const lines = text.split("\n").filter((l) => l.trim());
  if (lines.length > 2) failures.push(`rule 6: ${lines.length} lines (max 2)`);

  // 7. leading capital (warning — Claude confirms proper noun)
  if (/^[A-Z]/.test(text.trim())) {
    warnings.push("rule 7: starts with a capital — confirm it's a proper noun, else lowercase it");
  }

  // 8. similarity vs history
  const closest = closestCaption(text, history);
  if (closest && closest.score >= SIMILARITY_THRESHOLD) {
    failures.push(`rule 8: ${(closest.score * 100).toFixed(0)}% similar to "${closest.caption}"`);
  }

  return { failures, warnings };
}

function main() {
  const args = process.argv.slice(2);
  const cfg = loadConfig();
  const history = captionHistory(readJournal(cfg.abs.journal));

  if (args[0] === "--caption") {
    const { failures, warnings } = lintCaption(args[1] ?? "", history);
    for (const w of warnings) console.log(`WARN  ${w}`);
    for (const f of failures) console.log(`FAIL  ${f}`);
    if (!failures.length) console.log("PASS");
    process.exit(failures.length ? 1 : 0);
  }

  const batchPath = args[0];
  if (!batchPath) {
    console.error("usage: caption-lint.mjs <batch.json> | --caption <text>");
    process.exit(2);
  }
  const batch = JSON.parse(readFileSync(batchPath, "utf8"));
  const items = batch.items.filter((i) => !i.qa?.skip && i.slot);

  let hardFailures = 0;
  const seenThisBatch = [];
  for (const item of items) {
    const label = `${item.slot.slot_slug} (${item.node_id})`;
    if (!item.caption) {
      console.log(`FAIL  ${label}: caption is empty`);
      hardFailures++;
      continue;
    }
    const { failures, warnings } = lintCaption(item.caption, [...history, ...seenThisBatch]);
    seenThisBatch.push(item.caption);
    if (!failures.length && !warnings.length) {
      console.log(`PASS  ${label}: "${item.caption}"`);
    }
    for (const w of warnings) console.log(`WARN  ${label}: ${w} — "${item.caption}"`);
    for (const f of failures) console.log(`FAIL  ${label}: ${f} — "${item.caption}"`);
    hardFailures += failures.length;
  }

  console.log(hardFailures ? `\n${hardFailures} hard failure(s)` : `\nall ${items.length} captions clean`);
  process.exit(hardFailures ? 1 : 0);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) main();
