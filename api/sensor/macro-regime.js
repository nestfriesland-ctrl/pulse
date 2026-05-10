/**
 * POST /api/sensor/macro-regime
 *
 * Macro-regime sensor — classifies the macro state along three axes:
 *   regime           : RISK-ON | RISK-OFF | TRANSITION
 *   real_yield_regime: REAL-EASING | REAL-TIGHTENING | NEUTRAL
 *   liquidity_regime : M2-EXPANDING | M2-CONTRACTING | M2-FLAT
 *
 * Sources:
 *   - FRED (DTWEXBGS=DXY-proxy, DGS10=US10Y, DFII10=TIPS10Y,
 *           T10YIE=breakeven, M2SL=M2). Requires FRED_API_KEY.
 *   - Yahoo Finance v8 (^VIX, GC=F=gold, SI=F=silver). Public, fragile;
 *     query2 fallback on query1 failure.
 *   - CoinGecko (BTC spot + 200d history for MA200).
 *
 * Cadence: 6h (Vercel cron `0 ​*​/6 * * *`).
 *
 * Output: wiki/sensors/macro-regime.md. cycle_count read from prior MD (+1);
 * run 53 was the last manual entry, so first cron run = 54.
 *
 * Wiki write pattern mirrors api/sensor/liquidity-tide.js (GitHub Contents API,
 * GITHUB_PAT env). Krant-discipline: Kop ≤90 incl. werkwoord, Stelling ≤240,
 * Bewijs ≤140 met getallen, Les ≤140, Actie ≤140.
 */

const WIKI_REPO = 'nestfriesland-ctrl/wiki';
const SENSOR_PATH = 'sensors/macro-regime.md';

// ── Thresholds (per spec) ───────────────────────────────────
const VIX_RISK_ON = 18;
const VIX_RISK_OFF = 25;
const TIPS_THRESHOLD = 1.92;
const BREAKEVEN_EASING_MIN = 2.45;
const M2_MOM_EXPANDING = 0.20;   // %
const M2_3MAVG_EXPANDING = 0.30; // %

// ── Field caps for Krant-discipline ─────────────────────────
const CAP_KOP = 90;
const CAP_STELLING = 240;
const CAP_BEWIJS = 140;
const CAP_LES = 140;
const CAP_ACTIE = 140;

// ── FRED ────────────────────────────────────────────────────
async function fredLatest(seriesId, apiKey, n = 1) {
  const url = `https://api.stlouisfed.org/fred/series/observations?series_id=${seriesId}`
    + `&api_key=${apiKey}&file_type=json&sort_order=desc&limit=${n}`;
  const r = await fetch(url);
  if (!r.ok) throw new Error(`fred_${seriesId}_${r.status}`);
  const j = await r.json();
  const obs = (j.observations || []).filter(o => o.value !== '.');
  if (!obs.length) throw new Error(`fred_${seriesId}_no_data`);
  return obs.map(o => ({ date: o.date, value: parseFloat(o.value) }));
}

// ── Yahoo Finance (fragile; fallback to query2) ─────────────
async function yahooDaily(symbol, range = '5d') {
  const path = `/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=${range}`;
  for (const host of ['query1.finance.yahoo.com', 'query2.finance.yahoo.com']) {
    try {
      const r = await fetch(`https://${host}${path}`, {
        headers: { 'User-Agent': 'pulse-macro-regime/1.0' },
      });
      if (!r.ok) continue;
      const j = await r.json();
      const result = j?.chart?.result?.[0];
      const closes = result?.indicators?.quote?.[0]?.close || [];
      const ts = result?.timestamp || [];
      const series = ts.map((t, i) => ({ ts: t, close: closes[i] }))
        .filter(p => p.close != null);
      if (series.length) return series;
    } catch (_) { /* try next host */ }
  }
  throw new Error(`yahoo_${symbol}_failed`);
}

