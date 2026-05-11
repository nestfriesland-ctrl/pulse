/**
 * POST /api/sensor/nest-seo
 *
 * Nest-SEO sensor — pollt Ahrefs API v3 voor domain-rating + refdomains
 * voor www.nest.frl. Berekent 7d delta in DR en refdomain-net.
 *
 * Regime:
 *   GROWING   DR-delta-7d > 0 OF refdomains-net-7d > 0
 *   PLATEAU   beide stabiel (delta = 0 binnen rounding)
 *   DECLINING DR-delta-7d < 0 OF refdomains-net-7d < 0
 *
 * Preflight: GET /v3/subscription-info → 200 check vóór hoofdcalls.
 *
 * Cadence: dagelijks 06:00Z (Vercel cron `0 6 * * *`).
 *
 * Output: wiki/sensors/nest-seo.md.
 *
 * Blocker: AHREFS_API_KEY env-var verplicht. Bij ontbreken — runner schrijft
 * BLOCKED-state, geen API-call.
 */

const WIKI_REPO = 'nestfriesland-ctrl/wiki';
const SENSOR_PATH = 'sensors/nest-seo.md';
const TARGET = 'www.nest.frl';
const AHREFS_BASE = 'https://api.ahrefs.com/v3';

// ── Ahrefs helpers ─────────────────────────────────────────
async function ahrefsGet(path, key) {
  const r = await fetch(`${AHREFS_BASE}${path}`, {
    headers: { Authorization: `Bearer ${key}`, Accept: 'application/json', 'User-Agent': 'pulse-nest-seo/1.0' },
  });
  if (!r.ok) throw new Error(`ahrefs_${path}_${r.status}`);
  return r.json();
}

async function preflight(key) {
  return ahrefsGet('/subscription-info/limits-and-usage', key);
}

async function fetchDomainRating(key) {
  // Ahrefs v3: GET /site-explorer/domain-rating?target=<target>
  // Output shape: { domain_rating: { domain_rating: number }, ... }
  return ahrefsGet(`/site-explorer/domain-rating?target=${encodeURIComponent(TARGET)}&date=${todayIso()}&protocol=both`, key);
}

async function fetchRefDomains(key) {
  // GET /site-explorer/refdomains-count?target=<target>
  return ahrefsGet(`/site-explorer/refdomains?target=${encodeURIComponent(TARGET)}&select=domain&limit=1&where=%7B%22field%22%3A%22is_dofollow%22%2C%22is%22%3A%5B%22eq%22%2C1%5D%7D&protocol=both`, key);
}

async function fetchMetricsSummary(key) {
  // /site-explorer/metrics-history voor 7d-trend
  // Bij netwerk-fout: laat caller catchen
  return ahrefsGet(`/site-explorer/metrics-history?target=${encodeURIComponent(TARGET)}&volume_mode=monthly&history_grouping=daily&date_from=${dateNDaysAgo(7)}&date_to=${todayIso()}&protocol=both`, key);
}

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}
function dateNDaysAgo(n) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
}

// ── Wiki I/O ───────────────────────────────────────────────
async function loadPreviousMarkdown() {
  const PAT = process.env.GITHUB_PAT;
  if (!PAT) return null;
  const r = await fetch(`https://api.github.com/repos/${WIKI_REPO}/contents/${SENSOR_PATH}?ref=main`, {
    headers: { Authorization: `token ${PAT}`, Accept: 'application/vnd.github+json', 'User-Agent': 'pulse-nest-seo' },
  });
  if (!r.ok) return null;
  const j = await r.json();
  if (!j.content) return null;
  return { sha: j.sha, content: Buffer.from(j.content, 'base64').toString('utf-8') };
}

async function writeToWiki(content, prevSha) {
  const PAT = process.env.GITHUB_PAT;
  if (!PAT) return false;
  const body = {
    message: `sensor(nest-seo): ${new Date().toISOString().slice(0, 16)} dispatch`,
    content: Buffer.from(content, 'utf-8').toString('base64'),
    branch: 'main',
  };
  if (prevSha) body.sha = prevSha;
  const r = await fetch(`https://api.github.com/repos/${WIKI_REPO}/contents/${SENSOR_PATH}`, {
    method: 'PUT',
    headers: { Authorization: `token ${PAT}`, Accept: 'application/vnd.github+json', 'Content-Type': 'application/json', 'User-Agent': 'pulse-nest-seo' },
    body: JSON.stringify(body),
  });
  return r.ok;
}

function readCycleCountFromMd(md) {
  if (!md) return 0;
  const m = md.match(/^>\s*cycle_count:\s*(\d+)/m) || md.match(/^cycle_count:\s*(\d+)/m);
  return m ? parseInt(m[1], 10) : 0;
}

// ── Regime ─────────────────────────────────────────────────
function classifyRegime({ drDelta7d, refdomainsNet7d }) {
  if (drDelta7d == null && refdomainsNet7d == null) return 'UNKNOWN';
  const drUp = drDelta7d != null && drDelta7d > 0;
  const drDown = drDelta7d != null && drDelta7d < 0;
  const rdUp = refdomainsNet7d != null && refdomainsNet7d > 0;
  const rdDown = refdomainsNet7d != null && refdomainsNet7d < 0;
  if (drUp || rdUp) return 'GROWING';
  if (drDown || rdDown) return 'DECLINING';
  return 'PLATEAU';
}

