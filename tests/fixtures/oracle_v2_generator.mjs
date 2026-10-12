// Independent oracle generator for decision spec v2 (CONTRACTS_CP4.md + DECISION_RULES.md + CDC form).
// Written without reading any implementation. Hand-written expectations are cross-checked
// against a small interpretation-model (`model()`) below; any mismatch aborts generation.
import { writeFileSync } from 'node:fs';

const OUT = new URL('./decision_matrix_v2_expected.json', import.meta.url);   // (overnight: was an absolute path)
const TGO = 6000, TEND = 36000;
const GRID = []; for (let t = 1500; t <= 36300; t += 150) GRID.push(t);
const clone = (x) => JSON.parse(JSON.stringify(x));

// ---------- CDC table (sources/cdc/STEADI-Assessment-30Sec-508.txt, "Below Average Scores") ----------
const CDC = [ // [lo, hi, men, women]  below average if count < threshold
  [60, 64, 14, 12], [65, 69, 12, 11], [70, 74, 12, 10], [75, 79, 11, 10],
  [80, 84, 10, 9], [85, 89, 8, 8], [90, 94, 7, 4],
];
function threshold(ageText, column) {
  if (typeof ageText !== 'string' || !/^\d{1,3}$/.test(ageText)) return null;
  const a = Number(ageText); const row = CDC.find(([lo, hi]) => a >= lo && a <= hi);
  if (!row || (column !== 'men' && column !== 'women')) return null;
  return column === 'men' ? row[2] : row[3];
}
const cat = (v, thr) => (v < thr ? 'below_average' : 'not_below_average');

// ---------- events ----------
function mkEvents(spec) {
  const plain = spec.split('').filter((c) => c !== 'E');
  const s = Math.min(2400, Math.floor(27000 / plain.length));
  const ev = []; let i = 0; let n = 1;
  for (const c of spec) {
    if (c === 'E') {
      ev.push({ n: n++, cls: 'expiry', counted: true, tRise: 35300, tFull: null, tExpiry: 36000, tPeak: null, tSeat: null, flags: [] });
      continue;
    }
    const tRise = 6400 + i * s; i++;
    if (c === 'F') ev.push({ n: n++, cls: 'full', counted: true, tRise, tFull: tRise + 700, tExpiry: null, tPeak: tRise + 800, tSeat: tRise + 1900, flags: [] });
    else if (c === 'U') ev.push({ n: n++, cls: 'uncertain', counted: false, tRise, tFull: null, tExpiry: null, tPeak: tRise + 700, tSeat: tRise + 1900, flags: ['uncertain_rise'] });
    else if (c === 'P') ev.push({ n: n++, cls: 'partial', counted: false, tRise, tFull: null, tExpiry: null, tPeak: tRise + 500, tSeat: tRise + 1600, flags: ['partial_rise'] });
    else throw new Error('bad spec ' + c);
  }
  return ev;
}
const anchor = (e) => e.tFull ?? e.tExpiry ?? e.tPeak;

// ---------- coverage per CONTRACTS_CP4 §2 (inputs are supplied, computed here only for consistency with imageTimes) ----------
const AUTO_FLAGS = new Set(['uncertain_rises', 'extension_unverifiable_view', 'no_practice_stand', 'no_accepted_reference', 'expiry_without_practice_stand']);
function spanOk(imgs, a, b, maxGap) {
  const seq = [a, ...imgs.filter((t) => t > a && t < b), b];
  const gaps = [];
  for (let k = 1; k < seq.length; k++) if (seq[k] - seq[k - 1] > maxGap) gaps.push([seq[k - 1], seq[k]]);
  return gaps;
}
function computeCoverage(result, imageTimes) {
  const near = (t, tol) => imageTimes.some((x) => Math.abs(x - t) <= tol);
  const cov = { imageTimes, reference: { ok: false }, events: {}, flags: {}, endpoint: { ok: near(result.window.tGo + 30000, 250) }, scan: { ok: false, gaps: [] } };
  const ref = result.reference;
  if (ref) cov.reference.ok = imageTimes.some((x) => x >= ref.t0 - 150 && x <= ref.t1 + 150);
  for (const e of result.events) cov.events[String(e.n)] = { ok: near(anchor(e), 250) };
  for (const [f, wins] of Object.entries(result.flagWindows || {})) {
    cov.flags[f] = { ok: wins.every(([a, b]) => spanOk(imageTimes, a - 200, b + 200, 500).length === 0) };
  }
  const gaps = spanOk(imageTimes, result.window.tGo, result.window.tGo + 30000, 1000);
  cov.scan = { ok: gaps.length === 0, gaps };
  return cov;
}

// ---------- base session: every automatic gate satisfied ----------
function base(spec = 'FFFFFFFF') {
  const events = mkEvents(spec);
  return {
    result: {
      reason: 'expired', status: 'measured', window: { tGo: TGO, tEnd: TEND, observedMs: 30000 },
      events, reviewFlags: [], flagWindows: {},
      reference: { id: 'ref-1', t0: 2000, t1: 3000, accepted: { basis: 'image' }, postureWarning: false },
      expiry: { decision: 'none' },
    },
    source: 'camera',
    observer: { arms: 'no', setup: 'yes' },
    participant: { ageText: '72', column: 'women' },
    evidence: {
      available: true, coverage: 'AUTO', identityConfirmed: true, identityConfirmedFor: 'AUTO',
      eventResolutions: {}, flagChecks: {}, sessionScan: 'no_missed', added: [],
    },
    manual: null,
    basisChoice: null,
  };
}
const noImages = (s) => { s.evidence.available = false; s.evidence.coverage = null; };
const around = (t) => [t - 260, t + 260];
const ev = (s, n) => s.result.events.find((e) => e.n === n);