// ── CoinGecko ───────────────────────────────────────────────
async function coingeckoBtcSpot() {
  const r = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd');
  if (!r.ok) throw new Error(`coingecko_spot_${r.status}`);
  const j = await r.json();
  const v = j?.bitcoin?.usd;
  if (v == null) throw new Error('coingecko_spot_no_data');
  return v;
}

async function coingeckoBtc200d() {
  const r = await fetch('https://api.coingecko.com/api/v3/coins/bitcoin/market_chart?vs_currency=usd&days=200&interval=daily');
  if (!r.ok) throw new Error(`coingecko_history_${r.status}`);
  const j = await r.json();
  const prices = (j.prices || []).map(p => p[1]).filter(Number.isFinite);
  if (prices.length < 50) throw new Error('coingecko_history_too_short');
  const slice = prices.slice(-200);
  const sum = slice.reduce((a, b) => a + b, 0);
  return sum / slice.length;
}

// ── M2 derivatives ──────────────────────────────────────────
function m2Stats(m2Points) {
  // m2Points sorted desc (newest first). Need MoM% and 3-month avg of MoM%.
  if (m2Points.length < 4) return { mom: null, avg3m: null };
  const mom = (m2Points[0].value / m2Points[1].value - 1) * 100;
  const monthly = [];
  for (let i = 0; i < Math.min(4, m2Points.length - 1); i++) {
    monthly.push((m2Points[i].value / m2Points[i + 1].value - 1) * 100);
  }
  const avg3m = monthly.slice(0, 3).reduce((a, b) => a + b, 0) / 3;
  return { mom, avg3m };
}

// ── Regime classification ───────────────────────────────────
function classifyRegime({ vix, btc, btcMa200, dxyTrend }) {
  const btcAboveMa = btc != null && btcMa200 != null && btc > btcMa200;
  const btcBelowMa = btc != null && btcMa200 != null && btc < btcMa200;
  if (vix != null && vix < VIX_RISK_ON && btcAboveMa) return 'RISK-ON';
  if (vix != null && vix > VIX_RISK_OFF) return 'RISK-OFF';
  if (btcBelowMa && dxyTrend === 'UP') return 'RISK-OFF';
  return 'TRANSITION';
}

function classifyRealYield({ tips, breakeven }) {
  if (tips == null || breakeven == null) return 'NEUTRAL';
  if (tips < TIPS_THRESHOLD && breakeven > BREAKEVEN_EASING_MIN) return 'REAL-EASING';
  if (tips > TIPS_THRESHOLD && breakeven < BREAKEVEN_EASING_MIN) return 'REAL-TIGHTENING';
  return 'NEUTRAL';
}

function classifyLiquidity({ mom, avg3m }) {
  if (mom == null || avg3m == null) return 'M2-FLAT';
  if (mom > M2_MOM_EXPANDING && avg3m > M2_3MAVG_EXPANDING) return 'M2-EXPANDING';
  if (mom < 0 || avg3m < 0) return 'M2-CONTRACTING';
  return 'M2-FLAT';
}

function dxyTrendFrom(points) {
  // FRED series desc-sorted (newest first). Trend over ~5 prints.
  if (!points || points.length < 3) return 'FLAT';
  const newest = points[0].value;
  const older = points[Math.min(points.length - 1, 4)].value;
  const delta = (newest - older) / older;
  if (delta > 0.005) return 'UP';
  if (delta < -0.005) return 'DOWN';
  return 'FLAT';
}

// ── Wiki I/O ────────────────────────────────────────────────
async function loadPreviousMarkdown() {
  const PAT = process.env.GITHUB_PAT;
  if (!PAT) return null;
  const r = await fetch(`https://api.github.com/repos/${WIKI_REPO}/contents/${SENSOR_PATH}?ref=main`, {
    headers: { Authorization: `token ${PAT}`, Accept: 'application/vnd.github+json', 'User-Agent': 'pulse-macro-regime' },
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
    message: `sensor(macro-regime): ${new Date().toISOString().slice(0, 16)} dispatch`,
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
      'User-Agent': 'pulse-macro-regime',
    },
    body: JSON.stringify(body),
  });
  return r.ok;
}

