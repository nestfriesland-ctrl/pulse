// PULSE — Wiki renderer + sensor dashboard
// Zero dependencies (d3 + marked from CDN)

const API = '/api/wiki';
const REGISTRY_PATH = 'operations/sensor-registry.md';

let tree = null;
let cache = {};
let registry = null;
let sensors = [];

// --- Sensor roles: layout + renderer choice ------------------------------
// Group order = visual row order. Each group renders as its own 12-col row.
// Sensors not listed default to { group: 'research', span: 3, renderer: 'generic' }.
const SENSOR_ROLES = {
  'thesis-trader': { group: 'top', span: 4, renderer: 'thesis-trader', label: 'thesis-trader' },
  'market':        { group: 'top', span: 4, renderer: 'market',        label: 'market' },
  'anti-fragile':  { group: 'top', span: 4, renderer: 'anti-fragile',  label: 'anti-fragile' },
  'watchlist':     { group: 'mid', span: 6, renderer: 'watchlist',     label: 'watchlist' },
  'nest-seo':      { group: 'mid', span: 6, renderer: 'nest-seo',      label: 'nest-seo' },
  'infra':         { group: 'ops', span: 4, renderer: 'infra',         label: 'infra' },
  'enrichment':    { group: 'ops', span: 4, renderer: 'enrichment',    label: 'enrichment' },
  'machinekamer':  { group: 'ops', span: 4, renderer: 'generic',       label: 'machinekamer' },
};
const GROUP_ORDER = ['top', 'mid', 'ops', 'research'];
const DEFAULT_ROLE = { group: 'research', span: 3, renderer: 'generic' };

// --- API layer -----------------------------------------------------------

async function fetchTree() {
  if (tree) return tree;
  const r = await fetch(`${API}?path=_tree`);
  if (!r.ok) throw new Error('Failed to load wiki tree');
  const data = await r.json();
  tree = data.tree ? data.tree.filter(f => f.type === 'blob' && f.path.endsWith('.md')) : [];
  return tree;
}

async function fetchFile(path) {
  if (cache[path]) return cache[path];
  const r = await fetch(`${API}?path=${encodeURIComponent(path)}`);
  if (!r.ok) throw new Error(`Failed to load ${path}`);
  const data = await r.json();
  const content = data.decoded_content || (data.content ? atob(data.content) : '');
  cache[path] = content;
  return content;
}

async function fetchSensorListing() {
  const r = await fetch(`${API}?path=_sensors`);
  if (!r.ok) throw new Error('Failed to load sensor listing');
  const data = await r.json();
  if (!Array.isArray(data)) return [];
  return data
    .filter(f => f.type === 'file' && f.name.endsWith('.md') && f.name !== 'README.md')
    .map(f => f.name.replace(/\.md$/, ''));
}

// --- Sensor registry parsing --------------------------------------------
// Extract { sensorStem -> { verdict, status } } from operations/sensor-registry.md.
// The registry uses h3 headings like "### infra-sensor" and bullet lines
// "- **Oordeel:** WAARDE-BEWEZEN ...". Some entries also use "- **Status:** GEARCHIVEERD".
// Match by stripping common suffixes (-sensor, -monitor, -cycle) so file names
// like "infra" map to "infra-sensor".

const REGISTRY_NAME_OVERRIDES = {
  'anti-fragile': 'anti-fragile-sensor',
  'ta-setups': 'ta-chart-sensor',
  'travel': 'travel-buddy',
};

function stripSensorSuffix(name) {
  return name.replace(/-(sensor|monitor|cycle)$/, '');
}