// ---------- interpretation model (used only to cross-check the hand-written expectations) ----------
function model(s) {
  const r = s.result; const E = s.evidence || {};
  const arms = s.observer?.arms; const setup = s.observer?.setup;
  const thr = threshold(s.participant?.ageText, s.participant?.column);
  const out = { value: null, referenceEligible: false, category: null, conflict: false, min: null, max: null };
  if (arms === 'yes') {
    out.value = 0;
    out.referenceEligible = s.source === 'camera' && setup === 'yes' && thr !== null;
    out.category = out.referenceEligible ? cat(0, thr) : null;
    return out;
  }
  const completed = r.reason === 'expired' && r.window.observedMs >= 29999;
  if (!completed) return out;
  const r7 = s.source === 'camera' && setup === 'yes' && arms === 'no' && thr !== null;
  const m = s.manual;
  const manualValid = s.source === 'camera' && !!m && typeof m.text === 'string' && /^\d{1,2}$/.test(m.text) && Number(m.text) <= 60 && typeof m.reason === 'string' && m.reason.trim() !== '';
  const mval = manualValid ? Number(m.text) : null;
  const bc = s.basisChoice; const choice = bc && typeof bc.rationale === 'string' && bc.rationale.trim() !== '' ? bc.basis : null;

  let autoEligible = false; let autoValue = null; let r6cat = null;
  if (r.status !== 'withheld') {
    const cov = E.available ? E.coverage : null;
    const evOk = (n) => !!(cov && cov.events?.[String(n)]?.ok);
    const res = (n) => (evOk(n) ? E.eventResolutions?.[String(n)] ?? E.eventResolutions?.[n] : undefined);
    let min = 0; let extra = 0;
    for (const e of r.events) {
      const x = res(e.n);
      if (e.counted) { if (x === 'not_full') continue; if (x === 'cant_tell') extra++; else min++; }
      else if (e.cls === 'uncertain') { if (x === 'full') min++; else if (x === 'not_full') { /* out */ } else extra++; }
      else if (e.cls === 'partial') { if (x === 'full') min++; else if (x === 'cant_tell') extra++; }
    }
    for (const a of E.added || []) if (cov && cov.imageTimes.includes(a.t)) min++;
    out.min = min; out.max = min + extra;
    const determinate = extra === 0;
    const refOk = !!(r.reference && r.reference.accepted?.basis === 'image' && cov?.reference?.ok);
    const required = r.events.filter((e) => e.counted || e.cls === 'uncertain' || (e.cls === 'partial' && res(e.n) === 'full')).map((e) => e.n);
    const idSet = new Set(E.identityConfirmedFor || []);
    const idOk = E.identityConfirmed === true && required.every(evOk) && required.every((n) => idSet.has(n)) && idSet.size === required.length;
    const uncertainAllResolved = r.events.filter((e) => e.cls === 'uncertain').every((e) => ['full', 'not_full'].includes(res(e.n)));
    const flagsOk = (r.reviewFlags || []).every((f) => (AUTO_FLAGS.has(f) ? uncertainAllResolved : E.flagChecks?.[f] === 'ok' && !!cov?.flags?.[f]?.ok));
    const endpointRelevant = r.events.some((e) => e.cls === 'expiry' || e.tExpiry != null) || (r.reviewFlags || []).some((f) => f.startsWith('expiry_'));
    const endpointOk = !endpointRelevant || !!cov?.endpoint?.ok;
    const scanOk = E.sessionScan === 'no_missed' && !!cov?.scan?.ok;
    let rangeOk = determinate;
    if (!determinate && thr !== null && cat(out.min, thr) === cat(out.max, thr)) { rangeOk = true; r6cat = cat(out.min, thr); }
    autoEligible = !!cov && refOk && idOk && flagsOk && endpointOk && scanOk && rangeOk;
    autoValue = determinate ? min : null;
  }
  if (autoEligible && manualValid && mval !== autoValue) {
    out.conflict = true;
    if (choice === 'automatic') { out.value = autoValue; }
    else if (choice === 'supervisor') { out.value = mval; r6cat = null; }
    else { return out; }
    out.conflict = 'resolved';
  } else if (autoEligible) {
    out.value = autoValue;
  } else if (manualValid && choice === 'supervisor') {
    out.value = mval; r6cat = null;
  } else return out;
  if (out.value !== null) { out.referenceEligible = r7; out.category = r7 ? cat(out.value, thr) : null; }
  else if (r6cat) { out.referenceEligible = r7; out.category = r7 ? r6cat : null; }
  return out;
}

