// Slot math + CTA URL building. Pure functions, no I/O, no dependencies.
//
// Slots are anchored to the audience timezone (America/Los_Angeles — the ICP is
// SF AI-B2B founders). PT has DST, so offsets are resolved per-date via Node's
// built-in Intl instead of a hardcoded offset.
//
// Each day's slot times get a DETERMINISTIC jitter (hash of date+label) of up to
// ±jitter_minutes around the configured base time, so no two days post at the
// same minute (reads human, not cron) — while the same run date always computes
// the same times, keeping reruns and --reslot idempotent.

/** UTC offset string (e.g. "-07:00") for a timezone on a given date. */
export function offsetForZone(ymd, timeZone) {
  const probe = new Date(`${ymd}T12:00:00Z`);
  const parts = new Intl.DateTimeFormat("en-US", { timeZone, timeZoneName: "longOffset" }).formatToParts(probe);
  const name = parts.find((p) => p.type === "timeZoneName")?.value ?? "GMT+00:00"; // "GMT-07:00"
  const m = name.match(/GMT([+-])(\d{1,2})(?::(\d{2}))?/);
  if (!m) throw new Error(`cannot resolve offset for ${timeZone} (${name})`);
  return `${m[1]}${m[2].padStart(2, "0")}:${m[3] ?? "00"}`;
}

/** Today's date in the given timezone, as "YYYY-MM-DD". */
export function todayInZone(timeZone, now = new Date()) {
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}

function addDays(ymd, n) {
  const d = new Date(`${ymd}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** Deterministic jitter in [-maxMinutes, +maxMinutes] from a string seed (FNV-1a). */
export function jitterMinutes(seed, maxMinutes) {
  if (!maxMinutes) return 0;
  let h = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return (h % (2 * maxMinutes + 1)) - maxMinutes;
}

/**
 * Compute the week's slots from a run date.
 * Day 1 = runDate + start_offset_days; horizon_days consecutive days × slots_local,
 * each jittered deterministically. Assumes base times are not within jitter range
 * of midnight.
 * @returns [{slot_iso: "2026-08-07T09:13:00-07:00", slot_slug: "2026-08-07-am", date, time, label}]
 */
export function computeSlots(runDateYmd, posting) {
  const slots = [];
  for (let day = 0; day < posting.horizon_days; day++) {
    const date = addDays(runDateYmd, posting.start_offset_days + day);
    const offset = offsetForZone(date, posting.timezone);
    posting.slots_local.forEach((base, i) => {
      const label = posting.slot_labels[i];
      const [bh, bm] = base.split(":").map(Number);
      const total = bh * 60 + bm + jitterMinutes(`${date}-${label}`, posting.jitter_minutes ?? 0);
      const time = `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
      slots.push({
        date,
        time,
        label,
        slot_iso: `${date}T${time}:00${offset}`,
        slot_slug: `${date}-${label}`,
      });
    });
  }
  return slots;
}

/**
 * Build the CTA URL with UTMs in the query string and the fragment LAST.
 * Constructed so query-before-fragment is structurally guaranteed.
 * UTM values are fixed from config (no per-post dates, per Arjun); per-post
 * attribution lives in the journal.
 */
export function buildCtaUrl(cta) {
  const qs = new URLSearchParams(cta.utm).toString();
  const url = `${cta.base_url}?${qs}#${cta.fragment}`;
  if (url.indexOf("?") > url.indexOf("#")) {
    throw new Error(`CTA URL built with fragment before query: ${url}`);
  }
  return url;
}

/** The CTA tweet text: copy block, blank line, link. */
export function buildCtaTweet(cta) {
  return `${cta.text}\n\n${buildCtaUrl(cta)}`;
}
