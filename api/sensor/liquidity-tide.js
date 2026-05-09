/**
 * POST /api/sensor/liquidity-tide
 *
 * Liquidity-Tide sensor — tracks high-leverage liquidation clusters around spot
 * for BTC/ETH/HYPE on binance_perp_stable. Detects skew, magnets, sweeps.
 *
 * Lives in pulse (markt-data, not biometrics). pulse already has GITHUB_PAT
 * and the wiki write pattern from api/observer-event.js.
 *
 * Data source: Hyblock /v2/liquidationLevels (OAuth via x-api-key + client creds).
 * Spot prices: Binance /api/v3/ticker/price (public, CORS-open).
 *
 * Sweep tracking: previous run's nearest-cluster-per-side is persisted in the
 * markdown frontmatter (`sweep_state:`); each new run re-reads the prior MD and
 * compares current spot vs. tracked cluster price → marks SWEPT/INTACT.
 *
 * Output: wiki/sensors/liquidity-tide.md (≤80 lines).
 *
 * Notes from Phase-1 endpoint validation:
 *   - leverage param is enum 'high'|'medium'|'low' (NOT numeric).
 *   - 'limit' is rejected — full result set returned.
 *   - HYPE only on binance_perp_stable; no native Hyperliquid exchange.
 *   - Record shape: { timestamp, creationDate, size, price, leverage, side, openDuration }
 *     `size` is notional in USD.
 */

const HYBLOCK_BASE = 'https://api.hyblockcapital.com/v2';
const HYBLOCK_TOKEN_URL = 'https://api.hyblockcapital.com/oauth2/token';
const WIKI_REPO = 'nestfriesland-ctrl/wiki';
const SENSOR_PATH = 'sensors/liquidity-tide.md';

const ASSETS = [
  { coin: 'btc', label: 'BTC', binanceSymbol: 'BTCUSDT' },
  { coin: 'eth', label: 'ETH', binanceSymbol: 'ETHUSDT' },
  { coin: 'hype', label: 'HYPE', binanceSymbol: 'HYPEUSDT' },
];

// Skew threshold: long_notional / short_notional > 2 → LONG_HEAVY (cascade
// risk on price drop). Magnet threshold: single cluster ≥30% of one-sided
// notional within 3% of spot. Tuned on Phase-1 sample (BTC: 11 long / 33
// short on `high`); thresholds will need re-evaluation after first 10 cycles.
const SKEW_RATIO = 2.0;
const NEAR_PCT = 0.05;        // ±5% window for "near spot"
const MAGNET_PCT = 0.03;      // ±3% window for magnet flag
const MAGNET_FRACTION = 0.30; // single cluster ≥30% of side total

// ── Hyblock OAuth ──────────────────────────────────────────
async function getHyblockToken() {
  const id = process.env.HYBLOCK_CLIENT_ID;
  const secret = process.env.HYBLOCK_CLIENT_SECRET;
  const apiKey = process.env.HYBLOCK_API_KEY;
  if (!id || !secret || !apiKey) throw new Error('hyblock_creds_missing');
  const r = await fetch(HYBLOCK_TOKEN_URL, {
    method: 'POST',
    headers: { 'x-api-key': apiKey, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: id,
      client_secret: secret,
    }),
  });
  if (!r.ok) throw new Error(`hyblock_oauth_${r.status}`);
  const j = await r.json();
  if (!j.access_token) throw new Error('hyblock_oauth_no_token');
  return j.access_token;
}

async function fetchClusters(token, coin, side) {
  const url = `${HYBLOCK_BASE}/liquidationLevels?coin=${coin}&exchange=binance_perp_stable&leverage=high&position=${side}`;
  const r = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      'x-api-key': process.env.HYBLOCK_API_KEY,
    },
  });
  if (!r.ok) throw new Error(`hyblock_${coin}_${side}_${r.status}`);
  const j = await r.json();
  return Array.isArray(j.data) ? j.data : [];
}

async function fetchSpot(symbol) {
  const r = await fetch(`https://api.binance.com/api/v3/ticker/price?symbol=${symbol}`);
  if (!r.ok) throw new Error(`binance_${symbol}_${r.status}`);
  const j = await r.json();
  return parseFloat(j.price);
}