// ---------- case builder ----------
const cases = [];
function C(id, why, { spec = 'FFFFFFFF', del = [], mut = () => {}, covCheck, expect }) {
  const s = base(spec);
  mut(s);
  if (s.evidence.identityConfirmedFor === 'AUTO') s.evidence.identityConfirmedFor = s.result.events.filter((e) => e.counted || e.cls === 'uncertain').map((e) => e.n);
  if (s.evidence.coverage === 'AUTO') {
    const imgs = GRID.filter((t) => !del.some(([a, b]) => t >= a && t <= b));
    s.evidence.coverage = computeCoverage(s.result, imgs);
  }
  if (covCheck && !covCheck(s.evidence.coverage)) throw new Error(`${id}: coverage precondition failed`);
  const m = model(s);
  const bad = [];
  if (m.value !== expect.value) bad.push(`value model=${m.value} exp=${expect.value}`);
  if (m.referenceEligible !== expect.referenceEligible) bad.push(`elig model=${m.referenceEligible}`);
  if (m.category !== expect.category) bad.push(`cat model=${m.category}`);
  if ('conflict' in expect && (m.conflict === true) !== expect.conflict) bad.push(`conflict model=${m.conflict}`);
  if ('automaticMin' in expect && m.min !== expect.automaticMin) bad.push(`min model=${m.min}`);
  if ('automaticMax' in expect && m.max !== expect.automaticMax) bad.push(`max model=${m.max}`);
  if (bad.length) throw new Error(`${id}: ${bad.join('; ')}`);
  if (cases.some((c) => c.id === id)) throw new Error('dup ' + id);
  cases.push({ id, why, session: s, expect });
}
const ok = (v, cat_, extra = {}) => ({ value: v, referenceEligible: true, category: cat_, ...extra });
const nul = (extra = {}) => ({ value: null, referenceEligible: false, category: null, ...extra });
const B = 'below_average', NB = 'not_below_average';
const SUP = (s, text, reason = 'counted aloud during the timed test') => { s.manual = { text, reason }; s.basisChoice = { basis: 'supervisor', rationale: 'camera evidence not usable; using my own count' }; };

// ===== A. Reference acceptance =====
C('A01_all_gates_image_reference', 'Baseline: 8 counted full rises, reference accepted basis image with coverage (CP4 §1, §2), identity confirmed for all counted rises with anchor coverage, no flags, scan no_missed with coverage, determinate range (CP4 §3 automatic basis). Women 72 threshold <10 (CDC row 70-74) -> 8 below.', {
  expect: ok(8, B, { conflict: false, automaticMin: 8, automaticMax: 8 }) });
C('A02_reference_accepted_observer_watched', 'CP4 §3: automatic basis requires reference accepted with basis `image`; observer_watched (CP4 §1 table "Basis") is not sufficient for the automatic basis. No manual count -> no value.', {
  mut: (s) => { s.result.reference.accepted = { basis: 'observer_watched' }; },
  expect: nul({ automaticMin: 8, automaticMax: 8, mustIncludeBlockerKeywords: ['reference'] }) });
C('A03_reference_observer_watched_supervisor_route', 'CP4 §3 count basis: automatic not eligible (observer_watched reference) but a valid supervisor count with explicit basisChoice supervisor + rationale is used. 9 < 10 (women 70-74) -> below.', {
  mut: (s) => { s.result.reference.accepted = { basis: 'observer_watched' }; SUP(s, '9'); },
  expect: ok(9, B, { conflict: false }) });
C('A04_reference_not_accepted_count_without_reference', 'CP4 §1 "Without acceptance": every rise uncertain + flag no_accepted_reference. All 8 uncertain resolved full with coverage, so the auto-resolved flags (CP4 §6) count as checked and the range is determinate (8), but reference.accepted is null so the automatic basis is blocked (CP4 §3).', {
  spec: 'UUUUUUUU',
  mut: (s) => { s.result.reference.accepted = null; s.result.reviewFlags = ['no_accepted_reference', 'uncertain_rises']; s.result.status = 'needs_review';
    for (let n = 1; n <= 8; n++) s.evidence.eventResolutions[String(n)] = 'full'; },
  expect: nul({ automaticMin: 8, automaticMax: 8, mustIncludeBlockerKeywords: ['reference'] }) });
C('A05_reference_null_no_practice_stand', 'CP4 §3: no reference at all (reference null, flag no_practice_stand) -> automatic basis not eligible even though every other gate holds.', {
  mut: (s) => { s.result.reference = null; s.result.reviewFlags = ['no_practice_stand']; s.result.status = 'needs_review'; },
  expect: nul({ automaticMin: 8, automaticMax: 8, mustIncludeBlockerKeywords: ['reference'] }) });
C('A06_reference_image_basis_coverage_missing', 'CP4 §2: basis `image` needs >=1 image inside [t0,t1] +-150 ms; images 1740-3260 removed, so coverage.reference.ok=false -> automatic basis blocked (CP4 §3 "accepted with basis image and has coverage").', {
  del: [[1740, 3260]], covCheck: (c) => !c.reference.ok,
  expect: nul({ automaticMin: 8, automaticMax: 8, mustIncludeBlockerKeywords: ['reference'] }) });
C('A07_posture_warning_checked_ok', 'CP4 §1 posture warning: result carries review flag reference_posture_warning which must be checked on images; here flagChecks ok and flag coverage ok -> reference still usable (not a universal straightness rule) -> eligible.', {
  mut: (s) => { s.result.reference.postureWarning = true; s.result.reviewFlags = ['reference_posture_warning']; s.result.flagWindows = { reference_posture_warning: [[2000, 3000]] }; s.evidence.flagChecks = { reference_posture_warning: 'ok' }; s.result.status = 'needs_review'; },
  covCheck: (c) => c.flags.reference_posture_warning.ok,
  expect: ok(8, B, { conflict: false }) });
C('A08_posture_warning_unchecked', 'CP4 §1 + §6: reference_posture_warning is not an auto-resolved flag; without flagChecks ok the automatic basis is blocked. AMBIGUOUS: the flag is supplied in reviewFlags as well as reference.postureWarning=true (both interpretations then agree).', {
  mut: (s) => { s.result.reference.postureWarning = true; s.result.reviewFlags = ['reference_posture_warning']; s.result.flagWindows = { reference_posture_warning: [[2000, 3000]] }; s.result.status = 'needs_review'; },
  expect: nul({ automaticMin: 8, automaticMax: 8, mustIncludeBlockerKeywords: ['posture'] }) });

