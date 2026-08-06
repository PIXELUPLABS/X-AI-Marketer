// Slot math + CTA URL building. Pure functions, no I/O.
// IST has no DST, so ISO datetimes are plain string concatenation with the
// configured fixed offset — no timezone library needed or wanted.

/**
 * Today's date in the configured fixed-offset timezone, as "YYYY-MM-DD".
 * Derived from UTC + offset so the machine's local timezone never matters.
 */
export function todayInOffset(utcOffset, now = new Date()) {
  const m = utcOffset.match(/^([+-])(\d{2}):(\d{2})$/);
  const sign = m[1] === "-" ? -1 : 1;
  const offsetMs = sign * (Number(m[2]) * 60 + Number(m[3])) * 60_000;
  return new Date(now.getTime() + offsetMs).toISOString().slice(0, 10);
}

function addDays(ymd, n) {
  const d = new Date(`${ymd}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/**
 * Compute the week's slots from a run date.
 * Day 1 = runDate + start_offset_days; horizon_days consecutive days × slots_local.
 * @returns [{slot_iso: "2026-08-07T20:30:00+05:30", slot_slug: "2026-08-07-am", date, label, time}]
 */
export function computeSlots(runDateYmd, posting) {
  const slots = [];
  for (let day = 0; day < posting.horizon_days; day++) {
    const date = addDays(runDateYmd, posting.start_offset_days + day);
    posting.slots_local.forEach((time, i) => {
      const label = posting.slot_labels[i];
      slots.push({
        date,
        time,
        label,
        slot_iso: `${date}T${time}:00${posting.utc_offset}`,
        slot_slug: `${date}-${label}`,
      });
    });
  }
  return slots;
}

/**
 * Build the CTA URL with UTMs in the query string and the fragment LAST.
 * Constructed so query-before-fragment is structurally guaranteed.
 */
export function buildCtaUrl(cta, utmContent) {
  const qs = new URLSearchParams({ ...cta.utm, utm_content: utmContent }).toString();
  const url = `${cta.base_url}?${qs}#${cta.fragment}`;
  if (url.indexOf("?") > url.indexOf("#")) {
    throw new Error(`CTA URL built with fragment before query: ${url}`);
  }
  return url;
}

/** The CTA tweet text: line 1 copy, line 2 link. */
export function buildCtaTweet(cta, utmContent) {
  return `${cta.text}\n${buildCtaUrl(cta, utmContent)}`;
}
