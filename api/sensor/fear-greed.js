/**
 * POST /api/sensor/fear-greed
 *
 * Fear & Greed sensor. Pollt alternative.me/fng?limit=8, berekent score +
 * 24h-delta + 7d-trend slope. Classificeert regime in 5 banden + T+24u
 * falsifier.
 *
 * Bron: https://api.alternative.me/fng/?limit=8 (publiek, geen auth).
 *
 * Regime:
 *   EXTREME_FEAR   value < 25
 *   FEAR           25 ≤ value < 45
 *   NEUTRAL        45 ≤ value < 55
 *   GREED          55 ≤ value < 75
 *   EXTREME_GREED  value ≥ 75
 *
 * Cadence: dagelijks 04:00Z (Vercel cron `0 4 * * *`).
 *
 * Output: wiki/sensors/fear-greed.md.
 */

const WIKI_REPO = 'nestfriesland-ctrl/wiki';
const SENSOR_PATH = 'sensors/fear-greed.md';
const FNG_URL = 'https://api.alternative.me/fng/?limit=8';

function classifyRegime(value) {
  if (value < 25) return 'EXTREME_FEAR';
  if (value < 45) return 'FEAR';
  if (value < 55) return 'NEUTRAL';
  if (value < 75) return 'GREED';
  return 'EXTREME_GREED';
}

// Linear regression slope over indices 0..n-1 (oldest→newest).
function slope(values) {
  const n = values.length;
  if (n < 2) return null;
  const xs = Array.from({ length: n }, (_, i) => i);
  const meanX = xs.reduce((a, b) => a + b, 0) / n;
  const meanY = values.reduce((a, b) => a + b, 0) / n;
  let num = 0, den = 0;
  for (let i = 0; i < n; i++) {
    num += (xs[i] - meanX) * (values[i] - meanY);
    den += (xs[i] - meanX) ** 2;
  }
  return den === 0 ? null : num / den;
}

async function fetchFng() {
  const r = await fetch(FNG_URL, { headers: { 'User-Agent': 'pulse-fear-greed/1.0' } });
  if (!r.ok) throw new Error(`fng_${r.status}`);
  const j = await r.json();
  const data = j?.data;
  if (!Array.isArray(data) || data.length === 0) throw new Error('fng_no_data');
  // alternative.me returns newest-first. Map to { value, classification, ts }.
  return data.map(d => ({
    value: parseInt(d.value, 10),
    classification: d.value_classification,
    ts: parseInt(d.timestamp, 10),
    date: new Date(parseInt(d.timestamp, 10) * 1000).toISOString().slice(0, 10),
  }));
}