// ===== B. Coverage =====
C('B01_no_images_resolutions_ignored', 'CP4 §2 effects + §6: coverage null (no images kept) -> every decision lacks coverage and is ignored; the not_full resolution on rise 3 is ignored (min stays 8); identity/scan answers ignored; no value.', {
  mut: (s) => { noImages(s); s.evidence.eventResolutions = { 3: 'not_full' }; },
  expect: nul({ automaticMin: 8, automaticMax: 8, mustIncludeBlockerKeywords: ['image'] }) });
C('B02_event_coverage_missing_one_counted_rise', 'CP4 §2 identity row: anchor coverage needed for every counted rise; rise 4 has no image within 250 ms of tFull -> identity cannot cover it -> automatic basis blocked. Rise still counted in min (coverage does not change the machine record).', {
  mut: () => {}, del: [around(14300)], covCheck: (c) => !c.events['4'].ok && c.scan.ok,
  expect: nul({ automaticMin: 8, automaticMax: 8 }) });
C('B03_identity_missing_one_rise', 'CP4 §3: identity must be confirmed for exactly the covered set, including every counted rise; identityConfirmedFor omits rise 5 -> blocked.', {
  mut: (s) => { s.evidence.identityConfirmedFor = [1, 2, 3, 4, 6, 7, 8]; },
  expect: nul({ automaticMin: 8, automaticMax: 8, mustIncludeBlockerKeywords: ['identity'] }) });
C('B04_flag_window_uncovered_but_checked_ok', 'CP4 §2 flag row (window -200/+200 ms, no gap > 500 ms) + §6: gap_during_movement checked ok but images 15200-15900 missing (gap 900 ms) -> check ignored -> blocked. Scan gap 900 ms <= 1000 so scan stays ok.', {
  del: [[15200, 15900]],
  mut: (s) => { s.result.reviewFlags = ['gap_during_movement']; s.result.flagWindows = { gap_during_movement: [[15000, 16500]] }; s.evidence.flagChecks = { gap_during_movement: 'ok' }; s.result.status = 'needs_review'; },
  covCheck: (c) => !c.flags.gap_during_movement.ok && c.scan.ok && Object.values(c.events).every((e) => e.ok),
  expect: nul({ automaticMin: 8, automaticMax: 8, mustIncludeBlockerKeywords: ['image'] }) });
C('B06_endpoint_missing_with_expiry_event', 'CP4 §2 endpoint row: expiry event exists (CDC "over halfway ... count it as a stand"; v1 resolution 5 -> in min) but no image within 250 ms of 30 s -> blocked. NOTE: the expiry event anchor is tExpiry=30 s, so its anchor coverage (and hence identity) also fails; both block.', {
  spec: 'FFFFFFFE', del: [[35740, 36260]],
  mut: (s) => { s.result.expiry = { decision: 'counted_over_halfway' }; },
  covCheck: (c) => !c.endpoint.ok && c.scan.ok,
  expect: nul({ automaticMin: 8, automaticMax: 8 }) });
C('B07_endpoint_missing_with_expiry_flag_only', 'CP4 §2 endpoint row "(any expiry event or expiry_* flag)": no expiry event, but flag expiry_not_counted_under_halfway (checked ok, window covered) makes the endpoint relevant; endpoint image missing -> blocked. AMBIGUOUS: flag name is hypothetical; only the expiry_ prefix is specified.', {
  del: [[35740, 36260]],
  mut: (s) => { s.result.expiry = { decision: 'not_counted_under_halfway' }; s.result.reviewFlags = ['expiry_not_counted_under_halfway']; s.result.flagWindows = { expiry_not_counted_under_halfway: [[35000, 35500]] }; s.evidence.flagChecks = { expiry_not_counted_under_halfway: 'ok' }; s.result.status = 'needs_review'; },
  covCheck: (c) => !c.endpoint.ok && c.flags.expiry_not_counted_under_halfway.ok && c.scan.ok,
  expect: nul({ automaticMin: 8, automaticMax: 8 }) });
C('B08_endpoint_missing_no_expiry_irrelevant', 'CP4 §3 "endpoint has coverage if relevant": no expiry event and no expiry_* flag, so missing endpoint coverage does not matter -> eligible.', {
  del: [[35740, 36260]], covCheck: (c) => !c.endpoint.ok && c.scan.ok,
  expect: ok(8, B, { conflict: false, automaticMin: 8, automaticMax: 8 }) });
C('B09_endpoint_ok_with_expiry_event', 'Expiry event counted (v1 resolution 5, CDC over-halfway rule) with endpoint and anchor coverage -> 7 full + 1 expiry = 8, eligible.', {
  spec: 'FFFFFFFE', mut: (s) => { s.result.expiry = { decision: 'counted_over_halfway' }; },
  covCheck: (c) => c.endpoint.ok && c.events['8'].ok,
  expect: ok(8, B, { conflict: false, automaticMin: 8, automaticMax: 8 }) });
C('B10_scan_answered_but_coverage_gap', 'CP4 §2 scan row: gap > 1000 ms across [GO, GO+30 s] (images 20000-21200 removed -> 1350 ms gap) -> scan answer no_missed ignored -> blocked. Event anchors all still covered.', {
  del: [[20000, 21200]], covCheck: (c) => !c.scan.ok && Object.values(c.events).every((e) => e.ok),
  expect: nul({ automaticMin: 8, automaticMax: 8, mustIncludeBlockerKeywords: ['missed'] }) });