function readCycleCountFromMd(md) {
  if (!md) return 53; // last manual entry was run 53; first cron run will be 54
  const m = md.match(/^cycle_count:\s*(\d+)/m) || md.match(/Run\s+(\d+)/);
  return m ? parseInt(m[1], 10) : 53;
}

// ── Markdown builder ────────────────────────────────────────
function cap(s, n) {
  if (s == null) return '';
  return s.length <= n ? s : s.slice(0, n - 1) + '…';
}

function fmt(n, d = 2) { return n == null || Number.isNaN(n) ? '—' : Number(n).toFixed(d); }

function buildKrant({ regime, realRegime, liquidityRegime, vix, btc, btcMa200, dxy, tips, breakeven, m2, dxyTrend }) {
  // Kop: werkwoord verplicht. Use regime to pick verb.
  const verb = regime === 'RISK-ON' ? 'draait door' : regime === 'RISK-OFF' ? 'kantelt' : 'aarzelt';
  const kop = cap(`Macro ${verb} in ${regime} — real-yields ${realRegime}, liquiditeit ${liquidityRegime}.`, CAP_KOP);

  const stelling = cap(
    `Komende cyclus blijft regime ${regime}/${realRegime}/${liquidityRegime} stabiel als VIX <${VIX_RISK_OFF}, TIPS rond ${fmt(tips)}, M2-MoM ≥${fmt(M2_MOM_EXPANDING, 2)}%; valsifieerbaar bij VIX>${VIX_RISK_OFF}, TIPS-shift >0.10pp of M2-MoM <0.`,
    CAP_STELLING,
  );

  const bewijs = cap(
    `VIX ${fmt(vix)} | BTC ${fmt(btc, 0)} (MA200 ${fmt(btcMa200, 0)}) | DXY-prx ${fmt(dxy, 2)} (${dxyTrend}) | TIPS ${fmt(tips)} | BE ${fmt(breakeven)} | M2-MoM ${fmt(m2.mom)}% / 3m ${fmt(m2.avg3m)}%.`,
    CAP_BEWIJS,
  );

  const les = cap(
    regime === 'RISK-ON'
      ? 'RISK-ON sticky tot VIX-spike of BTC<MA200 — geen vroege exit op enkel real-yield-shift.'
      : regime === 'RISK-OFF'
        ? 'RISK-OFF wijkt pas bij VIX-mean-revert én BTC-herstel boven MA200; los signaal is ruis.'
        : 'TRANSITION = wachten loont; geen positie op overgangsregime tot 2 confirmaties.',
    CAP_LES,
  );

  const actie = cap(
    regime === 'RISK-ON'
      ? 'Long-bias intact; trim bij VIX>22 of BTC<MA200; geen leverage-add zonder M2-EXPANDING bevestiging.'
      : regime === 'RISK-OFF'
        ? 'Defensief: cash/gold-overweight, geen long-add tot VIX<20 én BTC>MA200 twee dagen op rij.'
        : 'Geen nieuwe positie; bestaande positie reduceren naar core-grootte tot regime alignment.',
    CAP_ACTIE,
  );

  return { kop, stelling, bewijs, les, actie };
}

