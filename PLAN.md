# X AI Employee — Weekly Worksnap Pipeline

An X account fronted by a Pixelup persona (**Tanvi Rao**, brand designer — see
[voice/persona.md](voice/persona.md)) that posts client-work snapshots and drives
signups to the Free Brand Perception Audit. Claude writes the captions and
orchestrates; deterministic Node scripts do everything mechanical; **Typefully** is
the scheduling layer and the human-review surface.

Status: **built and dry-run verified. Blocked on credentials to go live** (see
"Going live" below).

Supersedes the earlier design (raw X API, 3 posts/day, custom localhost review app,
automated reply engine). Replies/engagement are manual for now — Arjun drives the
account's interactions himself; automation of that comes later.

---

## 1. The weekly loop

Once a week, Arjun (or a scheduled task, later) invokes the **worksnap** skill in
Claude Code ([.claude/skills/worksnap/SKILL.md](.claude/skills/worksnap/SKILL.md)).
One run produces the whole week: **14 posts = 2/day × 7 days**, starting tomorrow.

Each post is a 2-tweet thread:

1. **Snapshot** — a frame exported from the dedicated Figma file + a caption in the
   persona voice (median target 4–8 words, lowercase, no hashtags — the full spec
   with archetype rankings is in [voice/persona.md](voice/persona.md))
2. **CTA reply** — `Get a free brand perception audit.` + UTM-tagged link. Keeping
   the link out of the parent tweet protects the parent's reach.

Every draft lands in Typefully as a **planned** draft (`plan_at`), which is inert —
it will never auto-publish. Arjun reviews the week's 14 drafts in Typefully in one
sitting: confirm, edit, or kill each. **Nothing ships unreviewed, by API design
rather than by our own review app.**

### Pipeline stages (who does what)

| Stage | Owner | What |
| --- | --- | --- |
| `scripts/prepare-week.mjs` | script | pick unconsumed frames FIFO, export PNGs, compute 14 slot datetimes → `state/runs/<run_id>/batch.json` |
| QA pass | Claude | look at every PNG; skip unfinished/confidential/duplicate frames with a reason |
| `prepare-week.mjs --reslot` | script | re-derive slot assignment after skips (buffer frames get promoted; slot math never lives in the LLM) |
| Caption pass | Claude | caption + archetype per frame, against the voice spec |
| `scripts/caption-lint.mjs` | script | the 8 deterministic rules from the voice spec; Claude fixes FAILs and re-runs |
| `scripts/push-drafts.mjs` | script | media upload → planned draft per item → journal → `report.md`. Crash- and retry-safe (journal appended after each success; items with a draft id are skipped on rerun) |
| Summary | Claude | shortfall first, then what's planned; "go review in Typefully" |

### Slots

Default `20:30` and `23:30` IST — deliberately US-hours: **8:00am and 11:00am PT**,
because the ICP (see the Positioning & ICP Engine doc in `Growth/SEO:AEO/`) is
US-based founders. First slot is always tomorrow, never today, so there is a review
window before anything is dated. IST has no DST, so all datetime math is fixed-offset
string building — no timezone libraries.

### UTM attribution

The tweet id doesn't exist before publishing, so `utm_content` is the **date-slot
slug** (`2026-08-10-am`), which joins back to the journal. URL shape (query **before**
`#audit`, or the UTMs land in the fragment and analytics sees nothing — the builder
in `lib/slots.mjs` makes the wrong order structurally impossible):

```
https://pixelup-website-v1.vercel.app/?utm_source=x&utm_medium=social&utm_campaign=worksnap&utm_content=2026-08-10-am#audit
```

---

## 2. Where frames come from

A **dedicated Figma file**, separate from the main working file. Designers copy
cleared frames into it; the pipeline reads that file and nothing else. A frame being
present *is* the clearance — NDA, finished-enough, and correct attribution all
confirmed by whoever dragged it in. Claude's QA pass is the backstop, not the gate.

- FIFO oldest-first by document order; one frame per post.
- `state/journal.ndjson` records every planned/skipped node id; the picker skips
  them, so a frame cannot ship twice and a QA-rejected frame isn't re-offered weekly.
- Nothing is ever written back to Figma. The PAT stays **read-only** — it can see
  client work.
- Figma REST API is the pipeline path; Figma MCP is optional for interactive
  eyeballing only.

**Attribution framing** (per Arjun): the persona posts work as their own, done at
Pixelup for clients. Whoever adds a frame must be comfortable with that claim being
made under the persona — otherwise the caption uses team voice, or the frame stays out.

---

## 3. Dry-run mode

The whole pipeline runs with **zero credentials**:

- Missing env keys → automatic dry-run with a loud banner (or force with `--dry-run`).
- Figma is replaced by `fixtures/figma-file.json` + 16 generated PNGs
  (`npm run make-fixtures`), parsed by the same code as the live API response.
- Typefully calls write their exact would-be request bodies to
  `outbox/<run_id>/draft-NN.json` instead of POSTing.
- Dry-run journal lines are flagged and never consume frames from real runs.

Verified end-to-end 2026-08-06: prepare → QA skip + reslot (buffer promotion) →
captions → lint (catches planted rule-1/4/8 violations, including intra-batch
near-duplicates) → push (14 contract-shaped payloads) → retry (no double-push, no
duplicate journal lines) → shortfall path (9 frames → earliest-first fill + loud
warning).

---

## 4. Typefully API notes (v2, verified against docs 2026-08)

- Auth: `Authorization: Bearer TYPEFULLY_API_KEY`
- Thread = the `platforms.x.posts[]` array in one draft
- Media: two-step presigned upload (request URL → PUT raw bytes → poll until `ready`)
- `plan_at` → **planned** (inert, human-confirmed) vs `publish_at` → scheduled
  (auto-publishes). `config.json → typefully.draft_mode` is `"planned"`; flipping it
  to `"scheduled"` removes human review — one word, big consequences, don't.
- `node scripts/push-drafts.mjs --check` lists social sets to find `social_set_id`.

---

## 5. Going live (blocked on Arjun)

| # | Needed | Blocks |
| --- | --- | --- |
| 1 | Persona sign-off: name "Tanvi Rao", bio, handle, avatar approach ([voice/persona.md](voice/persona.md)) | account creation |
| 2 | X account created for the persona, connected to a Typefully workspace | posting |
| 3 | `TYPEFULLY_API_KEY` in `.env` + `typefully.social_set_id` in config (find via `--check`) | posting |
| 4 | Dedicated Figma file + its `file_key` in config + read-only `FIGMA_PAT` in `.env`; designers briefed that dropping a frame in = clearance | frame supply |
| 5 | Confirm the audit form records UTM params | attribution — without it, 100k impressions prove zero signups came from X |
| 6 | Slot times sign-off (default 20:30/23:30 IST = US mornings) | nothing; config knob |
| 7 | Signup target from Daksh | reporting only |

Item 5 is the one worth checking early.

## 6. Targets

100,000 impressions in 90 days (~40 signups at modelled funnel rates — the number to
negotiate with Daksh). The impressions math from the earlier plan assumed a reply
engine; with posting-only plus Arjun's manual engagement, treat 100k as a stretch
goal until real per-post view data lands in the first two weeks of the journal.

## 7. Deferred

Reply/engagement automation, scheduled weekly trigger (manual skill invocation for
now), impressions/report tooling, published-status sync-back from Typefully into the
journal.
