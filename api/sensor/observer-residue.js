/**
 * POST /api/sensor/observer-residue
 *
 * Observer-residue sensor — leest wiki/observer/clickstream.jsonl en
 * aggregeert Mathijs's eigen aandacht-patroon op pulse (katern-views,
 * sensor-deeps, deep-ratio per katern, day-coverage). STRIKT OBSERVATIE —
 * geen feedback-loop terug naar andere sensors of UI.
 *
 * Regime-machine:
 *   BOOTSTRAP (n<200 OF window<14d) → ACTIVE
 *   ACTIVE → KANDIDAAT-VERWIJDERING (>30d zonder bevestigde/weerlegde claim)
 *
 * Als clickstream.jsonl niet bestaat: schrijf BOOTSTRAP met n=0 (geen crash).
 *
 * Cadence: dagelijks 04:30Z (Vercel cron `30 4 * * *`).
 *
 * Output: wiki/sensors/observer-residue.md.
 */

const WIKI_REPO = 'nestfriesland-ctrl/wiki';
const SENSOR_PATH = 'sensors/observer-residue.md';
const CLICKSTREAM_PATH = 'observer/clickstream.jsonl';

const WINDOW_DAYS = 14;
const N_THRESHOLD = 200;
const DAYS_30 = 30;

async function fetchWikiFile(path) {
  const PAT = process.env.GITHUB_PAT;
  if (!PAT) return null;
  const r = await fetch(`https://api.github.com/repos/${WIKI_REPO}/contents/${path}?ref=main`, {
    headers: { Authorization: `token ${PAT}`, Accept: 'application/vnd.github+json', 'User-Agent': 'pulse-observer-residue' },
  });
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`gh_${path}_${r.status}`);
  const j = await r.json();
  if (!j.content) return null;
  return { sha: j.sha, content: Buffer.from(j.content, 'base64').toString('utf-8') };
}

async function writeToWiki(content, prevSha) {
  const PAT = process.env.GITHUB_PAT;
  if (!PAT) return false;
  const body = {
    message: `sensor(observer-residue): ${new Date().toISOString().slice(0, 16)} dispatch`,
    content: Buffer.from(content, 'utf-8').toString('base64'),
    branch: 'main',
  };
  if (prevSha) body.sha = prevSha;
  const r = await fetch(`https://api.github.com/repos/${WIKI_REPO}/contents/${SENSOR_PATH}`, {
    method: 'PUT',
    headers: { Authorization: `token ${PAT}`, Accept: 'application/vnd.github+json', 'Content-Type': 'application/json', 'User-Agent': 'pulse-observer-residue' },
    body: JSON.stringify(body),
  });
  return r.ok;
}

// ── Clickstream parser ─────────────────────────────────────
function parseClickstream(text) {
  if (!text) return [];
  const events = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const e = JSON.parse(trimmed);
      if (e && typeof e === 'object' && e.ts && e.katern && e.action) {
        const t = Date.parse(e.ts);
        if (!Number.isNaN(t)) events.push({ ...e, _ts: t });
      }
    } catch (_) { /* skip malformed */ }
  }
  return events;
}

function aggregate(events) {
  const now = Date.now();
  const windowMs = WINDOW_DAYS * 24 * 60 * 60 * 1000;
  const cutoff = now - windowMs;
  const inWindow = events.filter(e => e._ts >= cutoff);

  // Katern-aggregaten
  const perKatern = {};
  for (const e of inWindow) {
    const k = e.katern;
    if (!perKatern[k]) perKatern[k] = { views: 0, deeps: 0, days: new Set() };
    perKatern[k].views += 1;
    if (e.sensor) perKatern[k].deeps += 1;
    perKatern[k].days.add(new Date(e._ts).toISOString().slice(0, 10));
  }

  // Window-span
  const tsList = inWindow.map(e => e._ts).sort();
  const spanMs = tsList.length ? tsList[tsList.length - 1] - tsList[0] : 0;
  const spanDays = spanMs / (24 * 60 * 60 * 1000);

  const rows = Object.entries(perKatern).map(([katern, agg]) => ({
    katern,
    views: agg.views,
    deeps: agg.deeps,
    deepRatio: agg.views > 0 ? agg.deeps / agg.views : null,
    dayCoverage: agg.days.size,
  })).sort((a, b) => b.views - a.views);

  return {
    nTotal: events.length,
    nWindow: inWindow.length,
    spanDays,
    rows,
  };
}