function buildMarkdown({
  cycleCount, lastAttemptedAt, lastSuccessfulAt,
  regime, realRegime, liquidityRegime,
  dxy, vix, gold, silver, us10y, tips, breakeven, m2, btc, btcMa200,
  dxyTrend, errors,
}) {
  const krant = buildKrant({ regime, realRegime, liquidityRegime, vix, btc, btcMa200, dxy, tips, breakeven, m2, dxyTrend });
  const ratio = (gold != null && silver != null && silver > 0) ? gold / silver : null;

  return [
    '---',
    'sensor: macro-regime',
    `regime: ${regime}`,
    `real_yield_regime: ${realRegime}`,
    `liquidity_regime: ${liquidityRegime}`,
    `last_attempted_at: ${lastAttemptedAt}`,
    `last_successful_at: ${lastSuccessfulAt || 'never'}`,
    `last_updated: ${lastAttemptedAt}`,
    'freshness: 0',
    'confidence: HARD',
    `cycle_count: ${cycleCount}`,
    `dxy: ${fmt(dxy, 2)}`,
    `vix: ${fmt(vix, 2)}`,
    `gold: ${fmt(gold, 0)}`,
    `silver: ${fmt(silver, 2)}`,
    `us10y: ${fmt(us10y, 2)}`,
    `tips10y: ${fmt(tips, 2)}`,
    `breakeven: ${fmt(breakeven, 2)}`,
    `m2_mom: ${fmt(m2.mom, 2)}`,
    `m2_3m_avg: ${fmt(m2.avg3m, 2)}`,
    `btc: ${fmt(btc, 0)}`,
    `btc_ma200: ${fmt(btcMa200, 0)}`,
    `gold_silver_ratio: ${fmt(ratio, 2)}`,
    `dxy_trend: ${dxyTrend}`,
    '---',
    '',
    '# Macro Regime',
    '',
    `> Run ${cycleCount} — ${lastAttemptedAt}. Regime: **${regime}** | Real: **${realRegime}** | Liquidity: **${liquidityRegime}**.`,
    '',
    '## Scorebord',
    '',
    '| Variabele | Waarde | Niveau |',
    '|-----------|--------|--------|',
    `| DXY (FRED DTWEXBGS) | ${fmt(dxy, 2)} | trend ${dxyTrend} |`,
    `| VIX | ${fmt(vix, 2)} | ${vix < VIX_RISK_ON ? 'low-vol' : vix > VIX_RISK_OFF ? 'stress' : 'mid'} |`,
    `| US 10Y | ${fmt(us10y, 2)}% | nominal yield |`,
    `| TIPS 10Y | ${fmt(tips, 2)}% | ${tips < TIPS_THRESHOLD ? 'easing-side' : 'tightening-side'} |`,
    `| Breakeven 10Y | ${fmt(breakeven, 2)}% | infl-expectation |`,
    `| M2 MoM | ${fmt(m2.mom, 2)}% | 3m avg ${fmt(m2.avg3m, 2)}% |`,
    `| Gold | $${fmt(gold, 0)} | — |`,
    `| Silver | $${fmt(silver, 2)} | ratio ${fmt(ratio, 2)} |`,
    `| BTC | $${fmt(btc, 0)} | MA200 $${fmt(btcMa200, 0)} ${btc > btcMa200 ? '↑' : '↓'} |`,
    '',
    '## Krant',
    '',
    `**Kop:** ${krant.kop}`,
    `**Stelling:** ${krant.stelling}`,
    `**Bewijs:** ${krant.bewijs}`,
    `**Les:** ${krant.les}`,
    `**Actie:** ${krant.actie}`,
    '',
    '## Methodologie',
    '',
    `Bronnen: FRED (DXY=DTWEXBGS, US10Y=DGS10, TIPS=DFII10, breakeven=T10YIE, M2=M2SL); Yahoo (^VIX, GC=F, SI=F); CoinGecko (BTC spot + 200d MA). Cadence 6u.`,
    `Regime-rules: RISK-ON = VIX<${VIX_RISK_ON} & BTC>MA200; RISK-OFF = VIX>${VIX_RISK_OFF} of (BTC<MA200 & DXY-trend UP); anders TRANSITION. Real: TIPS<${TIPS_THRESHOLD} & BE>${BREAKEVEN_EASING_MIN} = REAL-EASING; TIPS>${TIPS_THRESHOLD} & BE<${BREAKEVEN_EASING_MIN} = REAL-TIGHTENING; anders NEUTRAL. M2: MoM>${M2_MOM_EXPANDING}% & 3m>${M2_3MAVG_EXPANDING}% = EXPANDING; MoM<0 of 3m<0 = CONTRACTING; anders FLAT.`,
    errors && errors.length ? `\n> errors: ${errors.join(' | ')}` : '',
  ].filter(l => l !== '').join('\n');
}