// ── Wiki I/O ──
async function loadPreviousMarkdown() {
  const PAT = process.env.GITHUB_PAT;
  if (!PAT) return null;
  const r = await fetch(`https://api.github.com/repos/${WIKI_REPO}/contents/${SENSOR_PATH}?ref=main`, {
    headers: { Authorization: `token ${PAT}`, Accept: 'application/vnd.github+json', 'User-Agent': 'pulse-fear-greed' },
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
    message: `sensor(fear-greed): ${new Date().toISOString().slice(0, 16)} dispatch`,
    content: Buffer.from(content, 'utf-8').toString('base64'),
    branch: 'main',
  };
  if (prevSha) body.sha = prevSha;
  const r = await fetch(`https://api.github.com/repos/${WIKI_REPO}/contents/${SENSOR_PATH}`, {
    method: 'PUT',
    headers: { Authorization: `token ${PAT}`, Accept: 'application/vnd.github+json', 'Content-Type': 'application/json', 'User-Agent': 'pulse-fear-greed' },
    body: JSON.stringify(body),
  });
  return r.ok;
}

function readCycleCountFromMd(md) {
  if (!md) return 0;
  const m = md.match(/^>\s*cycle_count:\s*(\d+)/m) || md.match(/^cycle_count:\s*(\d+)/m);
  return m ? parseInt(m[1], 10) : 0;
}

function fmtSlope(s) {
  if (s == null) return '—';
  return (s > 0 ? '+' : '') + s.toFixed(2);
}

function buildKrant({ value, classification, regime, delta24h, delta7dSlope, history }) {
  const trendWord = delta7dSlope == null ? 'onbepaald'
    : delta7dSlope > 0.5 ? 'oplopend'
    : delta7dSlope < -0.5 ? 'dalend'
    : 'plat';
  // T+24u falsifier — gebaseerd op regime-band.
  let falsifier;
  switch (regime) {
    case 'EXTREME_FEAR':
      falsifier = `Als waarde binnen 24u ≥45 noteert (uit Fear-band), is regime FOUT.`;
      break;
    case 'FEAR':
      falsifier = `Als waarde binnen 24u ≥55 (Greed-band) noteert, is regime FOUT.`;
      break;
    case 'NEUTRAL':
      falsifier = `Als waarde binnen 24u <45 of ≥55 noteert (uit Neutral-band), is regime FOUT.`;
      break;
    case 'GREED':
      falsifier = `Als waarde binnen 24u <45 (terug in Fear-band) noteert, is regime FOUT.`;
      break;
    case 'EXTREME_GREED':
      falsifier = `Als waarde binnen 24u <55 (uit Greed-band) noteert, is regime FOUT.`;
      break;
    default:
      falsifier = `Geen falsifier — regime onbekend.`;
  }

  return {
    stelling: `F&G ${value} (${classification}); delta_24h ${delta24h >= 0 ? '+' : ''}${delta24h}; 7d-slope ${fmtSlope(delta7dSlope)} (${trendWord}). Regime ${regime} blijft komende 24u; ${falsifier}`,
    bewijs: `Laatste 8d: ${history.slice().reverse().map(h => h.value).join(' → ')}. Class: ${classification}.`,
    les: regime === 'EXTREME_FEAR' || regime === 'EXTREME_GREED'
      ? 'Extreme-regimes zijn mean-revert kandidaten — drempels armed voor flip-detection.'
      : regime === 'NEUTRAL'
        ? 'Neutral-band is overgangs-state — een richting binnen 24u is geen ruis.'
        : `${regime}-regime houdt aan zolang slope-richting consistent blijft met value-niveau.`,
    actie: 'Geen actie — observatie. Sentiment is residu-signaal, niet entry-trigger.',
  };
}

function buildMarkdown({ history, now, cycleCount, value, classification, regime, delta24h, delta7dSlope, errors }) {
  const krant = buildKrant({ value, classification, regime, delta24h, delta7dSlope, history });

  const lines = [];
  lines.push(`# Fear & Greed Sensor — ${value}`);
  lines.push('');
  lines.push(`> last_updated: ${now}`);
  lines.push(`> last_attempted_at: ${now}`);
  lines.push(`> last_successful_at: ${now}`);
  lines.push('> freshness: 0');
  lines.push('> confidence: HARD');
  lines.push(`> regime: ${regime}`);
  lines.push(`> cycle_count: ${cycleCount}`);
  lines.push(`> value: ${value}`);
  lines.push(`> classification: ${classification}`);
  lines.push(`> delta_24h: ${delta24h}`);
  lines.push(`> delta_7d_slope: ${delta7dSlope != null ? delta7dSlope.toFixed(3) : 'null'}`);
  lines.push('');
  lines.push('## Trend (laatste 8 dagen)');
  lines.push('');
  lines.push('| Datum | Waarde | Class |');
  lines.push('|-------|--------|-------|');
  // Oldest -> newest
  for (const h of history.slice().reverse()) {
    lines.push(`| ${h.date} | ${h.value} | ${h.classification} |`);
  }
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
  lines.push('Bron: alternative.me/fng (?limit=8). Cadens dagelijks 04:00Z. Regime-banden: EXTREME_FEAR <25, FEAR 25-45, NEUTRAL 45-55, GREED 55-75, EXTREME_GREED ≥75. Delta_24h = today - yesterday. 7d-slope = OLS linear regression over 8 punten oudste→nieuwste.');
  if (errors && errors.length) {
    lines.push('');
    lines.push(`> errors: ${errors.join(' | ')}`);
  }
  return lines.join('\n');
}

// ── Main handler ──
async function runFearGreed(req) {
  const now = new Date().toISOString();
  const errors = [];

  const history = await fetchFng();
  // history[0] = newest, history[history.length-1] = oldest.
  const value = history[0].value;
  const classification = history[0].classification;
  const yesterday = history[1]?.value ?? value;
  const delta24h = value - yesterday;

  // Slope over oldest -> newest
  const slopeVals = history.slice().reverse().map(h => h.value);
  const delta7dSlope = slope(slopeVals);

  const regime = classifyRegime(value);

  // Cycle count from prior MD
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

  const md = buildMarkdown({ history, now, cycleCount, value, classification, regime, delta24h, delta7dSlope, errors });
  const written = await writeToWiki(md, prevSha).catch(e => { errors.push(`write:${e.message}`); return false; });

  return {
    regime, value, classification, delta24h, delta7dSlope, cycleCount, written, errors,
    trigger: req?.body?.trigger || 'manual',
  };
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  try {
    const result = await runFearGreed(req);
    return res.status(200).json(result);
  } catch (e) {
    return res.status(500).json({ error: 'fear_greed_crash', message: e?.message, stack: e?.stack });
  }
}