C('B11_scan_not_answered', 'CP4 §3: the whole-test scan must be answered "no missed stands"; sessionScan null -> blocked.', {
  mut: (s) => { s.evidence.sessionScan = null; },
  expect: nul({ automaticMin: 8, automaticMax: 8, mustIncludeBlockerKeywords: ['missed'] }) });
C('B12_scan_answered_missed', 'CP4 §3: sessionScan `missed` (observer saw a missed stand but did not resolve it) -> blocked.', {
  mut: (s) => { s.evidence.sessionScan = 'missed'; },
  expect: nul({ automaticMin: 8, automaticMax: 8, mustIncludeBlockerKeywords: ['missed'] }) });

// ===== C. Corrections =====
const U6 = (s) => { s.result.reviewFlags = ['uncertain_rises']; s.result.status = 'needs_review'; };
C('C01_uncertain_resolved_full_covered', 'CP4 §3 min: uncertain resolved full (with coverage) counts; uncertain_rises auto-resolved (CP4 §6) since all uncertain rises resolved full/not_full. 7 full + 1 -> 8.', {
  spec: 'FFFFFUFF', mut: (s) => { U6(s); s.evidence.eventResolutions = { 6: 'full' }; },
  expect: ok(8, B, { conflict: false, automaticMin: 8, automaticMax: 8 }) });
C('C02_uncertain_resolved_full_uncovered', 'CP4 §2 effects: resolution without per-event coverage is ignored -> rise 6 stays unresolved (min 7, max 8), uncertain_rises unresolved and anchor missing for identity -> blocked.', {
  spec: 'FFFFFUFF', del: [around(19100)],
  mut: (s) => { U6(s); s.evidence.eventResolutions = { 6: 'full' }; },
  covCheck: (c) => !c.events['6'].ok,
  expect: nul({ automaticMin: 7, automaticMax: 8 }) });
C('C03_uncertain_resolved_not_full_covered', 'CP4 §3: uncertain resolved not_full with coverage leaves both min and max; flag auto-resolved -> 7, eligible, below (women 70-74 <10).', {
  spec: 'FFFFFUFF', mut: (s) => { U6(s); s.evidence.eventResolutions = { 6: 'not_full' }; },
  expect: ok(7, B, { conflict: false, automaticMin: 7, automaticMax: 7 }) });
C('C05_uncertain_resolved_cant_tell_covered', 'CP4 §3 max: uncertain cant_tell -> 7..8. AMBIGUOUS/spec problem: both ends are below (women 70-74 <10) so R6 would give a category, but CP4 §6 says uncertain_rises counts as checked only when every uncertain rise is resolved full/not_full, so a flag gate fails and R6 ("every other condition holds") cannot apply. Oracle follows the literal flag rule -> no category.', {
  spec: 'FFFFFUFF', mut: (s) => { U6(s); s.evidence.eventResolutions = { 6: 'cant_tell' }; },
  expect: nul({ automaticMin: 7, automaticMax: 8 }) });
C('C06_partial_resolved_full_covered_isolated', 'CP4 §3 min: partial resolved full with coverage counts (7 full + partial = 8). sessionScan null keeps the automatic basis blocked so this case tests only the range, independent of the identity-set question for promoted partials.', {
  spec: 'FFFFFFFP', mut: (s) => { s.evidence.eventResolutions = { 8: 'full' }; s.evidence.sessionScan = null; },
  covCheck: (c) => c.events['8'].ok,
  expect: nul({ automaticMin: 8, automaticMax: 8 }) });
C('C07_partial_resolved_full_covered_eligible', 'AMBIGUOUS: partial resolved full (coverage ok) becomes a counted stand; oracle interprets CP4 §2 identity row ("bound to the list of rises shown") as requiring it in identityConfirmedFor, which is supplied here -> eligible, 8.', {
  spec: 'FFFFFFFP', mut: (s) => { s.evidence.eventResolutions = { 8: 'full' }; s.evidence.identityConfirmedFor = [1, 2, 3, 4, 5, 6, 7, 8]; },
  expect: ok(8, B, { conflict: false, automaticMin: 8, automaticMax: 8 }) });
C('C08_partial_resolved_full_uncovered_ignored', 'CP4 §2: partial full resolution without coverage is ignored -> partial not counted (7). Partials are neither counted nor uncertain, so their missing anchor does not block identity -> eligible 7.', {
  spec: 'FFFFFFFP', del: [around(23700)],
  mut: (s) => { s.evidence.eventResolutions = { 8: 'full' }; },
  covCheck: (c) => !c.events['8'].ok && c.events['7'].ok && c.scan.ok,
  expect: ok(7, B, { conflict: false, automaticMin: 7, automaticMax: 7 }) });
C('C09_partial_resolved_cant_tell_R6', 'CP4 §3 max: partial cant_tell adds to max only -> 7..8; no uncertain rises so no auto flag; both ends below (women 70-74 <10) -> R6 category below, value null (v1 resolution 7), eligible.', {
  spec: 'FFFFFFFP', mut: (s) => { s.evidence.eventResolutions = { 8: 'cant_tell' }; },
  expect: { value: null, referenceEligible: true, category: B, conflict: false, automaticMin: 7, automaticMax: 8 } });