function buildKrant({ dr, refdomains, drDelta7d, refdomainsNet7d, regime, blocked, blockReason }) {
  if (blocked) {
    return {
      stelling: `BLOCKED — ${blockReason}. Sensor schrijft regime BLOCKED zonder data; preflight niet uitvoerbaar.`,
      bewijs: `Geen Ahrefs-call gedaan.`,
      les: 'Sensor zonder credentials levert geen falsifieerbare claim.',
      actie: 'Voeg AHREFS_API_KEY toe aan Vercel pulse-env.',
    };
  }

  const horizon = '7d';
  const falsifier = regime === 'GROWING'
    ? `Als binnen ${horizon} DR daalt EN refdomains-net <0 wordt, is regime FOUT.`
    : regime === 'DECLINING'
      ? `Als binnen ${horizon} DR stijgt OF refdomains-net >0 wordt, is regime FOUT.`
      : `Als binnen ${horizon} ofwel DR-delta >|0.2| ofwel refdomains-net ≠ 0, is regime FOUT.`;

  return {
    stelling: `DR ${dr ?? '—'} (Δ7d ${drDelta7d != null ? (drDelta7d > 0 ? '+' : '') + drDelta7d.toFixed(2) : '—'}); refdomains ${refdomains ?? '—'} (net Δ7d ${refdomainsNet7d != null ? (refdomainsNet7d > 0 ? '+' : '') + refdomainsNet7d : '—'}). Regime ${regime}. ${falsifier}`,
    bewijs: `Bron: Ahrefs v3 site-explorer/${TARGET}. DR-delta over 7d-history, refdomains via current snapshot vs 7d prior.`,
    les: regime === 'GROWING'
      ? 'Groei zonder dofollow editorial ≥DR50 is fragiel — controleer of nieuwe refdomains nofollow PBN zijn.'
      : regime === 'DECLINING'
        ? 'Daling kan PBN-drop, disavow, of authority-loss zijn — controleer welke kant van de balans schuift.'
        : 'Plateau is verwacht-state zonder outreach — alleen dofollow editorial verschuift de naald.',
    actie: 'Geen sensor-actie; outreach-pipeline blijft enige meaningful next-step.',
  };
}

function buildMarkdown({ now, cycleCount, dr, refdomains, drDelta7d, refdomainsNet7d, regime, blocked, blockReason, errors }) {
  const krant = buildKrant({ dr, refdomains, drDelta7d, refdomainsNet7d, regime, blocked, blockReason });
  const lines = [];
  lines.push('# Nest-SEO');
  lines.push('');
  lines.push(`> last_updated: ${now}`);
  lines.push(`> last_attempted_at: ${now}`);
  lines.push(`> last_successful_at: ${blocked ? 'never' : now}`);
  lines.push('> freshness: 0');
  lines.push(`> confidence: ${blocked ? 'SOFT' : 'HARD'}`);
  lines.push(`> regime: ${regime}`);
  lines.push(`> cycle_count: ${cycleCount}`);
  lines.push(`> dr: ${dr ?? '—'}`);
  lines.push(`> refdomains_live: ${refdomains ?? '—'}`);
  lines.push(`> dr_delta_7d: ${drDelta7d != null ? drDelta7d.toFixed(2) : '—'}`);
  lines.push(`> refdomains_net_7d: ${refdomainsNet7d ?? '—'}`);
  lines.push(`> blocked: ${blocked}`);
  lines.push('');
  lines.push('## Scorebord');
  lines.push('');
  if (blocked) {
    lines.push(`> BLOCKED: ${blockReason}`);
    lines.push('');
  } else {
    lines.push(`DR: ${dr ?? '—'} (Δ7d ${drDelta7d != null ? (drDelta7d > 0 ? '+' : '') + drDelta7d.toFixed(2) : '—'}) [HARD]`);
    lines.push(`Refdomains (dofollow live): ${refdomains ?? '—'} (net Δ7d ${refdomainsNet7d != null ? (refdomainsNet7d > 0 ? '+' : '') + refdomainsNet7d : '—'}) [HARD]`);
    lines.push('');
  }
  lines.push('## Krant');
  lines.push('');
  lines.push(`**Stelling:** ${krant.stelling}`);
  lines.push(`**Bewijs:** ${krant.bewijs}`);
  lines.push(`**Les:** ${krant.les}`);
  lines.push(`**Actie:** ${krant.actie}`);
  lines.push('');
  lines.push('## Methodologie');
  lines.push('');
  lines.push(`Bron: Ahrefs API v3 (Bearer AHREFS_API_KEY). Targets: ${TARGET}. Preflight: /subscription-info/limits-and-usage (200-check). Datapoints: domain-rating (snapshot), refdomains dofollow (count), metrics-history (7d). Cadens dagelijks 06:00Z.`);
  lines.push(`Regime-rules: GROWING bij DR-Δ7d >0 OF refdomains-net >0; DECLINING bij DR-Δ7d <0 OF refdomains-net <0; PLATEAU anders.`);
  if (errors && errors.length) {
    lines.push('');
    lines.push(`> errors: ${errors.join(' | ')}`);
  }
  return lines.join('\n');
}

