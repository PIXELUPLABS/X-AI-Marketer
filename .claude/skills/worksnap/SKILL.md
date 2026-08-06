---
name: worksnap
description: Run the weekly X worksnap batch — pull cleared Figma frames, QA them visually, write captions in the persona voice, lint, and push 14 planned drafts (2/day × 7 days) to Typefully for Arjun's weekly review. Use when Arjun says "run the weekly batch", "worksnap", "prep this week's posts", or similar.
---

# Weekly worksnap run

You are producing one week of X content for the Pixelup persona account: 14 posts
(2/day × 7 days), each a 2-tweet thread (work snapshot + caption, then the audit CTA).
Everything lands in Typefully as **planned** drafts — inert until Arjun confirms them
in the Typefully app. You never publish anything.

All scripts live in the project root (`package.json` is there). Run them with the
project root as cwd.

## Steps

### 1. Prepare

```bash
node scripts/prepare-week.mjs
```

Add `--dry-run` only if Arjun asked for a rehearsal; with credentials missing the
script auto-falls back to dry-run and says so — do not fight that, just tell Arjun
which keys are missing at the end.

Note the batch path it prints: `state/runs/<run_id>/batch.json`. If it reports a
SHORTFALL, continue anyway — a short week is valid — but the shortfall must be the
FIRST line of your final summary.

### 2. QA every frame (visual judgment — this is why you exist)

Read every `images/*.png` in the run dir. For each frame, set `qa` in batch.json to
`{"skip": true, "reason": "<specific reason>"}` if ANY of:

- looks unfinished: placeholder/lorem text, empty content areas, unresolved layout
- confidential risk: client name, real user data, emails, revenue numbers, or
  anything NDA-smelling that a designer wouldn't publicly post
- not actually design work (random screenshot, meme, blank frame)
- near-duplicate of another frame in this same batch (keep the better one)

Leave `qa` as `null` for frames that pass. Then re-derive slots (never assign slots
yourself):

```bash
node scripts/prepare-week.mjs --reslot <run_id>
```

### 3. Write captions

Read `voice/persona.md` IN FULL first — identity, voice shape, archetypes,
attribution rules, banned list. Skim `voice/caption-bank.md` for angle inspiration
(adapt, never copy — lint rule 8 blocks repeats). Then for each slotted item write
`caption` and `archetype` into batch.json.

Target archetype mix per 14: ~5 `rejected_unused`, ~6 `plain_label`, ~2 `bts_process`,
≤1 `opinion`. Look at the actual image before captioning — the caption is a label or
aside about what's literally in the frame, never an explanation of it.

**Client names:** a caption may name a client ONLY if the name appears in
`config.json → account.public_client_allowlist`. A client name visible inside the
image, or the frame being cleared, does NOT allow naming them in the caption.
Default anonymous formula: `a recent client`, optionally tagged
(`brand + web for a recent client @pixeluplabs`) — use the tag on a minority of
captions, not all. Beyond that, BE CREATIVE within the voice: craft angle, process
angle, viewer angle (questions ≤1-in-10), small confessions. Avoid category-soup
descriptors (`legal ai platform`, `fintech client`) and never `an ai startup` bare
(lint rejects it). If a frame really deserves the real client name, ask Arjun to
add it to the allowlist instead of guessing.

### 4. Lint

```bash
node scripts/caption-lint.mjs state/runs/<run_id>/batch.json
```

Fix every FAIL and re-run. For a rule-7 WARN, lowercase the caption unless the first
word is genuinely a proper noun. Max 3 fix rounds per caption — if one still fails,
set its item `qa: {"skip": true, "reason": "caption unwritable"}`, re-run `--reslot`,
and say so loudly in the summary.

### 5. Push

```bash
node scripts/push-drafts.mjs state/runs/<run_id>/batch.json
```

Crash-safe and retry-safe: rerun it on the same batch after a partial failure —
already-pushed items are skipped. If items error twice, report them and move on.

### 6. Report to Arjun

Read `state/runs/<run_id>/report.md` and summarize:

1. SHORTFALL first, if any (and QA skips he should pull from the Figma file)
2. How many drafts are planned and the date range they cover
3. Live run: "review and confirm the week in Typefully". Dry run: point at the
   outbox dir and say which credentials are missing to go live.
4. Always remind Arjun: while reviewing, use X's "Tag People" on each snapshot
   image to tag @pixeluplabs — photo-tagging is not exposed by the Typefully API,
   so it's a manual step at review time.

## Hard rules

- Never flip `typefully.draft_mode` to `"scheduled"` — that makes drafts auto-publish.
- Never edit `state/journal.ndjson` by hand; scripts own it.
- Never assign or shuffle slots yourself; only `prepare-week.mjs --reslot` does slot math.
- A frame you QA-rejected stays rejected (it's journaled); don't re-admit it next week.
- Figma MCP tools, if connected, may be used to LOOK at frames interactively, but the
  pipeline itself always goes through the scripts.