C('C10_full_resolved_not_full_covered', 'CP4 §3 min: counted rise 3 resolved not_full with coverage leaves min -> 7, eligible, below.', {
  mut: (s) => { s.evidence.eventResolutions = { 3: 'not_full' }; },
  expect: ok(7, B, { conflict: false, automaticMin: 7, automaticMax: 7 }) });
C('C11_full_resolved_not_full_uncovered', 'CP4 §2: not_full on rise 3 without coverage ignored -> min stays 8; rise 3 counted without anchor coverage -> identity gate blocked.', {
  del: [around(11900)], mut: (s) => { s.evidence.eventResolutions = { 3: 'not_full' }; },
  covCheck: (c) => !c.events['3'].ok,
  expect: nul({ automaticMin: 8, automaticMax: 8 }) });
C('C12_full_resolved_cant_tell_R6_below', 'CP4 §3 + R6: counted rise 3 cant_tell -> min 7, max 8 (v1 resolution 3); both below threshold 10 (women 70-74) -> category below, value null, eligible.', {
  mut: (s) => { s.evidence.eventResolutions = { 3: 'cant_tell' }; },
  expect: { value: null, referenceEligible: true, category: B, conflict: false, automaticMin: 7, automaticMax: 8 } });
C('C13_added_stand_covered_isolated', 'CP4 §3 min: observer-added stand at an image time (27300 is in imageTimes) counts -> 9. Reference observer_watched keeps automatic blocked so only the range is tested.', {
  mut: (s) => { s.evidence.added = [{ id: 'added-1', t: 27300 }]; s.result.reference.accepted = { basis: 'observer_watched' }; },
  covCheck: (c) => c.imageTimes.includes(27300),
  expect: nul({ automaticMin: 9, automaticMax: 9 }) });
C('C14_added_stand_uncovered_isolated', 'CP4 §2 "Adding a missed stand: exact": t=27310 is not an image time -> ignored, min stays 8.', {
  mut: (s) => { s.evidence.added = [{ id: 'added-1', t: 27310 }]; s.result.reference.accepted = { basis: 'observer_watched' }; },
  covCheck: (c) => !c.imageTimes.includes(27310),
  expect: nul({ automaticMin: 8, automaticMax: 8 }) });
C('C15_added_stand_covered_eligible', 'AMBIGUOUS: observer added a missed stand at an image time and then answered the scan no_missed (read as "no remaining missed stands"); added stands have no n, so identityConfirmedFor lists only machine rises. -> 9, eligible, below (9 < 10).', {
  mut: (s) => { s.evidence.added = [{ id: 'added-1', t: 27300 }]; },
  expect: ok(9, B, { conflict: false, automaticMin: 9, automaticMax: 9 }) });
C('C16_flags_auto_resolved_by_rises', 'CP4 §6: extension_unverifiable_view and uncertain_rises need no flagChecks; they count as checked because the only uncertain rise (6) is resolved not_full with coverage -> 7, eligible.', {
  spec: 'FFFFFUFF',
  mut: (s) => { s.result.reviewFlags = ['extension_unverifiable_view', 'uncertain_rises']; s.result.status = 'needs_review'; s.evidence.eventResolutions = { 6: 'not_full' }; },
  expect: ok(7, B, { conflict: false, automaticMin: 7, automaticMax: 7 }) });
C('C17_auto_flag_unresolved_uncertain', 'CP4 §6: extension_unverifiable_view is not satisfied while uncertain rise 6 is unresolved -> blocked; range 7..8.', {
  spec: 'FFFFFUFF',
  mut: (s) => { s.result.reviewFlags = ['extension_unverifiable_view', 'uncertain_rises']; s.result.status = 'needs_review'; },
  expect: nul({ automaticMin: 7, automaticMax: 8 }) });

// ===== D. Basis =====
C('D01_manual_equal_to_automatic', 'CP4 §3: supervisor count agrees with the eligible automatic value -> automatic value, no conflict.', {
  mut: (s) => { s.manual = { text: '8', reason: 'counted aloud' }; },
  expect: ok(8, B, { conflict: false }) });
C('D02_manual_differs_no_choice_conflict', 'CP4 §3: automatic eligible (8) and valid supervisor count (9) differ -> conflict, no value until a basis is chosen; neither side preferred.', {
  mut: (s) => { s.manual = { text: '9', reason: 'counted aloud' }; },
  expect: nul({ conflict: true }) });
C('D03_conflict_choice_automatic', 'CP4 §3: conflict resolved by explicit basisChoice automatic with rationale -> 8, eligible. (conflict flag after resolution not asserted: see notes.)', {
  mut: (s) => { s.manual = { text: '9', reason: 'counted aloud' }; s.basisChoice = { basis: 'automatic', rationale: 'reviewed images; rise 5 was a full stand' }; },
  expect: ok(8, B) });
C('D04_conflict_choice_supervisor', 'CP4 §3: conflict resolved by basisChoice supervisor with rationale -> supervisor count 9, eligible, below (9 < 10).', {
  mut: (s) => { s.manual = { text: '9', reason: 'counted aloud' }; s.basisChoice = { basis: 'supervisor', rationale: 'camera missed a stand I saw' }; },
  expect: ok(9, B) });
C('D05_conflict_choice_missing_rationale', 'CP4 §3 "with a rationale": basisChoice automatic with empty rationale is treated as no choice -> conflict unresolved, no value.', {
  mut: (s) => { s.manual = { text: '9', reason: 'counted aloud' }; s.basisChoice = { basis: 'automatic', rationale: '' }; },
  expect: nul({ conflict: true }) });