// ── Asset analysis ─────────────────────────────────────────
function analyseAsset(spot, longClusters, shortClusters) {
  const nearLow = spot * (1 - NEAR_PCT);
  const nearHigh = spot * (1 + NEAR_PCT);
  const magnetLow = spot * (1 - MAGNET_PCT);
  const magnetHigh = spot * (1 + MAGNET_PCT);

  // Long-liquidations sit BELOW spot (long gets liquidated when price falls).
  // Short-liquidations sit ABOVE spot. Filter to the directionally-relevant
  // half-window only — a long cluster above spot is a stale/wrong-side print.
  const longsNear = longClusters.filter(c => c.price >= nearLow && c.price < spot);
  const shortsNear = shortClusters.filter(c => c.price > spot && c.price <= nearHigh);

  const longNotional = longsNear.reduce((s, c) => s + (c.size || 0), 0);
  const shortNotional = shortsNear.reduce((s, c) => s + (c.size || 0), 0);

  const sortBySizeDesc = (arr) => [...arr].sort((a, b) => (b.size || 0) - (a.size || 0));
  const topLong = sortBySizeDesc(longsNear)[0] || null;
  const topShort = sortBySizeDesc(shortsNear)[0] || null;

  // Magnet check: largest cluster ≥MAGNET_FRACTION of side-total AND within ±3% of spot.
  const magnetBelow = topLong && longNotional > 0
    && topLong.size >= longNotional * MAGNET_FRACTION
    && topLong.price >= magnetLow;
  const magnetAbove = topShort && shortNotional > 0
    && topShort.size >= shortNotional * MAGNET_FRACTION
    && topShort.price <= magnetHigh;

  const ratio = (longNotional > 0 && shortNotional > 0)
    ? longNotional / shortNotional
    : null;

  // Median notional across both sides defines low-tide threshold. Hard-coded
  // floor avoids classifying a fully-empty book (early HYPE) as LOW_TIDE
  // when it's actually just thin coverage.
  const totalNotional = longNotional + shortNotional;
  const LOW_TIDE_FLOOR = 50_000_000;  // $50M aggregate near-spot notional
  const HIGH_TIDE_FLOOR = 500_000_000; // $500M aggregate

  let regime;
  if (totalNotional < LOW_TIDE_FLOOR) regime = 'LOW_TIDE';
  else if (magnetBelow) regime = 'MAGNET_BELOW';
  else if (magnetAbove) regime = 'MAGNET_ABOVE';
  else if (ratio && ratio >= SKEW_RATIO) regime = 'LONG_HEAVY';
  else if (ratio && ratio <= 1 / SKEW_RATIO) regime = 'SHORT_HEAVY';
  else if (totalNotional >= HIGH_TIDE_FLOOR) regime = 'HIGH_TIDE';
  else regime = 'BALANCED';

  return {
    spot,
    longNotional,
    shortNotional,
    ratio,
    topLong: topLong ? { price: topLong.price, size: topLong.size } : null,
    topShort: topShort ? { price: topShort.price, size: topShort.size } : null,
    longCount: longsNear.length,
    shortCount: shortsNear.length,
    regime,
  };
}

// ── Aggregate regime over 3 assets ─────────────────────────
function aggregateRegime(perAsset) {
  const counts = {};
  for (const a of Object.values(perAsset)) {
    counts[a.regime] = (counts[a.regime] || 0) + 1;
  }
  const sorted = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  if (!sorted.length) return 'UNKNOWN';
  // ≥2 of 3 must agree, otherwise MIXED.
  if (sorted[0][1] >= 2) return sorted[0][0];
  return 'MIXED';
}