// ── Main handler ────────────────────────────────────────────
export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const lastAttemptedAt = new Date().toISOString();
  const fredKey = process.env.FRED_API_KEY;
  if (!fredKey) {
    return res.status(200).json({
      regime: 'UNKNOWN',
      reason: 'FRED_API_KEY missing — runner blocked. Add to Vercel env (project=pulse).',
      lastAttemptedAt,
    });
  }

  // Cycle count from prior MD
  let cycleCount = 54;
  let prevSha = null;
  let lastSuccessfulAt = null;
  try {
    const prev = await loadPreviousMarkdown();
    if (prev) {
      prevSha = prev.sha;
      cycleCount = readCycleCountFromMd(prev.content) + 1;
      const lsa = prev.content.match(/^last_successful_at:\s*([^\n]+)/m);
      if (lsa) lastSuccessfulAt = lsa[1].trim();
    }
  } catch (_) { /* first run */ }

  const errors = [];
  const safe = async (label, p) => {
    try { return await p; }
    catch (e) { errors.push(`${label}:${e.message}`); return null; }
  };

  const [dxyPts, us10yArr, tipsArr, beArr, m2Pts, vixSeries, goldSeries, silverSeries, btc, btcMa200] = await Promise.all([
    safe('dxy', fredLatest('DTWEXBGS', fredKey, 6)),
    safe('us10y', fredLatest('DGS10', fredKey, 1)),
    safe('tips', fredLatest('DFII10', fredKey, 1)),
    safe('breakeven', fredLatest('T10YIE', fredKey, 1)),
    safe('m2', fredLatest('M2SL', fredKey, 6)),
    safe('vix', yahooDaily('^VIX', '5d')),
    safe('gold', yahooDaily('GC=F', '5d')),
    safe('silver', yahooDaily('SI=F', '5d')),
    safe('btc_spot', coingeckoBtcSpot()),
    safe('btc_ma200', coingeckoBtc200d()),
  ]);

  const dxy = dxyPts?.[0]?.value ?? null;
  const us10y = us10yArr?.[0]?.value ?? null;
  const tips = tipsArr?.[0]?.value ?? null;
  const breakeven = beArr?.[0]?.value ?? null;
  const vix = vixSeries?.length ? vixSeries[vixSeries.length - 1].close : null;
  const gold = goldSeries?.length ? goldSeries[goldSeries.length - 1].close : null;
  const silver = silverSeries?.length ? silverSeries[silverSeries.length - 1].close : null;
  const m2 = m2Pts ? m2Stats(m2Pts) : { mom: null, avg3m: null };
  const dxyTrend = dxyTrendFrom(dxyPts);

  const regime = classifyRegime({ vix, btc, btcMa200, dxyTrend });
  const realRegime = classifyRealYield({ tips, breakeven });
  const liquidityRegime = classifyLiquidity(m2);

  const successAt = new Date().toISOString();
  const md = buildMarkdown({
    cycleCount, lastAttemptedAt, lastSuccessfulAt: successAt,
    regime, realRegime, liquidityRegime,
    dxy, vix, gold, silver, us10y, tips, breakeven, m2, btc, btcMa200,
    dxyTrend, errors,
  });

  const written = await writeToWiki(md, prevSha).catch(() => false);

  return res.status(200).json({
    regime, real_yield_regime: realRegime, liquidity_regime: liquidityRegime,
    cycleCount, written, errors,
    snapshot: { dxy, vix, gold, silver, us10y, tips, breakeven, btc, btcMa200, m2 },
    trigger: req.body?.trigger || 'manual',
  });
}
