// state/journal.ndjson — the pipeline's memory.
// Jobs: (a) a frame never ships twice, (b) caption-similarity history for lint rule 8.
// Append-only. Dry-run lines are recorded but never consume frames.

import { readFileSync, appendFileSync, existsSync, mkdirSync } from "node:fs";
import path from "node:path";

export function readJournal(journalPath) {
  if (!existsSync(journalPath)) return [];
  return readFileSync(journalPath, "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l, i) => {
      try {
        return JSON.parse(l);
      } catch {
        throw new Error(`journal line ${i + 1} is not valid JSON — fix or remove it: ${l.slice(0, 120)}`);
      }
    });
}

export function appendJournal(journalPath, entry) {
  mkdirSync(path.dirname(journalPath), { recursive: true });
  appendFileSync(journalPath, JSON.stringify(entry) + "\n");
}

/**
 * Node ids that must not be offered again: planned or QA-skipped, real runs only.
 * (A QA-rejected frame stays blocked so it isn't re-offered every week — the run
 * report tells Arjun to pull it from the Figma file. Override = delete the line.)
 */
export function consumedNodeIds(entries) {
  return new Set(
    entries
      .filter((e) => !e.dry_run && (e.status === "planned" || e.status === "skipped_qa"))
      .map((e) => e.node_id),
  );
}

/** Captions that actually shipped toward X (real planned drafts) — rule 8 history. */
export function captionHistory(entries) {
  return entries.filter((e) => !e.dry_run && e.status === "planned" && e.caption).map((e) => e.caption);
}

// --- similarity (lint rule 8): bigram Dice coefficient on lowercased text ---

function bigrams(s) {
  const t = s.toLowerCase().replace(/\s+/g, " ").trim();
  const grams = new Map();
  for (let i = 0; i < t.length - 1; i++) {
    const g = t.slice(i, i + 2);
    grams.set(g, (grams.get(g) || 0) + 1);
  }
  return grams;
}

export function diceSimilarity(a, b) {
  const ga = bigrams(a);
  const gb = bigrams(b);
  let overlap = 0;
  for (const [g, ca] of ga) if (gb.has(g)) overlap += Math.min(ca, gb.get(g));
  const total = [...ga.values()].reduce((s, n) => s + n, 0) + [...gb.values()].reduce((s, n) => s + n, 0);
  return total === 0 ? 0 : (2 * overlap) / total;
}

/** Returns {caption, score} of the closest historical caption, or null if history is empty. */
export function closestCaption(caption, history) {
  let best = null;
  for (const h of history) {
    const score = diceSimilarity(caption, h);
    if (!best || score > best.score) best = { caption: h, score };
  }
  return best;
}