async function fetchRegistry() {
  if (registry) return registry;
  let raw;
  try {
    raw = await fetchFile(REGISTRY_PATH);
  } catch (e) {
    registry = {};
    return registry;
  }
  registry = {};
  const sectionRe = /^###\s+(.+?)\s*$/gm;
  const matches = [];
  let m;
  while ((m = sectionRe.exec(raw)) !== null) {
    matches.push({ name: m[1].trim(), index: m.index });
  }
  for (let i = 0; i < matches.length; i++) {
    const start = matches[i].index;
    const end = i + 1 < matches.length ? matches[i + 1].index : raw.length;
    const body = raw.slice(start, end);
    const verdictMatch = body.match(/\*\*Oordeel:\*\*\s*([A-Z\-]+)/);
    const statusMatch = body.match(/\*\*Status:\*\*\s*([A-Z\-]+)/);
    // Strip parenthetical descriptors like "machinekamer (META)" or
    // "cortex (Whoop N=1)" so the key matches the file stem.
    const baseName = matches[i].name.split(/\s*\(/)[0].trim();
    const key = stripSensorSuffix(baseName).toLowerCase();
    registry[key] = {
      fullName: matches[i].name,
      verdict: verdictMatch ? verdictMatch[1] : null,
      status: statusMatch ? statusMatch[1] : null,
    };
  }
  return registry;
}

function lookupRegistry(sensorName) {
  if (!registry) return null;
  const override = REGISTRY_NAME_OVERRIDES[sensorName];
  if (override) {
    const key = stripSensorSuffix(override).toLowerCase();
    if (registry[key]) return registry[key];
  }
  return registry[sensorName] || null;
}

// Decide whether a sensor should appear at all. Hide GEARCHIVEERD and
// KANDIDAAT-VERWIJDERING (cortex, travel) per brief.
function shouldDisplay(sensorName) {
  const reg = lookupRegistry(sensorName);
  if (!reg) return true;
  if (reg.status === 'GEARCHIVEERD') return false;
  if (reg.status === 'KANDIDAAT-VERWIJDERING') return false;
  if (reg.verdict === 'KANDIDAAT-VOOR-VERWIJDERING') return false;
  return true;
}

function prominenceClass(sensorName) {
  const reg = lookupRegistry(sensorName);
  if (!reg) return '';
  if (reg.verdict === 'WAARDE-BEWEZEN') return 'prom-proven';
  if (reg.verdict === 'ONBEWEZEN') return 'prom-unproven';
  if (reg.verdict === 'META' || reg.verdict === 'META-SENSOR') return 'prom-meta';
  return '';
}

// --- Sensor meta parsing -------------------------------------------------

function parseSensorMeta(content) {
  const meta = { lastUpdated: null, hoursAgo: null, status: 'unknown', notDeployed: false };

  if (/^[>\s]*status:\s*NOT[_ ]DEPLOYED/mi.test(content)) {
    meta.notDeployed = true;
    return meta;
  }

  // last_updated: matches both YAML frontmatter and `> last_updated:` quote forms.
  let tsMatch = content.match(/^[>\s-]*last_updated:\s*([^\n]+)/mi);
  if (!tsMatch) {
    // Anti-fragile-style: "**Cycle:** 153 (6 May 2026 ~10:00 UTC)" — pull date
    // out of the parenthetical so the freshness badge still works.
    const parenDate = content.match(/\*\*Cycle:\*\*[^\(]*\((\d{1,2}\s+\w+\s+\d{4}[^)]*)\)/);
    if (parenDate) tsMatch = [null, parenDate[1].replace(/~/, '')];
  }
  if (!tsMatch) {
    // Thesis-trader-style: "**Run:** 2026-05-06 (UTC) | ..."
    const runMatch = content.match(/\*\*Run:\*\*\s*(\d{4}-\d{2}-\d{2})/);
    if (runMatch) tsMatch = [null, runMatch[1]];
  }
  if (tsMatch) {
    meta.lastUpdated = tsMatch[1].trim();
    if (meta.lastUpdated === '—' || meta.lastUpdated === '-') {
      meta.notDeployed = true;
      return meta;
    }
    try {
      const dt = new Date(meta.lastUpdated);
      if (!isNaN(dt.getTime())) {
        meta.hoursAgo = Math.floor((Date.now() - dt.getTime()) / 3600000);
      }
    } catch (e) { /* invalid date */ }
  }

  if (meta.hoursAgo !== null) {
    meta.status = meta.hoursAgo < 4 ? 'fresh' : meta.hoursAgo < 12 ? 'stale' : 'down';
  }

  return meta;
}

// --- Generic parsers (Machinekamer protocol) -----------------------------

function parseRegime(content) {
  // Quoted form: "> regime: RALLY". Frontmatter form: "regime: RALLY".
  let m = content.match(/^>\s*regime:\s*(.+)/mi);
  if (m) return m[1].trim();
  m = content.match(/^regime:\s*(.+)/mi);
  if (m) return m[1].trim();
  // Anti-fragile style: "**State:** NO_NEW_FIRE / ..." — first segment.
  m = content.match(/\*\*State:\*\*\s*([^\/\n]+)/);
  if (m) return m[1].trim();
  return null;
}

function parseKrant(content) {
  const krant = {};
  const stellingMatch = content.match(/\*\*Stelling:\*\*\s*(.+)/);
  const bewijsMatch = content.match(/\*\*Bewijs:\*\*\s*([\s\S]*?)(?=\n\*\*Les:|\n\*\*Actie:|\n##)/);
  const lesMatch = content.match(/\*\*Les:\*\*\s*(.+)/);
  const actieMatch = content.match(/\*\*Actie:\*\*\s*(.+)/);

  krant.stelling = stellingMatch ? stellingMatch[1].trim() : null;
  krant.bewijs = bewijsMatch ? bewijsMatch[1].trim() : null;
  krant.les = lesMatch ? lesMatch[1].trim() : null;
  krant.actie = actieMatch ? actieMatch[1].trim() : null;

  const vorigeMatch = content.match(/\*\*Vorige stelling:\*\*\s*(.+)/);
  const uitkomstMatch = content.match(/\*\*Uitkomst:\*\*\s*(\w+)/);
  const toelichtingMatch = content.match(/\*\*Toelichting:\*\*\s*(.+)/);

  krant.vorigeStelling = vorigeMatch ? vorigeMatch[1].trim() : null;
  krant.uitkomst = uitkomstMatch ? uitkomstMatch[1].trim() : null;
  krant.toelichting = toelichtingMatch ? toelichtingMatch[1].trim() : null;

  krant.hasKrant = !!(krant.stelling || krant.les);
  return krant;
}

function renderKrantSection(krant) {
  if (!krant.hasKrant) return '';

  const uitkomstClass = krant.uitkomst === 'BEVESTIGD' ? 'pos'
    : krant.uitkomst === 'WEERLEGD' ? 'neg' : 'neutral';

  const preview = krant.stelling
    ? krant.stelling.substring(0, 70) + (krant.stelling.length > 70 ? '...' : '')
    : '';

  return `
    <div class="krant-section" onclick="event.stopPropagation(); this.classList.toggle('krant-open')">
      <div class="krant-toggle">▸ ${preview || 'Krant'}</div>
      <div class="krant-body">
        ${krant.stelling ? `<div class="krant-row"><span class="krant-label">Stelling</span><span class="krant-value">${krant.stelling}</span></div>` : ''}
        ${krant.bewijs ? `<div class="krant-row"><span class="krant-label">Bewijs</span><span class="krant-value">${krant.bewijs}</span></div>` : ''}
        ${krant.les ? `<div class="krant-row krant-les"><span class="krant-label">Les</span><span class="krant-value">${krant.les}</span></div>` : ''}
        ${krant.actie ? `<div class="krant-row"><span class="krant-label">Actie</span><span class="krant-value">${krant.actie}</span></div>` : ''}
        ${krant.vorigeStelling ? `
          <div class="krant-terugblik">
            <div class="krant-row"><span class="krant-label">Vorige</span><span class="krant-value">${krant.vorigeStelling}</span></div>
            <div class="krant-row"><span class="krant-label">Uitkomst</span><span class="krant-value ${uitkomstClass}">${krant.uitkomst || '—'}</span></div>
            ${krant.toelichting ? `<div class="krant-row"><span class="krant-label"></span><span class="krant-value krant-dim">${krant.toelichting}</span></div>` : ''}
          </div>` : ''}
      </div>
    </div>
  `;
}

function regimeColor(regime) {
  if (!regime) return 'regime-unknown';
  const r = regime.toLowerCase();
  if (['rally','nominal','flowing','growing','validated','rotation','risk-on','bullish_bias','bullish-bias'].some(p => r.startsWith(p))) return 'regime-pos';
  if (['correction','capitulation','down','stalled','declining','falsified','bearish','dead_cycle','degraded'].some(p => r.startsWith(p))) return 'regime-neg';
  return 'regime-neutral';
}

// --- Sensor-specific parsers --------------------------------------------

function stripTags(s) {
  return s ? s.replace(/\s*\[[A-Z]+\]/g, '').trim() : s;
}

function colorClass(val) {
  if (!val) return '';
  return val.startsWith('-') ? 'neg' : 'pos';
}

function shortFunding(s) {
  if (!s) return null;
  // Look for a real funding rate: signed decimal (with ".") or scientific
  // notation, optionally with %. Skip bare integers (avoids matching "5"
  // from "settle 5/6").
  const m = s.match(/(-?\d+\.\d+(?:e-?\d+)?%?)/);
  if (m) return m[1];
  const pct = s.match(/(-?\d+%)/);
  return pct ? pct[1] : truncate(s, 14);
}

function parseMarket(content) {
  const tableRows = [];
  const tableRe = /^\|\s*(BTC|ETH)\s*\|\s*\$?([0-9,]+(?:\.[0-9]+)?)\s*\|\s*([+-]?[0-9.]+%)\s*\|\s*([+-]?[0-9.]+%)\s*\|\s*(-?[0-9.]+%)\s*\|/gm;
  let m;
  while ((m = tableRe.exec(content)) !== null) {
    tableRows.push({ asset: m[1], price: m[2], d24h: m[3], d7d: m[4], ath: m[5] });
  }

  if (tableRows.length > 0) {
    const btc = tableRows.find(r => r.asset === 'BTC');
    const eth = tableRows.find(r => r.asset === 'ETH');
    const fgMatch = content.match(/Fear & Greed:\s*(\d+)\s*\(([^)]+)\)/);
    const domMatch = content.match(/BTC Dominance:\s*([0-9.]+)%/);
    const fundingMatch = content.match(/Funding:\s*([^\n]+)/);
    const macroMatch = content.match(/Macro:\s*([^\n]+)/);

    return {
      btcPrice: btc ? btc.price : null,
      btc24h: btc ? btc.d24h : null,
      btc7d: btc ? btc.d7d : null,
      btcAthDist: btc ? btc.ath : null,
      ethPrice: eth ? eth.price : null,
      eth24h: eth ? eth.d24h : null,
      ethAthDist: eth ? eth.ath : null,
      fearGreed: fgMatch ? { score: fgMatch[1], label: fgMatch[2] } : null,
      dominance: domMatch ? domMatch[1] : null,
      funding: fundingMatch ? shortFunding(stripTags(fundingMatch[1])) : null,
      macro: macroMatch ? truncate(stripTags(macroMatch[1]), 140) : null,
    };
  }

  // Fallback: old inline format
  const btcMatch = content.match(/BTC:\s*\$([0-9,]+)\s*\|\s*24h:\s*([+-][0-9.]+%)/);
  const ethMatch = content.match(/ETH:\s*\$([0-9,]+)\s*\|\s*24h:\s*([+-][0-9.]+%)/);
  const btcAthMatch = content.match(/ATH afstand:\s*(-[0-9.]+%)/);
  const macroMatch2 = content.match(/Macro:\s*([^\n]+)/);

  return {
    btcPrice: btcMatch ? btcMatch[1] : null,
    btc24h: btcMatch ? btcMatch[2] : null,
    btc7d: null,
    btcAthDist: btcAthMatch ? btcAthMatch[1] : null,
    ethPrice: ethMatch ? ethMatch[1] : null,
    eth24h: ethMatch ? ethMatch[2] : null,
    ethAthDist: null,
    fearGreed: null,
    dominance: null,
    funding: null,
    macro: macroMatch2 ? truncate(stripTags(macroMatch2[1]), 140) : null,
  };
}

function truncate(s, n) {
  if (!s) return s;
  return s.length > n ? s.substring(0, n - 1) + '…' : s;
}

function parseInfra(content) {
  const sitesMatch = content.match(/SITES:\s*(.+)/m);
  const deploysMatch = content.match(/DEPLOYS:\s*(.+)/m);
  const gitMatch = content.match(/GIT:\s*(.+)/m);
  const bridgeMatch = content.match(/M4-BRIDGE:\s*(.+)/m);

  const sites = [];
  if (sitesMatch) {
    for (const part of stripTags(sitesMatch[1]).split('|')) {
      const m = part.trim().match(/^(\S+)\s+(\d{3})$/);
      if (m) sites.push({ name: m[1], code: parseInt(m[2]) });
    }
  }

  const deploys = [];
  if (deploysMatch) {
    for (const part of stripTags(deploysMatch[1]).split('|')) {
      const m = part.trim().match(/^(\S+)\s+(\w+)/);
      if (m) deploys.push({ name: m[1], status: m[2] });
    }
  }

  return {
    sites,
    deploys,
    git: gitMatch ? truncate(stripTags(gitMatch[1]), 160) : null,
    bridge: bridgeMatch ? stripTags(bridgeMatch[1]) : null,
  };
}

function parseNestSeo(content) {
  const drMatch = content.match(/DR:\s*([0-9.]+)/);
  // "Ref domains: 46 (live) / 71 (all-time)"
  const refMatch = content.match(/Ref domains:\s*(\d+)\s*\(?\s*live\)?/i);
  // "Live backlinks: 668" (new) or "Backlinks: 668 live" (old).
  const blMatch = content.match(/Live backlinks:\s*(\d+)/i)
    || content.match(/Backlinks:\s*(\d+)\s*live/i);
  const trendMatch = content.match(/Trend:\s*(.+)/);

  const backlinkRows = [];
  // Format: "domain | DR XX | (number )?(do|no)follow | YYYY-MM-DD"
  // Examples:
  //   "thehighrankseo.shop | DR 35 | nofollow | 2026-05-05 [HARD]"
  //   "provenexpert.com | DR 91 | 1 dofollow | 2026-04-30"
  const re = /^([a-z0-9.-]+\.[a-z]+)\s*\|\s*DR\s*(\d+)\s*\|\s*(?:(\d+)\s*)?(\w+follow)\s*\|\s*([0-9-]+)/gmi;
  let m;
  while ((m = re.exec(content)) !== null) {
    backlinkRows.push({
      domain: m[1],
      dr: m[2],
      count: m[3] || '—',
      type: m[4],
      date: m[5].trim(),
    });
  }

  return {
    dr: drMatch ? drMatch[1] : null,
    refDomains: refMatch ? refMatch[1] : null,
    backlinks: blMatch ? blMatch[1] : null,
    backlinkRows: backlinkRows.slice(0, 5),
    trend: trendMatch ? stripTags(trendMatch[1]) : null,
  };
}

// Enrichment now uses a per-tenant table. Extract the SKYLD row + delta.
function parseEnrichment(content) {
  const tenants = [];
  // | SKYLD  | 5490      | +144  | 0       | 9m geleden        | 20/20    |
  const tableRe = /^\|\s*(SKYLD|SANND|NEST)\s*\|\s*(\d+)\s*\|\s*([+-]?\d+)\s*\|\s*(\d+)\s*\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|/gm;
  let m;
  while ((m = tableRe.exec(content)) !== null) {
    tenants.push({
      tenant: m[1],
      filled: m[2],
      delta: m[3],
      backlog: m[4],
      lastEnriched: m[5].trim(),
    });
  }

  const lastHourMatch = content.match(/Writes laatste uur:\s*SKYLD=(\d+)/);
  const last6hMatch = content.match(/Writes laatste 6u:\s*SKYLD=(\d+)/);

  return {
    tenants,
    skyldLastHour: lastHourMatch ? lastHourMatch[1] : null,
    skyldLast6h: last6hMatch ? last6hMatch[1] : null,
  };
}

function parseWatchlist(content) {
  const assets = [];
  // Tolerant column 6 (volume) — accepts "1.96K", "366.07M", "—".
  const tableRe = /^\|\s*([A-Z]+)\s*\|\s*(\S+)\s*\|\s*([+-][0-9.]+%|—|-)\s*\|\s*(\S+)\s*\|\s*(\S+)\s*\|\s*(\S+)\s*\|/gm;
  let m;
  while ((m = tableRe.exec(content)) !== null) {
    if (m[1] === 'Asset') continue;
    const deltaStr = m[3];
    const deltaNum = parseFloat(deltaStr.replace('%', '').replace('+', ''));
    assets.push({
      asset: m[1],
      price: m[2],
      delta: deltaStr,
      deltaNum: isNaN(deltaNum) ? 0 : deltaNum,
      high: m[4],
      low: m[5],
      volume: m[6],
    });
  }

  const signals = [];
  const signalsMatch = content.match(/## Signalen\n([\s\S]*?)(?:\n##|$)/);
  if (signalsMatch) {
    for (const line of signalsMatch[1].split('\n')) {
      const s = line.replace(/^-\s*/, '').trim();
      if (s) signals.push(truncate(s, 220));
    }
  }

  return { assets, signals: signals.slice(0, 4) };
}

function parseAntiFrag(content) {
  // New format uses **Cycle:** 153 (...) and **State:** NO_NEW_FIRE / ...
  const cycleMatch = content.match(/\*\*Cycle:\*\*\s*([^\n]+)/)
    || content.match(/[Cc]ycle[:\s#]+([^\n]+)/);
  const stateMatch = content.match(/\*\*State:\*\*\s*([^\n]+)/);
  const tradeMatch = content.match(/##\s+Trade events\s*\n+([^\n]+)/);
  // Pull BTC row from tickers table for a quick price reference.
  const btcRow = content.match(/^\|\s*BTC\s*\|\s*\$?([0-9.,]+)\s*\|\s*([+-][0-9.,]+%?)\s*\|\s*([+-][0-9.,]+%?)/m);
  return {
    cycle: cycleMatch ? truncate(cycleMatch[1].trim(), 80) : null,
    state: stateMatch ? truncate(stateMatch[1].trim(), 200) : null,
    trade: tradeMatch ? truncate(tradeMatch[1].trim(), 140) : null,
    btcPrice: btcRow ? btcRow[1] : null,
    btc4h: btcRow ? btcRow[2] : null,
    btc24h: btcRow ? btcRow[3] : null,
  };
}

function parseThesisTrader(content) {
  // "**Run:** 2026-05-06 (UTC) | **Status:** TRADE LIVE — geen actie"
  const statusMatch = content.match(/\*\*Status:\*\*\s*([^\n|]+)/);
  // "BTC: $82,076.36 (24h high $82,074 / low $80,685)"
  const priceMatch = content.match(/^-?\s*BTC:\s*\$([0-9,.]+)/m);
  // Open trade block — pull the bullets we care about.
  const openBlock = content.match(/##\s+Open trade\s+(\S+)[^\n]*\n([\s\S]+?)(?=\n##\s|$)/i);
  let trade = null;
  if (openBlock) {
    const id = openBlock[1];
    const body = openBlock[2];
    const entry = body.match(/Entry:\s*\$?([0-9,.]+)\s*@\s*([^\n|]+)\|\s*leeftijd:\s*([^\n]+)/);
    const mtm = body.match(/MTM\s+\*?\*?([+\-][0-9.,]+%)\s*\/\s*([+\-][0-9.,]+R)/);
    const tp1 = body.match(/TP1\s+\$?([0-9,.]+)[:\s]+\$?([0-9,.]+)\s+verwijderd[^\n]*?\(([~0-9.%-]+)\)/);
    const tp2 = body.match(/TP2\s+\$?([0-9,.]+)[:\s]+\$?([0-9,.]+)\s+verwijderd/);
    // SL line example:
    // "SL (4h close < 1H 200 EMA $78.920): VEILIG, $3.157 buffer"
    // Pull the dollar value (last $X.XXX in the parenthetical) and the status word after `):`.
    const sl = body.match(/SL[^\n]*?\$([0-9.,]+)[^\n]*\):\s*([A-Z]+)(?:[^\n]*?\$([0-9.,]+)\s*buffer)?/);
    const expiry = body.match(/Expiry\s+([\d\-]+):\s*(\d+\s*dagen)/);
    trade = {
      id,
      direction: (openBlock[0].match(/(LONG|SHORT)/) || [])[1] || null,
      entryPrice: entry ? entry[1] : null,
      entryWhen: entry ? entry[2].trim() : null,
      age: entry ? entry[3].trim() : null,
      mtmPct: mtm ? mtm[1] : null,
      mtmR: mtm ? mtm[2] : null,
      tp1: tp1 ? { price: tp1[1], distance: tp1[2], pct: tp1[3] } : null,
      tp2: tp2 ? { price: tp2[1], distance: tp2[2] } : null,
      sl: sl ? { price: sl[1], status: sl[2], buffer: sl[3] || null } : null,
      expiry: expiry ? { date: expiry[1], daysLeft: expiry[2] } : null,
    };
  }
  return {
    status: statusMatch ? statusMatch[1].trim() : null,
    price: priceMatch ? priceMatch[1] : null,
    trade,
  };
}

// --- Card renderers ------------------------------------------------------

function renderMarketCard(content) {
  const d = parseMarket(content);
  const krant = parseKrant(content);
  if (!d.btcPrice) return '<div class="card-waiting">Geen data</div>';

  return `
    <div class="market-primary">
      <div class="market-main">
        <div class="market-ticker">BTC</div>
        <div class="market-price">$${d.btcPrice}</div>
        <div class="market-change ${colorClass(d.btc24h)}">${d.btc24h}</div>
        ${d.btc7d ? `<div class="market-7d ${colorClass(d.btc7d)}">${d.btc7d} 7d</div>` : ''}
      </div>
      ${d.btcAthDist ? `<div class="market-ath-block">
        <div class="ath-label">van ATH</div>
        <div class="ath-value ${colorClass(d.btcAthDist)}">${d.btcAthDist}</div>
      </div>` : ''}
    </div>
    <div class="market-divider"></div>
    <div class="market-alt">
      ${d.ethPrice ? `<div class="market-alt-row">
        <span class="alt-ticker">ETH</span>
        <span class="alt-price">$${d.ethPrice}</span>
        <span class="alt-change ${colorClass(d.eth24h)}">${d.eth24h}</span>
        ${d.ethAthDist ? `<span class="alt-ath ${colorClass(d.ethAthDist)}">${d.ethAthDist}</span>` : ''}
      </div>` : ''}
    </div>
    ${d.fearGreed || d.dominance || d.funding ? `<div class="market-indicators">
      ${d.fearGreed ? `<span class="indicator"><span class="ind-label">F&G</span> <span class="ind-value">${d.fearGreed.score}</span></span>` : ''}
      ${d.dominance ? `<span class="indicator"><span class="ind-label">BTC.D</span> <span class="ind-value">${d.dominance}%</span></span>` : ''}
      ${d.funding ? `<span class="indicator"><span class="ind-label">FR</span> <span class="ind-value">${d.funding}</span></span>` : ''}
    </div>` : ''}
    ${d.macro ? `<div class="market-macro">${d.macro}</div>` : ''}
    ${renderKrantSection(krant)}
  `;
}

function renderNestSeoCard(content) {
  const d = parseNestSeo(content);
  const krant = parseKrant(content);

  const tableRows = d.backlinkRows.map(row => {
    const drNum = parseInt(row.dr);
    const drClass = drNum >= 70 ? 'dr-high' : drNum >= 30 ? 'dr-mid' : 'dr-low';
    return `<tr>
      <td class="bl-domain">${row.domain}</td>
      <td class="bl-dr ${drClass}">${row.dr}</td>
      <td class="bl-count">${row.type === 'dofollow' ? 'do' : 'no'}</td>
      <td class="bl-date">${row.date}</td>
    </tr>`;
  }).join('');

  return `
    <div class="seo-layout">
      <div class="seo-left">
        <div class="seo-dr-block">
          <div class="seo-dr-value">${d.dr || '—'}</div>
          <div class="seo-dr-label">Domain Rating</div>
        </div>
        <div class="seo-kpis">
          <div class="seo-kpi">
            <div class="seo-kpi-value">${d.refDomains || '—'}</div>
            <div class="seo-kpi-label">ref domains</div>
          </div>
          <div class="seo-kpi">
            <div class="seo-kpi-value">${d.backlinks || '—'}</div>
            <div class="seo-kpi-label">backlinks</div>
          </div>
        </div>
        ${d.trend ? `<div class="seo-trend">${d.trend}</div>` : ''}
      </div>
      ${tableRows ? `<div class="seo-right">
        <div class="seo-table-label">Nieuwe backlinks (7d)</div>
        <table class="seo-table">
          <thead><tr><th>Domain</th><th>DR</th><th>Type</th><th>Datum</th></tr></thead>
          <tbody>${tableRows}</tbody>
        </table>
      </div>` : ''}
    </div>
    ${renderKrantSection(krant)}
  `;
}

function renderInfraCard(content) {
  const d = parseInfra(content);
  const krant = parseKrant(content);

  const sitesDots = d.sites.map(s => {
    const ok = s.code >= 200 && s.code < 400;
    return `<div class="dot-row">
      <span class="dot ${ok ? 'dot-green' : 'dot-red'}"></span>
      <span class="dot-name">${s.name}</span>
      <span class="dot-code">${s.code}</span>
    </div>`;
  }).join('');

  const deployDots = d.deploys.map(dep => {
    const ok = dep.status === 'READY';
    return `<div class="dot-row">
      <span class="dot ${ok ? 'dot-green' : 'dot-red'}"></span>
      <span class="dot-name">${dep.name}</span>
    </div>`;
  }).join('');

  return `
    ${sitesDots ? `<div class="infra-section">
      <div class="infra-label">SITES</div>
      <div class="infra-dots">${sitesDots}</div>
    </div>` : ''}
    ${deployDots ? `<div class="infra-section">
      <div class="infra-label">DEPLOYS</div>
      <div class="infra-dots">${deployDots}</div>
    </div>` : ''}
    ${d.git ? `<div class="infra-meta"><span class="infra-meta-key">GIT</span> ${d.git}</div>` : ''}
    ${d.bridge ? `<div class="infra-meta"><span class="infra-meta-key">BRIDGE</span> ${d.bridge}</div>` : ''}
    ${renderKrantSection(krant)}
  `;
}

function renderEnrichmentCard(content) {
  const d = parseEnrichment(content);
  const krant = parseKrant(content);
  if (!d.tenants.length) return '<div class="card-waiting">Geen data</div>';

  const rows = d.tenants.map(t => {
    const dn = parseInt(t.delta);
    const deltaCls = dn > 0 ? 'pos' : dn < 0 ? 'neg' : 'neutral';
    const deltaSign = dn > 0 ? '+' : '';
    return `<tr>
      <td class="enr-tenant">${t.tenant}</td>
      <td class="enr-filled">${t.filled}</td>
      <td class="enr-delta ${deltaCls}">${deltaSign}${t.delta}</td>
      <td class="enr-backlog">${t.backlog}</td>
      <td class="enr-when">${t.lastEnriched}</td>
    </tr>`;
  }).join('');

  const throughput = (d.skyldLastHour || d.skyldLast6h)
    ? `<div class="enr-throughput">
        SKYLD throughput
        ${d.skyldLastHour ? `<span class="enr-rate">${d.skyldLastHour}/u (1h)</span>` : ''}
        ${d.skyldLast6h ? `<span class="enr-rate">${d.skyldLast6h}/6u (6h)</span>` : ''}
      </div>`
    : '';

  return `
    <table class="enr-table">
      <thead><tr><th>Tenant</th><th>L6</th><th>Δ</th><th>Backlog</th><th>Last</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
    ${throughput}
    ${renderKrantSection(krant)}
  `;
}

function renderWatchlistCard(content) {
  const d = parseWatchlist(content);
  const krant = parseKrant(content);
  if (!d.assets.length) return '<div class="card-waiting">Geen data</div>';

  const rows = d.assets.map(a => {
    const cls = a.deltaNum > 0 ? 'pos' : a.deltaNum < 0 ? 'neg' : '';
    const hot = Math.abs(a.deltaNum) >= 5 ? ' wl-hot' : '';
    return `<tr class="${hot.trim()}">
      <td class="wl-asset">${a.asset}</td>
      <td class="wl-price">${a.price}</td>
      <td class="wl-delta ${cls}">${a.delta}</td>
      <td class="wl-hl">${a.high}</td>
      <td class="wl-hl">${a.low}</td>
      <td class="wl-vol">${a.volume}</td>
    </tr>`;
  }).join('');

  const signalsHtml = d.signals.length
    ? `<div class="wl-signals">${d.signals.map(s => `<div class="wl-signal">${s}</div>`).join('')}</div>`
    : '';

  return `
    <div class="wl-layout">
      <table class="wl-table">
        <thead><tr>
          <th>Asset</th><th>Prijs</th><th>24h</th><th>High</th><th>Low</th><th>Vol</th>
        </tr></thead>
        <tbody>${rows}</tbody>
      </table>
      ${signalsHtml}
    </div>
    ${renderKrantSection(krant)}
  `;
}

function renderAntiFragCard(content) {
  const d = parseAntiFrag(content);
  const krant = parseKrant(content);

  return `
    <div class="af-content">
      ${d.cycle ? `<div class="af-cycle">Cycle ${d.cycle}</div>` : ''}
      ${d.btcPrice ? `<div class="af-price">BTC $${d.btcPrice} <span class="${colorClass(d.btc24h)}">${d.btc24h || ''}</span> 24h</div>` : ''}
      ${d.state ? `<div class="af-status">${d.state}</div>` : ''}
      ${d.trade ? `<div class="af-edges">Trades: ${d.trade}</div>` : ''}
    </div>
    ${renderKrantSection(krant)}
  `;
}

function renderThesisTraderCard(content) {
  const d = parseThesisTrader(content);
  const krant = parseKrant(content);
  if (!d.status && !d.trade) return '<div class="card-waiting">Geen data</div>';

  const t = d.trade;
  const mtmCls = t && t.mtmPct ? colorClass(t.mtmPct) : '';
  const slCls = t && t.sl && t.sl.status === 'VEILIG' ? 'pos' : 'neg';

  return `
    <div class="tt-header">
      <div class="tt-status">${d.status || ''}</div>
      ${d.price ? `<div class="tt-price">BTC $${d.price}</div>` : ''}
    </div>
    ${t ? `
      <div class="tt-trade">
        <div class="tt-trade-id">${t.id}${t.direction ? ' · ' + t.direction : ''}${t.age ? ' · ' + t.age : ''}</div>
        ${t.mtmPct ? `<div class="tt-mtm ${mtmCls}">${t.mtmPct} <span class="tt-r">${t.mtmR || ''}</span></div>` : ''}
        <div class="tt-grid">
          ${t.entryPrice ? `<div class="tt-cell"><div class="tt-k">Entry</div><div class="tt-v">$${t.entryPrice}</div></div>` : ''}
          ${t.tp1 ? `<div class="tt-cell"><div class="tt-k">TP1</div><div class="tt-v">$${t.tp1.price} <span class="tt-dim">${t.tp1.pct}</span></div></div>` : ''}
          ${t.tp2 ? `<div class="tt-cell"><div class="tt-k">TP2</div><div class="tt-v">$${t.tp2.price}</div></div>` : ''}
          ${t.sl ? `<div class="tt-cell"><div class="tt-k">SL</div><div class="tt-v ${slCls}">$${t.sl.price} <span class="tt-dim">${t.sl.status}</span></div></div>` : ''}
          ${t.expiry ? `<div class="tt-cell"><div class="tt-k">Expiry</div><div class="tt-v">${t.expiry.date} <span class="tt-dim">${t.expiry.daysLeft}</span></div></div>` : ''}
        </div>
      </div>
    ` : '<div class="tt-empty">Geen open trade</div>'}
    ${renderKrantSection(krant)}
  `;
}

// Generic renderer: regime + krant only. Fallback for sensors without
// a custom renderer (confluence, machinekamer, macro-regime, ma200, backtest,
// ta-setups, future NEMESIS sensors).
function renderGenericCard(content) {
  const krant = parseKrant(content);
  // Try to surface a one-line headline before the krant if no krant exists,
  // so the card isn't empty.
  if (!krant.hasKrant) {
    const firstPara = content.split(/\n\n/).find(p => {
      const trimmed = p.trim();
      return trimmed && !trimmed.startsWith('#') && !trimmed.startsWith('---')
        && !trimmed.startsWith('>') && !trimmed.startsWith('|');
    });
    if (firstPara) {
      return `<div class="generic-headline">${truncate(firstPara.replace(/\*\*/g, ''), 280)}</div>`;
    }
    return '<div class="card-waiting">Wacht op data</div>';
  }
  return renderKrantSection(krant);
}

const RENDERERS = {
  'market': renderMarketCard,
  'watchlist': renderWatchlistCard,
  'nest-seo': renderNestSeoCard,
  'infra': renderInfraCard,
  'enrichment': renderEnrichmentCard,
  'anti-fragile': renderAntiFragCard,
  'thesis-trader': renderThesisTraderCard,
  'generic': renderGenericCard,
};

// --- Dashboard -----------------------------------------------------------

function buildSensorList(names) {
  // Decorate with role + filter via registry status.
  return names
    .filter(shouldDisplay)
    .map(name => ({
      name,
      role: SENSOR_ROLES[name] || DEFAULT_ROLE,
    }))
    .sort((a, b) => {
      const ag = GROUP_ORDER.indexOf(a.role.group);
      const bg = GROUP_ORDER.indexOf(b.role.group);
      if (ag !== bg) return ag - bg;
      // Within a group, preserve role-defined order if present, else alpha.
      const ai = Object.keys(SENSOR_ROLES).indexOf(a.name);
      const bi = Object.keys(SENSOR_ROLES).indexOf(b.name);
      if (ai !== -1 && bi !== -1) return ai - bi;
      if (ai !== -1) return -1;
      if (bi !== -1) return 1;
      return a.name.localeCompare(b.name);
    });
}

async function renderDashboard() {
  const grid = document.getElementById('sensor-grid');

  if (!sensors.length) {
    try {
      const [names] = await Promise.all([fetchSensorListing(), fetchRegistry()]);
      sensors = buildSensorList(names);
    } catch (e) {
      grid.innerHTML = `<p class="loading">Failed to discover sensors: ${e.message}</p>`;
      return;
    }
  }

  grid.innerHTML = sensors.map(s => {
    const prom = prominenceClass(s.name);
    return `
      <div class="sensor-card span-${s.role.span} ${prom}" data-sensor="${s.name}">
        <div class="sensor-header">
          <span class="sensor-name">${s.role.label || s.name}</span>
          <span class="regime-label" id="regime-${s.name}"></span>
          <span class="sensor-badge badge-down" id="badge-${s.name}">...</span>
        </div>
        <div class="sensor-body" id="body-${s.name}"><div class="loading-text">laden…</div></div>
      </div>
    `;
  }).join('');

  grid.querySelectorAll('.sensor-card').forEach(card => {
    card.addEventListener('click', () => navigate(`doc/sensors/${card.dataset.sensor}.md`));
  });

  await Promise.allSettled(sensors.map(async s => {
    const name = s.name;
    try {
      const content = await fetchFile(`sensors/${name}.md`);
      const meta = parseSensorMeta(content);
      const badge = document.getElementById(`badge-${name}`);
      const body = document.getElementById(`body-${name}`);

      if (meta.notDeployed) {
        badge.textContent = '–';
        badge.className = 'sensor-badge badge-pending';
        body.innerHTML = '<div class="card-waiting">Wacht op data</div>';
        return;
      }

      if (meta.hoursAgo !== null) {
        badge.textContent = `${meta.hoursAgo}h`;
        badge.className = `sensor-badge badge-${meta.status}`;
      } else {
        badge.textContent = '?';
        badge.className = 'sensor-badge badge-pending';
      }

      const regime = parseRegime(content);
      const regimeEl = document.getElementById(`regime-${name}`);
      if (regime && regimeEl) {
        // Strip parenthetical / em-dash explanations so the badge stays compact.
        const short = regime.split(/\s+\(|\s+—|\s+-\s/)[0].trim();
        regimeEl.textContent = truncate(short, 28);
        regimeEl.className = `regime-label ${regimeColor(regime)}`;
      }

      const renderer = RENDERERS[s.role.renderer] || renderGenericCard;
      body.innerHTML = renderer(content, meta);
    } catch (e) {
      const badge = document.getElementById(`badge-${name}`);
      const body = document.getElementById(`body-${name}`);
      if (badge) { badge.textContent = 'ERR'; badge.className = 'sensor-badge badge-down'; }
      if (body) body.innerHTML = `<div class="card-waiting">Laad fout: ${e.message}</div>`;
    }
  }));
}

// --- Document view -------------------------------------------------------

async function renderDocument(path) {
  const bc = document.getElementById('breadcrumb');
  const parts = path.split('/');
  bc.innerHTML = '<a href="#dashboard">dashboard</a> / ' +
    parts.map((p, i) => {
      if (i < parts.length - 1) return `<span>${p}</span>`;
      return `<strong style="color:var(--text)">${p}</strong>`;
    }).join(' / ');

  const contentEl = document.getElementById('document-content');
  const metaEl = document.getElementById('document-meta');

  try {
    const content = await fetchFile(path);
    contentEl.innerHTML = marked.parse(content);

    contentEl.querySelectorAll('a[href]').forEach(a => {
      const href = a.getAttribute('href');
      if (href && !href.startsWith('http') && href.endsWith('.md')) {
        a.addEventListener('click', e => {
          e.preventDefault();
          const dir = path.substring(0, path.lastIndexOf('/') + 1);
          const resolved = href.startsWith('/') ? href.slice(1) : dir + href;
          navigate(`doc/${resolved}`);
        });
      }
    });

    const lines = content.split('\n').length;
    metaEl.textContent = `${lines} lines | ${path}`;
  } catch (e) {
    contentEl.innerHTML = `<p style="color:var(--red)">Failed to load ${path}</p>`;
    metaEl.textContent = '';
  }
}

// --- Graph view ----------------------------------------------------------

async function renderGraph() {
  if (!tree) await fetchTree();

  const container = document.getElementById('graph-container');
  container.innerHTML = '';

  const width = container.clientWidth;
  const height = container.clientHeight || window.innerHeight - 60;

  const inLinks = {};
  const nodes = tree.map(f => {
    inLinks[f.path] = 0;
    return {
      id: f.path,
      name: f.path.split('/').pop().replace('.md', ''),
      group: f.path.includes('/') ? f.path.split('/')[0] : 'root'
    };
  });
  const nodeSet = new Set(nodes.map(n => n.id));

  const links = [];
  const seen = new Set();
  for (const [filePath, content] of Object.entries(cache)) {
    if (!nodeSet.has(filePath)) continue;
    const re = /\[([^\]]*)\]\(([^)]+\.md)\)/g;
    let m;
    while ((m = re.exec(content)) !== null) {
      let target = m[2].replace(/^\.\//, '');
      if (!target.includes('/')) {
        const dir = filePath.substring(0, filePath.lastIndexOf('/') + 1);
        target = dir + target;
      }
      if (nodeSet.has(target)) {
        const key = `${filePath}->${target}`;
        if (!seen.has(key)) {
          seen.add(key);
          links.push({ source: filePath, target });
          inLinks[target] = (inLinks[target] || 0) + 1;
        }
      }
    }
  }

  nodes.forEach(n => { n.radius = 5 + (inLinks[n.id] || 0) * 2; });

  const colors = {
    sensors: '#22c55e',
    prompts: '#eab308',
    operations: '#ef4444',
    'domain-knowledge': '#3b82f6',
    repos: '#8b5cf6',
    'api-references': '#06b6d4',
    bin: '#6b7280',
    root: '#9ca3af'
  };

  const svg = d3.select(container).append('svg')
    .attr('width', width)
    .attr('height', height);

  const tooltip = document.getElementById('tooltip');

  const sim = d3.forceSimulation(nodes)
    .force('link', d3.forceLink(links).id(d => d.id).distance(100))
    .force('charge', d3.forceManyBody().strength(-250))
    .force('center', d3.forceCenter(width / 2, height / 2))
    .force('collision', d3.forceCollide().radius(d => d.radius + 10));

  const link = svg.append('g').selectAll('line').data(links).join('line')
    .attr('class', 'link');

  const node = svg.append('g').selectAll('g').data(nodes).join('g')
    .attr('class', 'node')
    .call(d3.drag()
      .on('start', (e, d) => {
        if (!e.active) sim.alphaTarget(0.3).restart();
        d.fx = d.x; d.fy = d.y;
      })
      .on('drag', (e, d) => { d.fx = e.x; d.fy = e.y; })
      .on('end', (e, d) => {
        if (!e.active) sim.alphaTarget(0);
        d.fx = null; d.fy = null;
      })
    );

  node.append('circle')
    .attr('r', d => d.radius)
    .attr('fill', d => colors[d.group] || '#666');

  node.append('text')
    .attr('dx', d => d.radius + 4)
    .attr('dy', 4)
    .text(d => d.name);

  node.on('mouseover', (e, d) => {
    tooltip.style.display = 'block';
    tooltip.innerHTML = `<strong>${d.name}</strong><br><span style="color:#888">${d.id}</span>`;
    tooltip.style.left = (e.pageX + 12) + 'px';
    tooltip.style.top = (e.pageY - 12) + 'px';
  })
  .on('mousemove', e => {
    tooltip.style.left = (e.pageX + 12) + 'px';
    tooltip.style.top = (e.pageY - 12) + 'px';
  })
  .on('mouseout', () => { tooltip.style.display = 'none'; })
  .on('click', (e, d) => navigate(`doc/${d.id}`));

  sim.on('tick', () => {
    link
      .attr('x1', d => d.source.x).attr('y1', d => d.source.y)
      .attr('x2', d => d.target.x).attr('y2', d => d.target.y);
    node.attr('transform', d => `translate(${d.x},${d.y})`);
  });
}

// --- Router --------------------------------------------------------------

function navigate(hash) {
  window.location.hash = hash;
}

function handleRoute() {
  const hash = window.location.hash.slice(1) || 'dashboard';

  document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
  document.querySelectorAll('.nav-links a').forEach(a => a.classList.remove('active'));

  if (hash === 'dashboard') {
    document.getElementById('dashboard-view').classList.add('active');
    document.querySelector('[data-view="dashboard"]').classList.add('active');
  } else if (hash === 'graph') {
    document.getElementById('graph-view').classList.add('active');
    document.querySelector('[data-view="graph"]').classList.add('active');
    renderGraph();
  } else if (hash.startsWith('doc/')) {
    document.getElementById('document-view').classList.add('active');
    renderDocument(hash.slice(4));
  }
}

document.querySelectorAll('.nav-links a').forEach(a => {
  a.addEventListener('click', e => {
    e.preventDefault();
    navigate(a.dataset.view);
  });
});

window.addEventListener('hashchange', handleRoute);

// --- Init ----------------------------------------------------------------

async function init() {
  try {
    await fetchTree();
    await renderDashboard();
    handleRoute();
  } catch (e) {
    document.getElementById('sensor-grid').innerHTML =
      '<p class="loading">Failed to connect to wiki API. Check GITHUB_PAT env var.</p>';
  }

  setInterval(async () => {
    cache = {};
    tree = null;
    registry = null;
    sensors = [];
    try {
      await fetchTree();
      if (document.getElementById('dashboard-view').classList.contains('active')) {
        await renderDashboard();
      }
    } catch (e) { /* silent refresh failure */ }
  }, 300000);
}

init();
