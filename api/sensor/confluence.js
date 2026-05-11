/**
 * POST /api/sensor/confluence
 *
 * Confluence sensor — leest 4 andere sensoren via wiki/sensors/*.md (geen
 * externe APIs) en classificeert aggregaat-regime over markt/macro/levels/liquidity.
 *
 * Bronnen:
 *   - market.md       : 4h-regime (BULL_4H / BEAR_4H / RANGE)
 *   - macro-regime.md : hoofd-regime (RISK-ON / RISK-OFF / TRANSITION)
 *                       real-yield-regime (REAL-EASING / REAL-TIGHTENING / NEUTRAL)
 *                       liquidity-regime (M2-EXPANDING / M2-CONTRACTING / M2-FLAT)
 *   - watchlist.md    : regime (LEVEL_HIT / LEVEL_APPROACHING / NEUTRAL)
 *   - liquidity-tide.md: regime per asset (LOW_TIDE/BALANCED/LONG_HEAVY/SHORT_HEAVY/MAGNET_ABOVE/MAGNET_BELOW/HIGH_TIDE)
 *                        aggregaat (MIXED of meerderheid)
 *
 * Score: elke sensor levert -1 (bearish) / 0 (neutraal) / +1 (bullish).
 * Aggregaat regime:
 *   ALIGNED_LONG  — ≥3 bullish suppliers (n_fresh ≥ 3)
 *   ALIGNED_SHORT — ≥3 bearish suppliers
 *   DIVERGENT     — ≥2 bullish én ≥2 bearish
 *   WAIT          — anders (mostly neutral)
 *
 * Fresh-criterium: leverancier-markdown last_attempted_at < 24u oud.
 * N/A score (`null`) bij <3 fresh leveranciers — gedocumenteerd in methodologie.
 *
 * Cadens: 4u.
 */

const WIKI_REPO = 'nestfriesland-ctrl/wiki';
const SENSOR_PATH = 'sensors/confluence.md';

const SUPPLIERS = [
  'sensors/market.md',
  'sensors/macro-regime.md',
  'sensors/watchlist.md',
  'sensors/liquidity-tide.md',
];

const FRESH_MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24u

const CAP_KOP = 90;
const CAP_STELLING = 240;
const CAP_BEWIJS = 140;
const CAP_LES = 140;
const CAP_ACTIE = 140;

async function fetchWikiFile(path) {
  const PAT = process.env.GITHUB_PAT;
  if (!PAT) throw new Error('no_pat');
  const r = await fetch(`https://api.github.com/repos/${WIKI_REPO}/contents/${path}?ref=main`, {
    headers: { Authorization: `token ${PAT}`, Accept: 'application/vnd.github+json', 'User-Agent': 'pulse-confluence' },
  });
  if (!r.ok) return null;
  const j = await r.json();
  if (!j.content) return null;
  return Buffer.from(j.content, 'base64').toString('utf-8');
}

function parseFrontmatter(md) {
  if (!md || typeof md !== 'string') return {};
  // BOM- en CRLF-tolerant: strip optional UTF-8 BOM, accept \r\n line endings.
  const stripped = md.replace(/^﻿/, '');
  const m = stripped.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return {};
  const fm = {};
  for (const line of m[1].split(/\r?\n/)) {
    const lm = line.match(/^([a-z_0-9]+):\s*(.+)$/i);
    if (lm) fm[lm[1]] = lm[2].trim();
  }
  return fm;
}

function ageMs(timestampStr) {
  if (!timestampStr || timestampStr === 'never' || timestampStr === '—') return null;
  const t = Date.parse(timestampStr);
  if (Number.isNaN(t)) return null;
  return Date.now() - t;
}

function isFresh(fm) {
  const ts = fm.last_successful_at || fm.last_attempted_at || fm.last_updated;
  const age = ageMs(ts);
  return age != null && age < FRESH_MAX_AGE_MS;
}

// Score function per leverancier (-1 / 0 / +1)
function scoreMarket(fm) {
  switch (fm.regime) {
    case 'BULL_4H': return 1;
    case 'BEAR_4H': return -1;
    default: return 0;
  }
}