// ── Vorige state lezen voor regime + lifetime tracking ─────
function readPriorState(md) {
  if (!md) {
    return { cycleCount: 0, regime: 'BOOTSTRAP', firstActiveAt: null, lastClaimAt: null };
  }
  const fm = parseFrontmatter(md);
  return {
    cycleCount: parseInt(fm.cycle_count || '0', 10),
    regime: fm.regime || 'BOOTSTRAP',
    firstActiveAt: fm.first_active_at && fm.first_active_at !== 'never' ? fm.first_active_at : null,
    lastClaimAt: fm.last_claim_at && fm.last_claim_at !== 'never' ? fm.last_claim_at : null,
  };
}

function parseFrontmatter(md) {
  const out = {};
  if (!md) return out;
  const yaml = md.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (yaml) {
    for (const line of yaml[1].split(/\r?\n/)) {
      const m = line.match(/^([a-zA-Z_][a-zA-Z0-9_]*)\s*:\s*(.+)$/);
      if (m) out[m[1]] = m[2].trim();
    }
  }
  for (const line of md.split('\n').slice(0, 30)) {
    const m = line.match(/^>\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*:\s*(.+)$/);
    if (m && !(m[1] in out)) out[m[1]] = m[2].trim();
  }
  return out;
}

function classifyRegime(agg, prior, nowIso) {
  // BOOTSTRAP-criterium
  if (agg.nWindow < N_THRESHOLD || agg.spanDays < WINDOW_DAYS) {
    return { regime: 'BOOTSTRAP', firstActiveAt: prior.firstActiveAt };
  }
  // ACTIVE
  let firstActiveAt = prior.firstActiveAt || nowIso;
  // KANDIDAAT-VERWIJDERING als >30d ACTIVE zonder claim
  if (firstActiveAt) {
    const activeDays = (Date.now() - Date.parse(firstActiveAt)) / (24 * 60 * 60 * 1000);
    const lastClaimAge = prior.lastClaimAt ? (Date.now() - Date.parse(prior.lastClaimAt)) / (24 * 60 * 60 * 1000) : activeDays;
    if (activeDays > DAYS_30 && lastClaimAge > DAYS_30) {
      return { regime: 'KANDIDAAT-VERWIJDERING', firstActiveAt };
    }
  }
  return { regime: 'ACTIVE', firstActiveAt };
}

// ── Krant-synthese (alleen bij ACTIVE) ─────────────────────
function buildKrant({ regime, agg }) {
  if (regime === 'BOOTSTRAP') {
    return {
      stelling: `BOOTSTRAP — n=${agg.nWindow} events / span=${agg.spanDays.toFixed(1)}d (drempels: n≥${N_THRESHOLD}, window≥${WINDOW_DAYS}d). Sensor produceert nog geen falsifieerbare claim.`,
      bewijs: `Clickstream-totaal n=${agg.nTotal}; in-window n=${agg.nWindow}; window-span ${agg.spanDays.toFixed(1)}d.`,
      les: 'Drempels niet gehaald. Geen patroon-uitspraak mogelijk.',
      actie: 'Geen actie. Wacht.',
    };
  }

  // ACTIVE: synthese over katern-distributie
  const top = agg.rows[0];
  const lowDeep = agg.rows.filter(r => r.deepRatio != null && r.deepRatio < 0.2);
  const partial = agg.rows.filter(r => r.dayCoverage < WINDOW_DAYS / 2);
  return {
    stelling: top
      ? `Aandacht concentreert op '${top.katern}' (${top.views} views, deep-ratio ${(top.deepRatio || 0).toFixed(2)}); komend ${WINDOW_DAYS}d-window blijft top-katern stabiel (Δviews <30% en deep-ratio Δ <0.15). Falsifieerbaar bij top-katern-flip of deep-ratio swing >0.20.`
      : `Onvoldoende katern-data ondanks ACTIVE-regime.`,
    bewijs: agg.rows.slice(0, 5).map(r => `${r.katern}:v${r.views}/d${(r.deepRatio ?? 0).toFixed(2)}/cov${r.dayCoverage}`).join(' | '),
    les: lowDeep.length
      ? `Lage deep-ratio in ${lowDeep.length} katern(en) (${lowDeep.map(r => r.katern).join(', ')}) — surface-only attention.`
      : 'Alle katernen krijgen deep-engagement boven 0.20 — geen ruis-katern.',
    actie: partial.length
      ? `Partial-coverage in ${partial.length} katern(en) — afwachten op vollere window.`
      : 'Geen actie — observatie continueert.',
  };
}