// ── Wiki I/O ───────────────────────────────────────────────
async function loadPreviousMarkdown() {
  const PAT = process.env.GITHUB_PAT;
  if (!PAT) return null;
  const r = await fetch(`https://api.github.com/repos/${WIKI_REPO}/contents/${SENSOR_PATH}?ref=main`, {
    headers: { Authorization: `token ${PAT}`, Accept: 'application/vnd.github+json', 'User-Agent': 'pulse-liquidity-tide' },
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
    message: `sensor(liquidity-tide): ${new Date().toISOString().slice(0, 16)} dispatch`,
    content: Buffer.from(content, 'utf-8').toString('base64'),
    branch: 'main',
  };
  if (prevSha) body.sha = prevSha;
  const r = await fetch(`https://api.github.com/repos/${WIKI_REPO}/contents/${SENSOR_PATH}`, {
    method: 'PUT',
    headers: {
      Authorization: `token ${PAT}`,
      Accept: 'application/vnd.github+json',
      'Content-Type': 'application/json',
      'User-Agent': 'pulse-liquidity-tide',
    },
    body: JSON.stringify(body),
  });
  return r.ok;
}

// ── Sweep-state load/diff ──────────────────────────────────
function parseSweepState(md) {
  if (!md) return {};
  const m = md.match(/^>\s*sweep_state:\s*$([\s\S]*?)(?=\n>\s*[a-z_]+:|\n\n|\n##)/mi);
  if (!m) return {};
  const lines = m[1].split('\n');
  const state = {};
  for (const line of lines) {
    // Format: `>   BTC: long@79850 short@80450`
    const mm = line.match(/^>\s+(\w+):\s*(?:long@([\d.]+))?\s*(?:short@([\d.]+))?/);
    if (mm) {
      state[mm[1]] = {
        long: mm[2] ? parseFloat(mm[2]) : null,
        short: mm[3] ? parseFloat(mm[3]) : null,
      };
    }
  }
  return state;
}

// Sweep detected when current spot crosses a previously-tracked cluster.
// long@P (cluster below previous spot) → swept if current spot ≤ P.
// short@P (cluster above previous spot) → swept if current spot ≥ P.
function detectSweeps(prevState, perAsset) {
  const sweeps = [];
  for (const [label, a] of Object.entries(perAsset)) {
    const prev = prevState[label];
    if (!prev) continue;
    if (prev.long != null && a.spot <= prev.long) {
      sweeps.push({ label, side: 'long', price: prev.long, spot: a.spot });
    }
    if (prev.short != null && a.spot >= prev.short) {
      sweeps.push({ label, side: 'short', price: prev.short, spot: a.spot });
    }
  }
  return sweeps;
}

function readCycleCountFromMd(md) {
  if (!md) return 0;
  const m = md.match(/^>\s*cycle_count:\s*(\d+)/m);
  return m ? parseInt(m[1], 10) : 0;
}

// ── Markdown builder (≤80 lines) ───────────────────────────
function fmtNotional(n) {
  if (n == null) return '—';
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(0)}K`;
  return `${n.toFixed(0)}`;
}

function fmtPrice(p, decimals) {
  if (p == null) return '—';
  return p < 1 ? p.toFixed(4) : p.toFixed(decimals ?? 2);
}

function regimeHeadline(agg, perAsset, sweeps) {
  if (sweeps.length) {
    const s = sweeps[0];
    return `${s.label} ${s.side === 'long' ? 'long-cluster' : 'short-cluster'} @${fmtPrice(s.price)} sweep — spot ${fmtPrice(s.spot)}.`;
  }
  switch (agg) {
    case 'LONG_HEAVY':   return 'Long-side liquidatie-stack dominant — daling triggert cascade.';
    case 'SHORT_HEAVY':  return 'Short-side liquidatie-stack dominant — squeeze-risico bij rally.';
    case 'MAGNET_BELOW': return 'Magnet onder spot — concentratie pull-down geactiveerd.';
    case 'MAGNET_ABOVE': return 'Magnet boven spot — concentratie pull-up geactiveerd.';
    case 'HIGH_TIDE':    return 'Beide kanten zwaar geladen — tweezijdig cascade-risico.';
    case 'LOW_TIDE':     return 'Dunne clusters — geen leverage-tide te bespeuren.';
    case 'BALANCED':     return 'Symmetrisch — geen directionele pull uit liquidatie-niveaus.';
    case 'MIXED':        return 'Tegenstrijdige regimes per asset — geen aggregaat-stelling.';
    default:             return 'Onbekend tide-regime.';
  }
}

function actionForRegime(agg, sweeps) {
  if (sweeps.length) return 'Track post-sweep follow-through 4–8u; verwacht reversal of momentum-cascade.';
  if (agg === 'LONG_HEAVY') return 'Bij open longs: stop verstrakken; geen long-add bij price-near-cluster.';
  if (agg === 'SHORT_HEAVY') return 'Bij open shorts: stop verstrakken; geen short-add bij price-near-cluster.';
  if (agg === 'MAGNET_BELOW' || agg === 'MAGNET_ABOVE') return 'Magnet-zone is doel — counter-trade pas na test of bevestigde rejection.';
  if (agg === 'HIGH_TIDE') return 'Verhoogde cascade-kans beide zijden — positie-grootte tijdelijk verlagen.';
  if (agg === 'LOW_TIDE') return 'Geen leverage-pressure — sensor zonder edge deze cyclus.';
  return 'Geen actie — observeren tot regime alignment.';
}

function buildMarkdown({ perAsset, agg, sweeps, cycleCount, lastAttemptedAt, lastSuccessfulAt }) {
  const lines = [
    '# Liquidity Tide',
    '',
    `> last_attempted_at: ${lastAttemptedAt}`,
    `> last_successful_at: ${lastSuccessfulAt || 'never'}`,
    `> last_updated: ${lastAttemptedAt}`,
    '> freshness: 0',
    '> confidence: HARD',
    `> regime: ${agg}`,
    `> cycle_count: ${cycleCount}`,
    '> sweep_state:',
  ];
  // Encode tracked clusters per asset for next cycle's diff.
  for (const [label, a] of Object.entries(perAsset)) {
    const longP = a.topLong?.price != null ? `long@${a.topLong.price}` : '';
    const shortP = a.topShort?.price != null ? `short@${a.topShort.price}` : '';
    lines.push(`>   ${label}: ${[longP, shortP].filter(Boolean).join(' ') || '—'}`);
  }
  lines.push('');
  lines.push('## Scorebord');
  lines.push('');
  lines.push('| Asset | Spot | Long-stack | Short-stack | Skew | Top-long | Top-short | Regime |');
  lines.push('|-------|------|------------|-------------|------|----------|-----------|--------|');
  for (const [label, a] of Object.entries(perAsset)) {
    const skew = a.ratio != null ? a.ratio.toFixed(2) : '—';
    const tl = a.topLong ? `${fmtPrice(a.topLong.price)} (${fmtNotional(a.topLong.size)})` : '—';
    const ts = a.topShort ? `${fmtPrice(a.topShort.price)} (${fmtNotional(a.topShort.size)})` : '—';
    lines.push(`| ${label} | ${fmtPrice(a.spot)} | ${fmtNotional(a.longNotional)} (${a.longCount}) | ${fmtNotional(a.shortNotional)} (${a.shortCount}) | ${skew} | ${tl} | ${ts} | ${a.regime} |`);
  }
  lines.push('');
  lines.push('## Krant');
  lines.push('');
  lines.push(`**Kop:** ${regimeHeadline(agg, perAsset, sweeps)}`);

  let stelling;
  if (sweeps.length) {
    const s = sweeps[0];
    stelling = `${s.label} sweepte ${s.side}-cluster @${fmtPrice(s.price)} (spot nu ${fmtPrice(s.spot)}); volgende cyclus moet nieuwe top-${s.side} cluster verschijnen of regime shiftet.`;
  } else if (agg === 'LONG_HEAVY' || agg === 'SHORT_HEAVY') {
    const dir = agg === 'LONG_HEAVY' ? 'daling' : 'rally';
    stelling = `Aggregaat ${agg}: bij ${dir} >2% triggert cascade. Falsifieerbaar op T+4u — als ${dir} optreedt zonder cluster-leeg-print, regime is ruis.`;
  } else if (agg === 'MAGNET_BELOW' || agg === 'MAGNET_ABOVE') {
    stelling = `Magnet-cluster geactiveerd in ${agg.split('_')[1].toLowerCase()}-range; spot bereikt cluster-prijs binnen 24u of magnet was vals signaal.`;
  } else {
    stelling = `Aggregaat ${agg}: geen directionele tide. Volgende cyclus moet één asset uit ${Object.keys(perAsset).join('/')} skew >2.0 bereiken voor regime-shift.`;
  }
  lines.push(`**Stelling:** ${stelling}`);

  const evidence = Object.entries(perAsset).map(([l, a]) => `${l} ${a.regime} (skew ${a.ratio?.toFixed(2) ?? '—'})`).join(' | ');
  lines.push(`**Bewijs:** ${evidence}.`);
  lines.push(`**Les:** ${sweeps.length ? `Sweep bevestigt cluster-magnet — track follow-through.` : agg === 'MIXED' ? 'Geen consensus — sensor wacht op alignment.' : 'Aggregaat-regime is voorlopig — N=cycle_count nog te klein voor track-record.'}`);
  lines.push(`**Actie:** ${actionForRegime(agg, sweeps)}`);

  lines.push('');
  lines.push('## Methodologie');
  lines.push('');
  lines.push(`Bron: Hyblock /v2/liquidationLevels (binance_perp_stable, leverage=high). Window ±${(NEAR_PCT * 100).toFixed(0)}% rond spot. Magnet-drempel: 1 cluster ≥${(MAGNET_FRACTION * 100).toFixed(0)}% van zijde-totaal binnen ±${(MAGNET_PCT * 100).toFixed(0)}%. Skew-drempel: ${SKEW_RATIO.toFixed(1)}x.`);
  lines.push('Sweep-detectie: vergelijkt spot met top-cluster prijs uit vorige cyclus (frontmatter sweep_state). Cluster wordt SWEPT bij prijs door cluster-niveau.');
  lines.push('Aggregaat: 7-state regime per asset, meerderheid ≥2/3 wint, anders MIXED.');
  lines.push('Naamgeving-debt: "tide" suggereert continue stroom; sensor meet snapshot-stack — naam te toetsen na 20 cycles.');

  // Hard cap to avoid runaway output if we add more assets later.
  return lines.slice(0, 80).join('\n');
}

// ── Main handler ───────────────────────────────────────────
export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const lastAttemptedAt = new Date().toISOString();
  let lastSuccessfulAt = null;
  let cycleCount = 1;
  let prevSweepState = {};
  let prevSha = null;

  try {
    const prev = await loadPreviousMarkdown();
    if (prev) {
      prevSha = prev.sha;
      cycleCount = readCycleCountFromMd(prev.content) + 1;
      prevSweepState = parseSweepState(prev.content);
      const lsa = prev.content.match(/^>\s*last_successful_at:\s*([^\n]+)/m);
      if (lsa) lastSuccessfulAt = lsa[1].trim();
    }
  } catch (e) {
    // First run or wiki unreadable — sensor proceeds with empty prev-state.
  }

  let token;
  try {
    token = await getHyblockToken();
  } catch (e) {
    return res.status(200).json({ regime: 'UNKNOWN', reason: e.message, cycleCount });
  }

  const perAsset = {};
  const errors = [];

  await Promise.all(ASSETS.map(async (a) => {
    try {
      const [longs, shorts, spot] = await Promise.all([
        fetchClusters(token, a.coin, 'long'),
        fetchClusters(token, a.coin, 'short'),
        fetchSpot(a.binanceSymbol),
      ]);
      perAsset[a.label] = analyseAsset(spot, longs, shorts);
    } catch (e) {
      errors.push(`${a.label}:${e.message}`);
    }
  }));

  if (Object.keys(perAsset).length === 0) {
    return res.status(200).json({ regime: 'UNKNOWN', reason: 'all_assets_failed', errors, cycleCount });
  }

  const sweeps = detectSweeps(prevSweepState, perAsset);
  const agg = aggregateRegime(perAsset);

  const successAt = new Date().toISOString();
  const md = buildMarkdown({
    perAsset,
    agg,
    sweeps,
    cycleCount,
    lastAttemptedAt,
    lastSuccessfulAt: successAt,
  });

  const written = await writeToWiki(md, prevSha).catch(() => false);

  return res.status(200).json({
    regime: agg,
    sweeps,
    perAsset,
    written,
    errors,
    cycleCount,
    trigger: req.body?.trigger || 'manual',
  });
}

// Exported for liquidity-sweep-poll to reuse helpers without HTTP round-trip.
export const _internal = {
  parseSweepState,
  loadPreviousMarkdown,
  fetchSpot,
  ASSETS,
};