function scoreMacro(fm) {
  // Combineer hoofd-regime met real-yield + liquidity
  let s = 0;
  if (fm.regime === 'RISK-ON') s += 1;
  else if (fm.regime === 'RISK-OFF') s -= 1;
  if (fm.liquidity_regime === 'M2-EXPANDING') s += 0.5;
  else if (fm.liquidity_regime === 'M2-CONTRACTING') s -= 0.5;
  if (fm.real_yield_regime === 'REAL-EASING') s += 0.25;
  else if (fm.real_yield_regime === 'REAL-TIGHTENING') s -= 0.25;
  // Clamp naar -1/0/+1 op basis van magnitude
  if (s >= 0.75) return 1;
  if (s <= -0.75) return -1;
  return 0;
}

function scoreWatchlist(fm) {
  // LEVEL_HIT / LEVEL_APPROACHING — geen directional bias zonder context
  // Hits zijn risico-events, default naar -1 (alert).
  switch (fm.regime) {
    case 'LEVEL_HIT': return -1;
    case 'LEVEL_APPROACHING': return 0;
    default: return 0;
  }
}

function scoreLiquidityTide(fm) {
  // Hyblock cluster-skew: LONG_HEAVY = cascade-risk DOWN = bearish; SHORT_HEAVY = squeeze-risk UP = bullish
  switch (fm.regime) {
    case 'SHORT_HEAVY':
    case 'MAGNET_ABOVE':
    case 'HIGH_TIDE':
      return 1;
    case 'LONG_HEAVY':
    case 'MAGNET_BELOW':
    case 'LOW_TIDE':
      return -1;
    default: return 0;
  }
}

function classifyConfluence(scores) {
  const fresh = scores.filter(s => s !== null);
  if (fresh.length < 3) return { regime: 'WAIT', detail: `n_fresh=${fresh.length} <3 — score N/A` };
  const bullish = fresh.filter(s => s > 0).length;
  const bearish = fresh.filter(s => s < 0).length;
  if (bullish >= 3) return { regime: 'ALIGNED_LONG', detail: `${bullish} bullish suppliers` };
  if (bearish >= 3) return { regime: 'ALIGNED_SHORT', detail: `${bearish} bearish suppliers` };
  if (bullish >= 2 && bearish >= 2) return { regime: 'DIVERGENT', detail: `${bullish} bull / ${bearish} bear` };
  return { regime: 'WAIT', detail: `${bullish} bull / ${bearish} bear (under threshold)` };
}