C('D06_conflict_choice_whitespace_rationale', 'AMBIGUOUS (by analogy with v1 resolution 9, whitespace reason invalid): whitespace-only rationale on basisChoice supervisor = no choice -> conflict unresolved.', {
  mut: (s) => { s.manual = { text: '9', reason: 'counted aloud' }; s.basisChoice = { basis: 'supervisor', rationale: '   ' }; },
  expect: nul({ conflict: true }) });
C('D08_supervisor_route_without_choice', 'CP4 §3: automatic not eligible (no images) and valid supervisor count, but no explicit "Use my own count" choice -> no value (v1 R5 auto-fallback removed). No conflict (automatic not eligible).', {
  mut: (s) => { noImages(s); s.evidence.identityConfirmed = null; s.manual = { text: '11', reason: 'counted aloud' }; },
  expect: nul({ conflict: false }) });
C('D09_supervisor_route_no_evidence_no_identity_no_reference', 'CP4 §3: supervisor route needs no identity answer and no images; reference null. Explicit choice + rationale -> 11, eligible; women 70-74 threshold 10 -> not below.', {
  mut: (s) => { noImages(s); s.result.reference = null; s.result.reviewFlags = ['no_practice_stand']; s.evidence.identityConfirmed = null; s.evidence.identityConfirmedFor = []; s.evidence.sessionScan = null; SUP(s, '11'); },
  expect: ok(11, NB, { conflict: false }) });
C('D10_invalid_manual_decimal_ignored', 'v1 R5 strict ^\\d{1,2}$: "9.0" is invalid -> no supervisor count -> no conflict; automatic value 8 used.', {
  mut: (s) => { s.manual = { text: '9.0', reason: 'counted aloud' }; },
  expect: ok(8, B, { conflict: false }) });
C('D11_invalid_manual_over_60', 'v1 R5 / CP4 §3 "strict 0-60 integer": "61" invalid -> supervisor route unavailable even with explicit choice; automatic not eligible (no images) -> no value.', {
  mut: (s) => { noImages(s); SUP(s, '61'); },
  expect: nul() });
C('D13_invalid_manual_missing_reason_no_conflict', 'CP4 §3 "integer plus reason": no reason -> invalid supervisor count -> cannot create a conflict; automatic 8 used.', {
  mut: (s) => { s.manual = { text: '9', reason: '' }; },
  expect: ok(8, B, { conflict: false }) });
C('D14_stopped_with_manual_and_choice', 'R1/R2 (unchanged): reason stopped -> stopped_early, value null; supervisor count only for a completed 30-s test (CP4 §3).', {
  mut: (s) => { s.result.reason = 'stopped'; s.result.status = 'stopped'; s.result.window.observedMs = 18000; s.result.events = s.result.events.slice(0, 5); s.evidence.identityConfirmedFor = [1, 2, 3, 4, 5]; SUP(s, '5'); },
  expect: nul() });
C('D15_page_hidden_full_evidence_with_manual', 'R1/R2: page_hidden -> interrupted; value null even with full evidence and a supervisor choice.', {
  mut: (s) => { s.result.reason = 'page_hidden'; s.result.status = 'incomplete'; s.result.window.observedMs = 21000; SUP(s, '8'); },
  expect: nul() });
C('D17_replay_manual_and_choice', 'AMBIGUOUS: R7 replay gate; CP4 §3 limits the supervisor count to a completed 30-s test, and a replay is not a live supervised test -> supervisor route unavailable, value null, never eligible (per task brief).', {
  mut: (s) => { s.source = 'replay'; noImages(s); SUP(s, '8'); },
  expect: nul({ mustIncludeBlockerKeywords: ['replay'] }) });
C('D18_expired_but_short_window_incomplete', 'R1 + CP4 §6 guard: expired with observedMs 29998 (< 29999) is not a completed 30-s test (v1 resolution 1) -> value null even with a supervisor choice.', {
  mut: (s) => { s.result.window.observedMs = 29998; SUP(s, '8'); },
  expect: nul() });
C('D19_withheld_supervisor_choice', 'v1 resolution 11: withheld + expired = completed but not measured; automatic unavailable; supervisor count with explicit choice -> 12, eligible, not below (women 70-74 <10).', {
  mut: (s) => { s.result.status = 'withheld'; s.result.events = []; s.evidence.identityConfirmedFor = []; noImages(s); SUP(s, '12'); },
  expect: ok(12, NB, { conflict: false }) });

// ===== E. Arm-use protocol zero =====
C('E01_arms_yes_stopped_protocol_zero', 'CDC "If the patient must use his/her arms to stand, stop the test. Record 0"; R1 arm override -> value 0, eligible (camera, setup yes, age 60-94, column) -> 0 < 10 below.', {
  mut: (s) => { s.observer.arms = 'yes'; s.result.reason = 'stopped'; s.result.status = 'stopped'; s.result.window.observedMs = 9000; s.result.events = s.result.events.slice(0, 1); s.evidence.identityConfirmedFor = [1]; },
  expect: ok(0, B) });
C('E02_arms_yes_overrides_expired_and_manual', 'R1 arm override "whatever the reason": expired with 8 counted rises and a supervisor choice of 8 -> still 0. AMBIGUOUS: CP4 does not restate precedence of arm rule over basisChoice; v1 R1 says whatever the reason.', {
  mut: (s) => { s.observer.arms = 'yes'; SUP(s, '8'); },
  expect: ok(0, B) });
