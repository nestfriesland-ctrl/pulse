/**
 * POST /api/sensor/watchlist
 *
 * Watchlist sensor — Kraken spot voor 8 assets, vergelijkt tegen user-edited
 * levels in wiki/sensors/watchlist.md.
 *
 * Sensor herschrijft alleen frontmatter + AUTO-blok (scorebord + krant). De
 * user-edited secties (## Levels, ## Notes) blijven intact. Niveaus worden
 * uit een `## Levels` blok geparsed met regels van het patroon:
 *   - BTC: stop=80200, approach=80500, target=85000
 * (alle waarden optioneel). Eerste run zonder Levels-blok: sensor maakt
 * placeholder aan, regime = NEUTRAL.
 *
 * Regime per asset:
 *   LEVEL_HIT         — spot ≤ stop  (long-stops) of ≥ target
 *   LEVEL_APPROACHING — spot binnen 1% van stop of target
 *   NEUTRAL           — anders
 *
 * Aggregaat: ≥1 HIT = LEVEL_HIT, ≥1 APPROACHING = LEVEL_APPROACHING, anders NEUTRAL.
 *
 * Cadens: 1u.
 */

const WIKI_REPO = 'nestfriesland-ctrl/wiki';
const SENSOR_PATH = 'sensors/watchlist.md';

const ASSETS = [
  { sym: 'BTC', pair: 'XBTUSD' },
  { sym: 'ETH', pair: 'ETHUSD' },
  { sym: 'SOL', pair: 'SOLUSD' },
  { sym: 'ZEC', pair: 'ZECUSD' },
  { sym: 'HYPE', pair: 'HYPEUSD' },
  { sym: 'TAO', pair: 'TAOUSD' },
  { sym: 'FET', pair: 'FETUSD' },
  { sym: 'PUMP', pair: 'PUMPUSD' },
];

const APPROACH_PCT = 0.01; // 1%

const CAP_KOP = 90;
const CAP_STELLING = 240;
const CAP_BEWIJS = 140;
const CAP_LES = 140;
const CAP_ACTIE = 140;

const HTTP_TIMEOUT_MS = 8000;

const AUTO_START = '<!-- BEGIN_AUTO -->';
const AUTO_END = '<!-- END_AUTO -->';

async function timedFetch(url, opts = {}) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS);
  try { return await fetch(url, { ...opts, signal: controller.signal }); }
  finally { clearTimeout(id); }
}

async function krakenTicker(pair) {
  const r = await timedFetch(`https://api.kraken.com/0/public/Ticker?pair=${pair}`);
  if (!r.ok) throw new Error(`kraken_${pair}_${r.status}`);
  const j = await r.json();
  if (j.error?.length) throw new Error(`kraken_${pair}_${j.error[0]}`);
  const key = Object.keys(j.result || {})[0];
  const t = j.result?.[key];
  if (!t) throw new Error(`kraken_${pair}_no_data`);
  return {
    last: parseFloat(t.c[0]),
    high24h: parseFloat(t.h[1]),
    low24h: parseFloat(t.l[1]),
    open24h: parseFloat(t.o),
    vol24h: parseFloat(t.v[1]),
  };
}