// ── Wiki I/O ────────────────────────────────────────────────
async function loadPreviousMarkdown() {
  const PAT = process.env.GITHUB_PAT;
  if (!PAT) return null;
  const r = await fetch(`https://api.github.com/repos/${WIKI_REPO}/contents/${SENSOR_PATH}?ref=main`, {
    headers: { Authorization: `token ${PAT}`, Accept: 'application/vnd.github+json', 'User-Agent': 'pulse-confluence' },
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
    message: `sensor(confluence): ${new Date().toISOString().slice(0, 16)} dispatch`,
    content: Buffer.from(content, 'utf-8').toString('base64'),
    branch: 'main',
  };
  if (prevSha) body.sha = prevSha;
  const r = await fetch(`https://api.github.com/repos/${WIKI_REPO}/contents/${SENSOR_PATH}`, {
    method: 'PUT',
    headers: { Authorization: `token ${PAT}`, Accept: 'application/vnd.github+json', 'Content-Type': 'application/json', 'User-Agent': 'pulse-confluence' },
    body: JSON.stringify(body),
  });
  return r.ok;
}

function readCycleCountFromMd(md) {
  if (!md) return 0;
  const m = md.match(/^cycle_count:\s*(\d+)/m);
  return m ? parseInt(m[1], 10) : 0;
}

function cap(s, n) { return s == null ? '' : (s.length <= n ? s : s.slice(0, n - 1) + '…'); }

function buildKrant({ regime, perSupplier, nFresh }) {
  const verb = regime === 'ALIGNED_LONG' ? 'aligneert long' : regime === 'ALIGNED_SHORT' ? 'aligneert short' : regime === 'DIVERGENT' ? 'spreidt' : 'wacht';
  const kop = cap(`Confluence ${verb} — ${nFresh}/${SUPPLIERS.length} fresh, regime ${regime}.`, CAP_KOP);

  const stelling = cap(
    `Komend 4u-blok: regime ${regime} blijft stabiel als ${nFresh} fresh leveranciers hun score behouden; valsifieerbaar bij regime-flip in ≥1 leverancier of fresh-uitval (<24u-staleness).`,
    CAP_STELLING,
  );

  const supplierLine = Object.entries(perSupplier)
    .map(([k, v]) => {
      const score = (v && v.fresh && v.score != null) ? v.score : 'N/A';
      return `${k.replace('.md', '')}:${score}`;
    })
    .join(' | ');
  const bewijs = cap(`Suppliers: ${supplierLine}.`, CAP_BEWIJS);

  const les = cap(
    nFresh < 3
      ? 'Confluence N/A bij <3 fresh leveranciers — pipeline-uitval impacteert aggregaat direct.'
      : regime === 'ALIGNED_LONG'
        ? '≥3 bullish suppliers = condities voor long; bevestig met liquidity-tide cluster-leeg.'
        : regime === 'ALIGNED_SHORT'
          ? '≥3 bearish suppliers = condities voor short; bevestig met levels-hit.'
          : regime === 'DIVERGENT'
            ? 'Tegenstrijdige signalen = ruis — geen trade tot één kant alignt.'
            : 'Geen meerderheid = wachten loont.',
    CAP_LES,
  );

  const actie = cap(
    nFresh < 3
      ? 'Repareer dood leveranciers voor confluence weer waarde levert.'
      : regime === 'ALIGNED_LONG'
        ? 'Long-setup binnen risk-budget; entry op pullback, niet chase.'
        : regime === 'ALIGNED_SHORT'
          ? 'Short-setup binnen risk-budget; entry op rally, niet chase.'
          : 'Geen nieuwe positie; observeer leverancier-flips.',
    CAP_ACTIE,
  );

  return { kop, stelling, bewijs, les, actie };
}

function buildMarkdown({
  cycleCount, lastAttemptedAt, lastSuccessfulAt,
  regime, perSupplier, nFresh, totalScore, errors,
}) {
  const krant = buildKrant({ regime, perSupplier, nFresh });

  return [
    '---',
    'sensor: confluence',
    `regime: ${regime}`,
    `last_attempted_at: ${lastAttemptedAt}`,
    `last_successful_at: ${lastSuccessfulAt || 'never'}`,
    `last_updated: ${lastAttemptedAt}`,
    'freshness: 0',
    'confidence: HARD',
    `cycle_count: ${cycleCount}`,
    `n_fresh: ${nFresh}`,
    `n_suppliers: ${SUPPLIERS.length}`,
    `aggregate_score: ${totalScore}`,
    ...Object.entries(perSupplier).map(([k, v]) => {
      const score = (v && v.fresh && v.score != null) ? v.score : 'NA';
      return `${k.replace('.md', '').replace('-', '_')}_score: ${score}`;
    }),
    '---',
    '',
    '# Confluence',
    '',
    `> Run ${cycleCount} — ${lastAttemptedAt}. Regime: **${regime}** (${nFresh}/${SUPPLIERS.length} fresh).`,
    '',
    '## Scorebord',
    '',
    '| Supplier | Regime | Score | Fresh | Last Successful |',
    '|----------|--------|-------|-------|------------------|',
    ...Object.entries(perSupplier).map(([k, v]) => {
      const regime = (v && v.regime) || '—';
      const score = (v && v.fresh && v.score != null) ? v.score : 'N/A';
      const fresh = v && v.fresh ? '✓' : '✗ STALE';
      const last = (v && v.last) || '—';
      return `| ${k.replace('.md', '')} | ${regime} | ${score} | ${fresh} | ${last} |`;
    }),
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
    `Bronnen: wiki/sensors/{market,macro-regime,watchlist,liquidity-tide}.md frontmatter. GEEN externe APIs. Cadens 4u.`,
    `Score per leverancier: -1 bearish, 0 neutraal, +1 bullish. Macro combineert regime + liquidity + real-yield. Liquidity-tide cluster-skew geïnverteerd (LONG_HEAVY = cascade-risk-DOWN = bearish).`,
    `Aggregaat: ALIGNED_LONG = ≥3 bullish; ALIGNED_SHORT = ≥3 bearish; DIVERGENT = ≥2 bull én ≥2 bear; WAIT = anders.`,
    `Fresh-criterium: leverancier last_successful_at < 24u oud. Bij <3 fresh: confluence-score N/A en regime WAIT (gedocumenteerd als N/A i.p.v. valse meerderheid).`,
    errors && errors.length ? `\n> errors: ${errors.join(' | ')}` : '',
  ].filter(l => l !== '').join('\n');
}

async function runConfluence(req) {
  const lastAttemptedAt = new Date().toISOString();

  let cycleCount = 1;
  let prevSha = null;
  let lastSuccessfulAt = null;
  try {
    const prev = await loadPreviousMarkdown();
    if (prev) {
      prevSha = prev.sha;
      cycleCount = readCycleCountFromMd(prev.content) + 1;
      const lsa = prev.content.match(/^last_successful_at:\s*([^\n]+)/m);
      if (lsa && lsa[1].trim() !== 'never') lastSuccessfulAt = lsa[1].trim();
    }
  } catch (_) { /* first run */ }

  const errors = [];
  const safe = async (label, p) => {
    try { return await p; }
    catch (e) { errors.push(`${label}:${e.message}`); return null; }
  };

  const supplierMd = await Promise.all(SUPPLIERS.map(p => safe(p, fetchWikiFile(p))));
  // Vang 404's expliciet — fetchWikiFile geeft null terug, leg dat vast in errors zodat de oorzaak zichtbaar is.
  for (let i = 0; i < SUPPLIERS.length; i++) {
    if (supplierMd[i] == null) errors.push(`${SUPPLIERS[i]}:404_or_empty`);
  }
  const scoreFns = { 'sensors/market.md': scoreMarket, 'sensors/macro-regime.md': scoreMacro, 'sensors/watchlist.md': scoreWatchlist, 'sensors/liquidity-tide.md': scoreLiquidityTide };

  const perSupplier = {};
  const scores = [];
  for (let i = 0; i < SUPPLIERS.length; i++) {
    const path = SUPPLIERS[i];
    const md = supplierMd[i];
    const fm = parseFrontmatter(md);
    const fresh = isFresh(fm);
    let s = null;
    try {
      s = (md && fresh) ? scoreFns[path](fm) : null;
    } catch (e) {
      errors.push(`score:${path}:${e.message}`);
    }
    perSupplier[path.replace('sensors/', '')] = {
      regime: fm.regime || null,
      score: s,
      fresh,
      last: fm.last_successful_at || fm.last_attempted_at || fm.last_updated || null,
    };
    scores.push(s);
  }

  const nFresh = scores.filter(s => s !== null).length;
  const totalScore = scores.filter(s => s !== null).reduce((a, b) => a + b, 0);
  const cls = classifyConfluence(scores);

  const successAt = new Date().toISOString();
  const md = buildMarkdown({
    cycleCount, lastAttemptedAt, lastSuccessfulAt: successAt,
    regime: cls.regime, perSupplier, nFresh, totalScore, errors,
  });

  const written = await writeToWiki(md, prevSha).catch(() => false);

  return {
    regime: cls.regime, cycleCount, written, errors,
    snapshot: { perSupplier, nFresh, totalScore, detail: cls.detail },
    trigger: req.body?.trigger || 'manual',
  };
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  try {
    const result = await runConfluence(req);
    return res.status(200).json(result);
  } catch (e) {
    // Top-level vangnet: voorkom opaque FUNCTION_INVOCATION_FAILED — toon stack in response.
    return res.status(500).json({
      error: 'confluence_runner_crash',
      message: e && e.message,
      stack: e && e.stack,
    });
  }
}