// ── Response parsing helpers (defensive — schemas may shift) ─
function extractDr(jsonResponse) {
  if (!jsonResponse) return null;
  const dr = jsonResponse?.domain_rating?.domain_rating;
  if (typeof dr === 'number') return dr;
  if (typeof jsonResponse?.domain_rating === 'number') return jsonResponse.domain_rating;
  return null;
}

function extractRefdomainsCount(jsonResponse) {
  if (!jsonResponse) return null;
  // refdomains list endpoint geeft `total` + `refdomains` array.
  if (typeof jsonResponse?.total === 'number') return jsonResponse.total;
  if (Array.isArray(jsonResponse?.refdomains)) return jsonResponse.refdomains.length;
  return null;
}

function deriveDeltasFromHistory(history) {
  if (!history) return { drDelta7d: null, refdomainsNet7d: null };
  const series = history?.metrics_history || history?.history || [];
  if (!Array.isArray(series) || series.length < 2) return { drDelta7d: null, refdomainsNet7d: null };
  const oldest = series[0];
  const newest = series[series.length - 1];
  const drOld = oldest?.domain_rating ?? null;
  const drNew = newest?.domain_rating ?? null;
  const rdOld = oldest?.refdomains_dofollow ?? oldest?.refdomains ?? null;
  const rdNew = newest?.refdomains_dofollow ?? newest?.refdomains ?? null;
  return {
    drDelta7d: (drOld != null && drNew != null) ? (drNew - drOld) : null,
    refdomainsNet7d: (rdOld != null && rdNew != null) ? (rdNew - rdOld) : null,
  };
}

// ── Main handler ───────────────────────────────────────────
async function runNestSeo(req) {
  const now = new Date().toISOString();
  const errors = [];

  const key = process.env.AHREFS_API_KEY;

  let cycleCount = 1;
  let prevSha = null;
  try {
    const prev = await loadPreviousMarkdown();
    if (prev) {
      prevSha = prev.sha;
      cycleCount = readCycleCountFromMd(prev.content) + 1;
    }
  } catch (e) {
    errors.push(`prev:${e.message}`);
  }

  if (!key) {
    const md = buildMarkdown({
      now, cycleCount,
      dr: null, refdomains: null, drDelta7d: null, refdomainsNet7d: null,
      regime: 'BLOCKED', blocked: true,
      blockReason: 'AHREFS_API_KEY ontbreekt in pulse Vercel env',
      errors,
    });
    const written = await writeToWiki(md, prevSha).catch(() => false);
    return { regime: 'BLOCKED', blocked: true, cycleCount, written, errors: [...errors, 'AHREFS_API_KEY missing'] };
  }

  // Preflight
  try {
    await preflight(key);
  } catch (e) {
    errors.push(`preflight:${e.message}`);
    const md = buildMarkdown({
      now, cycleCount,
      dr: null, refdomains: null, drDelta7d: null, refdomainsNet7d: null,
      regime: 'BLOCKED', blocked: true,
      blockReason: `preflight failed: ${e.message}`,
      errors,
    });
    const written = await writeToWiki(md, prevSha).catch(() => false);
    return { regime: 'BLOCKED', blocked: true, cycleCount, written, errors };
  }

  let dr = null, refdomains = null, drDelta7d = null, refdomainsNet7d = null;
  try {
    const drResp = await fetchDomainRating(key);
    dr = extractDr(drResp);
  } catch (e) { errors.push(`dr:${e.message}`); }

  try {
    const rdResp = await fetchRefDomains(key);
    refdomains = extractRefdomainsCount(rdResp);
  } catch (e) { errors.push(`refdomains:${e.message}`); }

  try {
    const hist = await fetchMetricsSummary(key);
    const deltas = deriveDeltasFromHistory(hist);
    drDelta7d = deltas.drDelta7d;
    refdomainsNet7d = deltas.refdomainsNet7d;
  } catch (e) { errors.push(`history:${e.message}`); }

  const regime = classifyRegime({ drDelta7d, refdomainsNet7d });

  const md = buildMarkdown({
    now, cycleCount, dr, refdomains, drDelta7d, refdomainsNet7d,
    regime, blocked: false, blockReason: null, errors,
  });
  const written = await writeToWiki(md, prevSha).catch(e => { errors.push(`write:${e.message}`); return false; });

  return { regime, dr, refdomains, drDelta7d, refdomainsNet7d, cycleCount, written, errors, trigger: req?.body?.trigger || 'manual' };
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  try {
    const result = await runNestSeo(req);
    return res.status(200).json(result);
  } catch (e) {
    return res.status(500).json({ error: 'nest_seo_crash', message: e?.message, stack: e?.stack });
  }
}