// ── Levels parser ─────────────────────────────────────────────
// Format expected: `- BTC: stop=80200, approach=80500, target=85000`
function parseLevels(md) {
  if (!md) return {};
  const m = md.match(/##\s+Levels[\s\S]*?(?=\n##\s|\n<!--|$)/);
  if (!m) return {};
  const lines = m[0].split('\n');
  const levels = {};
  for (const line of lines) {
    const lm = line.match(/^\s*-\s*([A-Z]+)\s*:\s*(.+)$/);
    if (!lm) continue;
    const sym = lm[1];
    const rest = lm[2];
    const entry = {};
    for (const part of rest.split(',')) {
      const pm = part.trim().match(/^(stop|approach|target)\s*=\s*([0-9.]+)$/i);
      if (pm) entry[pm[1].toLowerCase()] = parseFloat(pm[2]);
    }
    if (Object.keys(entry).length) levels[sym] = entry;
  }
  return levels;
}

function classifyAsset(spot, levels) {
  if (!levels || spot == null) return { regime: 'NEUTRAL', detail: 'no_levels' };
  const { stop, approach, target } = levels;
  if (stop != null && spot <= stop) return { regime: 'LEVEL_HIT', detail: `spot ${spot} ≤ stop ${stop}` };
  if (target != null && spot >= target) return { regime: 'LEVEL_HIT', detail: `spot ${spot} ≥ target ${target}` };
  if (stop != null && spot <= stop * (1 + APPROACH_PCT)) return { regime: 'LEVEL_APPROACHING', detail: `spot ${spot} near stop ${stop}` };
  if (target != null && spot >= target * (1 - APPROACH_PCT)) return { regime: 'LEVEL_APPROACHING', detail: `spot ${spot} near target ${target}` };
  return { regime: 'NEUTRAL', detail: `spot ${spot} within band` };
}

function aggregateRegime(perAsset) {
  const regs = Object.values(perAsset).map(a => a.regime);
  if (regs.includes('LEVEL_HIT')) return 'LEVEL_HIT';
  if (regs.includes('LEVEL_APPROACHING')) return 'LEVEL_APPROACHING';
  return 'NEUTRAL';
}

// ── Wiki I/O ──────────────────────────────────────────────────
async function loadPreviousMarkdown() {
  const PAT = process.env.GITHUB_PAT;
  if (!PAT) return null;
  const r = await fetch(`https://api.github.com/repos/${WIKI_REPO}/contents/${SENSOR_PATH}?ref=main`, {
    headers: { Authorization: `token ${PAT}`, Accept: 'application/vnd.github+json', 'User-Agent': 'pulse-watchlist' },
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
    message: `sensor(watchlist): ${new Date().toISOString().slice(0, 16)} dispatch`,
    content: Buffer.from(content, 'utf-8').toString('base64'),
    branch: 'main',
  };
  if (prevSha) body.sha = prevSha;
  const r = await fetch(`https://api.github.com/repos/${WIKI_REPO}/contents/${SENSOR_PATH}`, {
    method: 'PUT',
    headers: { Authorization: `token ${PAT}`, Accept: 'application/vnd.github+json', 'Content-Type': 'application/json', 'User-Agent': 'pulse-watchlist' },
    body: JSON.stringify(body),
  });
  return r.ok;
}

function readCycleCountFromMd(md) {
  if (!md) return 0;
  const m = md.match(/^cycle_count:\s*(\d+)/m);
  return m ? parseInt(m[1], 10) : 0;
}

// Extract preserved user content: everything outside frontmatter+AUTO block.
function extractUserSections(md) {
  if (!md) return null;
  // Strip frontmatter (between first two `---` lines at top)
  let body = md;
  const fmMatch = body.match(/^---\n[\s\S]*?\n---\n?/);
  if (fmMatch) body = body.slice(fmMatch[0].length);
  // Remove AUTO block if present
  const autoStart = body.indexOf(AUTO_START);
  const autoEnd = body.indexOf(AUTO_END);
  if (autoStart !== -1 && autoEnd !== -1 && autoEnd > autoStart) {
    body = body.slice(0, autoStart) + body.slice(autoEnd + AUTO_END.length);
  }
  return body.trim();
}

function cap(s, n) { return s == null ? '' : (s.length <= n ? s : s.slice(0, n - 1) + '…'); }
function fmt(n, d = 2) { return n == null || Number.isNaN(n) ? '—' : Number(n).toFixed(d); }

function buildKrant({ regime, hitList, approachList, totalCount }) {
  const verb = regime === 'LEVEL_HIT' ? 'raakt levels' : regime === 'LEVEL_APPROACHING' ? 'nadert levels' : 'blijft binnen band';
  const kop = cap(`Watchlist ${verb} — ${hitList.length} HIT, ${approachList.length} APPROACH (${totalCount} assets).`, CAP_KOP);

  const stelling = cap(
    `Komend uur: regime ${regime} blijft stabiel als ${hitList.length || 'geen'} HIT en ${approachList.length || 'geen'} APPROACH ongewijzigd; flip bij overschrijding van levels (zie ## Levels).`,
    CAP_STELLING,
  );

  const bewijs = cap(
    hitList.length
      ? `HIT: ${hitList.join(', ')}. APPROACH: ${approachList.join(', ') || '-'}.`
      : approachList.length
        ? `APPROACH: ${approachList.join(', ')}.`
        : `Alle ${totalCount} assets binnen band; geen level overschreden.`,
    CAP_BEWIJS,
  );

  const les = cap(
    regime === 'LEVEL_HIT'
      ? 'Stop/target getriggerd — uitvoeren volgens user-edited actieplan in deze file.'
      : regime === 'LEVEL_APPROACHING'
        ? 'Naderingen vragen alert; geen actie tot HIT.'
        : 'Geen niveau geraakt; user-edited Krant heeft eindoordeel.',
    CAP_LES,
  );

  const actie = cap(
    regime === 'LEVEL_HIT'
      ? 'Voer stop/target-actie uit (zie user-Krant); update Levels-blok na uitvoering.'
      : 'Geen sensor-actie; observeer.',
    CAP_ACTIE,
  );

  return { kop, stelling, bewijs, les, actie };
}

function buildMarkdown({
  cycleCount, lastAttemptedAt, lastSuccessfulAt,
  regime, perAsset, prices, levels, errors, preservedBody,
}) {
  const totalCount = Object.keys(perAsset).length;
  const hitList = Object.entries(perAsset).filter(([, v]) => v.regime === 'LEVEL_HIT').map(([k]) => k);
  const approachList = Object.entries(perAsset).filter(([, v]) => v.regime === 'LEVEL_APPROACHING').map(([k]) => k);
  const krant = buildKrant({ regime, hitList, approachList, totalCount });

  const frontmatter = [
    '---',
    'sensor: watchlist',
    `regime: ${regime}`,
    `last_attempted_at: ${lastAttemptedAt}`,
    `last_successful_at: ${lastSuccessfulAt || 'never'}`,
    `last_updated: ${lastAttemptedAt}`,
    'freshness: 0',
    'confidence: HARD',
    `cycle_count: ${cycleCount}`,
    `assets_tracked: ${totalCount}`,
    `hits: ${hitList.length}`,
    `approaches: ${approachList.length}`,
    `levels_defined: ${Object.keys(levels).length}`,
    '---',
  ].join('\n');

  const scorebord = [
    AUTO_START,
    '',
    '# Watchlist',
    '',
    `> Run ${cycleCount} — ${lastAttemptedAt}. Regime: **${regime}** (${hitList.length} HIT, ${approachList.length} APPROACH, ${totalCount - hitList.length - approachList.length} NEUTRAL).`,
    '',
    '## Scorebord',
    '',
    '| Asset | Spot | 24h Low | 24h High | Open24h | Vol24h | Regime | Detail |',
    '|-------|------|---------|----------|---------|--------|--------|--------|',
    ...ASSETS.map(({ sym }) => {
      const p = prices[sym];
      const cls = perAsset[sym] || { regime: 'NEUTRAL', detail: 'no_data' };
      return `| ${sym} | ${p ? '$' + fmt(p.last, p.last < 1 ? 6 : 2) : '—'} | ${p ? '$' + fmt(p.low24h, p.low24h < 1 ? 6 : 2) : '—'} | ${p ? '$' + fmt(p.high24h, p.high24h < 1 ? 6 : 2) : '—'} | ${p ? '$' + fmt(p.open24h, p.open24h < 1 ? 6 : 2) : '—'} | ${p ? fmt(p.vol24h, 2) : '—'} | ${cls.regime} | ${cls.detail} |`;
    }),
    '',
    '## Krant (sensor)',
    '',
    `**Kop:** ${krant.kop}`,
    `**Stelling:** ${krant.stelling}`,
    `**Bewijs:** ${krant.bewijs}`,
    `**Les:** ${krant.les}`,
    `**Actie:** ${krant.actie}`,
    '',
    '## Methodologie',
    '',
    `Bronnen: Kraken Ticker voor 8 assets (BTC/ETH/SOL/ZEC/HYPE/TAO/FET/PUMP). Cadens 1u. Levels uit user-edited ## Levels-blok (format \`- ASSET: stop=N, approach=N, target=N\`).`,
    `Regime per asset: LEVEL_HIT = spot ≤ stop of ≥ target; LEVEL_APPROACHING = spot binnen ${APPROACH_PCT * 100}% van stop/target; anders NEUTRAL. Aggregaat: ≥1 HIT = LEVEL_HIT, anders ≥1 APPROACHING.`,
    errors && errors.length ? `\n> errors: ${errors.join(' | ')}` : '',
    '',
    AUTO_END,
  ].filter(l => l !== '').join('\n');

  // Compose: frontmatter, AUTO block, then preserved user content (incl. ## Levels)
  let userPart = preservedBody;
  if (!userPart || !userPart.includes('## Levels')) {
    const placeholder = [
      '',
      '## Levels',
      '',
      'User-edited stop/target levels per asset. Format:',
      '`- ASSET: stop=NUM, approach=NUM, target=NUM` (alle velden optioneel).',
      '',
      ...ASSETS.map(({ sym }) => `- ${sym}: `),
      '',
      '## Notes',
      '',
      '_User-edited longform analyse — sensor raakt deze sectie niet aan._',
    ].join('\n');
    userPart = (userPart ? userPart + '\n\n' : '') + placeholder;
  }

  return [frontmatter, '', scorebord, '', userPart].join('\n');
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const lastAttemptedAt = new Date().toISOString();

  let cycleCount = 1;
  let prevSha = null;
  let lastSuccessfulAt = null;
  let levels = {};
  let preservedBody = null;

  try {
    const prev = await loadPreviousMarkdown();
    if (prev) {
      prevSha = prev.sha;
      cycleCount = readCycleCountFromMd(prev.content) + 1;
      const lsa = prev.content.match(/^last_successful_at:\s*([^\n]+)/m);
      if (lsa && lsa[1].trim() !== 'never') lastSuccessfulAt = lsa[1].trim();
      levels = parseLevels(prev.content);
      preservedBody = extractUserSections(prev.content);
    }
  } catch (_) { /* first run */ }

  const errors = [];
  const safe = async (label, p) => {
    try { return await p; }
    catch (e) { errors.push(`${label}:${e.message}`); return null; }
  };

  const tickerResults = await Promise.all(
    ASSETS.map(({ sym, pair }) => safe(sym, krakenTicker(pair)).then(t => [sym, t])),
  );

  const prices = Object.fromEntries(tickerResults);
  const perAsset = {};
  for (const { sym } of ASSETS) {
    perAsset[sym] = classifyAsset(prices[sym]?.last, levels[sym]);
  }
  const regime = aggregateRegime(perAsset);

  const successAt = new Date().toISOString();
  const md = buildMarkdown({
    cycleCount, lastAttemptedAt, lastSuccessfulAt: successAt,
    regime, perAsset, prices, levels, errors, preservedBody,
  });

  const written = await writeToWiki(md, prevSha).catch(() => false);

  return res.status(200).json({
    regime, cycleCount, written, errors,
    snapshot: {
      perAsset,
      levels_defined: Object.keys(levels).length,
    },
    trigger: req.body?.trigger || 'manual',
  });
}