C('E03_arms_yes_replay_not_eligible', 'R1 + R7: arm-rule zero on a replay: value 0 but replays are never compared.', {
  mut: (s) => { s.observer.arms = 'yes'; s.source = 'replay'; s.result.reason = 'stopped'; s.result.window.observedMs = 9000; },
  expect: { value: 0, referenceEligible: false, category: null, mustIncludeBlockerKeywords: ['replay'] } });
C('E04_arms_unsure_blocks_table', 'R7: arms unsure blocks table comparison; the value itself (automatic, all CP4 gates hold) is still reported.', {
  mut: (s) => { s.observer.arms = 'unsure'; },
  expect: { value: 8, referenceEligible: false, category: null, conflict: false, mustIncludeBlockerKeywords: ['arm'] } });

// ===== F. Float completion guard =====
C('F01_float_guard_completed', 'CP4 §6 note: completion treats observedMs >= 29999 as 30 s; 29999.999999999996 with reason expired -> completed_30s -> automatic 8 eligible.', {
  mut: (s) => { s.result.window.observedMs = 29999.999999999996; },
  expect: ok(8, B, { conflict: false }) });

// ===== G. R6 range category =====
C('G01_R6_not_below', 'R6 (unchanged) + CP4 §3: 12 full, rise 5 cant_tell -> 11..12; women 70-74 threshold 10 -> both not below -> category, value null, eligible.', {
  spec: 'FFFFFFFFFFFF', mut: (s) => { s.evidence.eventResolutions = { 5: 'cant_tell' }; },
  expect: { value: null, referenceEligible: true, category: NB, conflict: false, automaticMin: 11, automaticMax: 12 } });
C('G02_R6_range_straddles_threshold', 'R6: men 65-69 threshold 12; range 11..12 straddles (11 below, 12 not) -> no category, value null, not eligible.', {
  spec: 'FFFFFFFFFFFF', mut: (s) => { s.participant = { ageText: '67', column: 'men' }; s.evidence.eventResolutions = { 5: 'cant_tell' }; },
  expect: nul({ conflict: false, automaticMin: 11, automaticMax: 12 }) });
C('G03_R6_with_supervisor_count_conflict', 'AMBIGUOUS: range 7..8 would give R6 below, but a valid supervisor count (12) exists. Oracle treats an indeterminate automatic value as differing from any supervisor count -> conflict unresolved -> R6 not applied ("only with no unresolved conflict").', {
  mut: (s) => { s.evidence.eventResolutions = { 3: 'cant_tell' }; s.manual = { text: '12', reason: 'counted aloud' }; },
  expect: nul({ conflict: true, automaticMin: 7, automaticMax: 8 }) });

// ===== H. CDC table boundaries (sources/cdc/STEADI-Assessment-30Sec-508.txt) =====
const H = (id, age, col, text, expect, extra = '') => C(id, `CDC table "Below Average Scores" ${extra}; supervisor route (CP4 §3) with explicit choice, no images.`, {
  mut: (s) => { noImages(s); s.participant = { ageText: age, column: col }; SUP(s, text); }, expect });
H('H01_men_64_13_below', '64', 'men', '13', ok(13, B), 'row 60-64 men <14: 13 below');
H('H02_men_60_14_not_below', '60', 'men', '14', ok(14, NB), 'row 60-64 men <14: 14 not below');
H('H03_men_65_12_not_below', '65', 'men', '12', ok(12, NB), 'row 65-69 men <12: 12 not below (row change from 64)');
H('H05_women_94_3_below', '94', 'women', '3', ok(3, B), 'row 90-94 women <4: 3 below');
H('H06_women_90_4_not_below', '90', 'women', '4', ok(4, NB), 'row 90-94 women <4: 4 not below');
H('H07_age_95_out_of_table', '95', 'men', '12', { value: 12, referenceEligible: false, category: null, mustIncludeBlockerKeywords: ['age'] }, 'has no row above 94 (R7 no extrapolation); value still reported');
H('H08_age_leading_zero_070', '070', 'men', '11', ok(11, B), 'AMBIGUOUS (v1 resolution 10: "070" = 70); row 70-74 men <12: 11 below');
H('H09_column_missing', '72', '', '9', { value: 9, referenceEligible: false, category: null, mustIncludeBlockerKeywords: ['column'] }, 'needs men/women column (R7)');
C('H10_women_80_automatic_9_not_below', 'CDC row 80-84 women <9: automatic 9 (all CP4 gates hold) -> not below.', {
  spec: 'FFFFFFFFF', mut: (s) => { s.participant = { ageText: '80', column: 'women' }; },
  expect: ok(9, NB, { conflict: false, automaticMin: 9, automaticMax: 9 }) });
C('H11_setup_no_value_kept_not_eligible', 'R7: observer.setup no blocks the table; automatic value 8 still reported.', {
  mut: (s) => { s.observer.setup = 'no'; },
  expect: { value: 8, referenceEligible: false, category: null, conflict: false, mustIncludeBlockerKeywords: ['setup'] } });

for (const c of cases) if (c.why.includes('AMBIGUOUS') && !c.why.startsWith('AMBIGUOUS:')) c.why = 'AMBIGUOUS: ' + c.why.replace(/AMBIGUOUS(\/spec problem)?:?\s*/, '').replace(/\(\s*/, '(');
let txt = JSON.stringify(cases, null, 1);
txt = txt.replace(/\[\s*(-?[\d.]+(?:,\s*-?[\d.]+)*)\s*\]/g, (m, inner) => '[' + inner.split(/,\s*/).join(',') + ']');
writeFileSync(OUT, txt + '\n');
JSON.parse(txt);
console.log('cases', cases.length);