// ── Markdown builder ───────────────────────────────────────
function buildMarkdown({ cycleCount, now, regime, firstActiveAt, agg, krant, errors }) {
  const lines = [];
  lines.push(`# Observer-Residue Sensor — cycle ${cycleCount}`);
  lines.push('');
  lines.push(`> last_updated: ${now}`);
  lines.push(`> last_attempted_at: ${now}`);
  lines.push(`> last_successful_at: ${now}`);
  lines.push('> freshness: 0');
  lines.push(`> confidence: ${regime === 'ACTIVE' ? 'HARD' : 'SOFT'}`);
  lines.push(`> regime: ${regime}`);
  lines.push(`> cycle_count: ${cycleCount}`);
  lines.push(`> n_events: ${agg.nWindow}`);
  lines.push(`> n_events_total: ${agg.nTotal}`);
  lines.push(`> window_days: ${WINDOW_DAYS}`);
  lines.push(`> window_span_days: ${agg.spanDays.toFixed(1)}`);
  lines.push(`> first_active_at: ${firstActiveAt || 'never'}`);
  lines.push('');
  lines.push(regime === 'BOOTSTRAP' ? '## Bootstrap' : '## Aggregaat');
  lines.push('');
  if (regime === 'BOOTSTRAP') {
    lines.push(`Onvoldoende observatie-window (n=${agg.nWindow} events, span=${agg.spanDays.toFixed(1)}d). Sensor produceert geen falsifieerbare stelling tot drempels n≥${N_THRESHOLD} EN window-span ≥${WINDOW_DAYS}d gehaald zijn.`);
  } else {
    lines.push(`n=${agg.nWindow} in-window events, span ${agg.spanDays.toFixed(1)}d over ${WINDOW_DAYS}d-fenster.`);
  }
  lines.push('');
  lines.push('| Katern | Views | Day-coverage | Deep-ratio |');
  lines.push('|--------|-------|--------------|------------|');
  for (const r of agg.rows) {
    lines.push(`| ${r.katern} | ${r.views} | ${r.dayCoverage}/${WINDOW_DAYS} | ${r.deepRatio != null ? r.deepRatio.toFixed(2) : '—'} |`);
  }
  if (!agg.rows.length) lines.push('| — | 0 | 0 | — |');
  lines.push('');
  lines.push('## Krant');
  lines.push('');
  lines.push(`**Stelling:** ${krant.stelling}`);
  lines.push(`**Bewijs:** ${krant.bewijs}`);
  lines.push(`**Les:** ${krant.les}`);
  lines.push(`**Actie:** ${krant.actie}`);
  lines.push('');
  lines.push('## Methodologie');
  lines.push('');
  lines.push(`Bron: wiki/observer/clickstream.jsonl (append-only events {katern, sensor, action, ts}). Cadens dagelijks. Window: laatste ${WINDOW_DAYS} dagen. BOOTSTRAP-drempels: n≥${N_THRESHOLD} EN window-span ≥${WINDOW_DAYS}d. STRIKT OBSERVATIE — geen feedback-loop, geen ranking, geen advies.`);
  if (errors && errors.length) {
    lines.push('');
    lines.push(`> errors: ${errors.join(' | ')}`);
  }
  return lines.join('\n');
}

// ── Main handler ───────────────────────────────────────────
async function runObserverResidue(req) {
  const now = new Date().toISOString();
  const errors = [];

  // Load prior MD
  const prevFile = await fetchWikiFile(SENSOR_PATH).catch(e => { errors.push(`prev:${e.message}`); return null; });
  const prior = readPriorState(prevFile?.content);
  const cycleCount = prior.cycleCount + 1;

  // Load clickstream — 404 → empty events
  let clickstream = null;
  try {
    clickstream = await fetchWikiFile(CLICKSTREAM_PATH);
  } catch (e) {
    errors.push(`clickstream:${e.message}`);
  }
  const events = clickstream ? parseClickstream(clickstream.content) : [];
  const agg = aggregate(events);

  const { regime, firstActiveAt } = classifyRegime(agg, prior, now);
  const krant = buildKrant({ regime, agg });

  const md = buildMarkdown({ cycleCount, now, regime, firstActiveAt, agg, krant, errors });
  const written = await writeToWiki(md, prevFile?.sha).catch(e => { errors.push(`write:${e.message}`); return false; });

  return {
    regime, cycleCount, written,
    nTotal: agg.nTotal, nWindow: agg.nWindow, spanDays: agg.spanDays,
    errors, trigger: req?.body?.trigger || 'manual',
  };
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  try {
    const result = await runObserverResidue(req);
    return res.status(200).json(result);
  } catch (e) {
    return res.status(500).json({ error: 'observer_residue_crash', message: e?.message, stack: e?.stack });
  }
}
