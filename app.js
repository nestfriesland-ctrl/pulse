// PULSE — krant-laag dashboard renderer
// API layer, registry parsing, sensor parsers, document/graph views, and the
// live-tick loop are unchanged from feat/live-layer. What changed: the
// dashboard rendering is now an editorial dispatcher that maps each visible
// sensor onto a fixed slot (lead / fg-band / heat-index / position-inset /
// triple / duo / strip), instead of a 12-column generic grid.

const API = '/api/wiki';
const REGISTRY_PATH = 'operations/sensor-registry.md';

let tree = null;
let cache = {};
let registry = null;

let liveTickers = null;
let liveAnchors = null;

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

function shouldDisplay(sensorName) {
  const reg = lookupRegistry(sensorName);
  if (!reg) return true;
  if (reg.status === 'GEARCHIVEERD') return false;
  if (reg.status === 'KANDIDAAT-VERWIJDERING') return false;
  if (reg.verdict === 'KANDIDAAT-VOOR-VERWIJDERING') return false;
  return true;
}

// --- Sensor meta + parsing ----------------------------------------------

function parseSensorMeta(content) {
  const meta = { lastUpdated: null, hoursAgo: null, status: 'unknown', notDeployed: false };
  if (/^[>\s]*status:\s*NOT[_ ]DEPLOYED/mi.test(content)) {
    meta.notDeployed = true;
    return meta;
  }
  let tsMatch = content.match(/^[>\s-]*last_updated:\s*([^\n]+)/mi);
  // Observability-split: sensors that distinguish attempted vs successful runs
  // (cortex doctrine, may spread to other sensors with external-API dependencies).
  // Freshness reflects the LAST SUCCESSFUL run — a sensor that attempts every
  // hour but never succeeds is not fresh, it is broken.
  if (!tsMatch) {
    const successMatch = content.match(/^[>\s-]*last_successful_at:\s*([^\n]+)/mi);
    if (successMatch) {
      const v = successMatch[1].trim();
      // 'never' or empty → notDeployed (sensor exists but has never produced a healthy run)
      if (/^never$/i.test(v) || v === '—' || v === '-' || v === '') {
        meta.notDeployed = true;
        return meta;
      }
      tsMatch = [null, v];
    }
  }
  if (!tsMatch) {
    const parenDate = content.match(/\*\*Cycle:\*\*[^\(]*\((\d{1,2}\s+\w+\s+\d{4}[^)]*)\)/);
    if (parenDate) tsMatch = [null, parenDate[1].replace(/~/, '')];
  }
  if (!tsMatch) {
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

function parseRegime(content) {
  let m = content.match(/^>\s*regime:\s*(.+)/mi);
  if (m) return m[1].trim();
  m = content.match(/^regime:\s*(.+)/mi);
  if (m) return m[1].trim();
  m = content.match(/\*\*State:\*\*\s*([^\/\n]+)/);
  if (m) return m[1].trim();
  return null;
}

function parseKrant(content) {
  if (!content) return { hasKrant: false };
  const krant = {};
  // **Kop** is the priority headline — short editorial sentence written by
  // the sensor for human readers. Falls back to shaped Stelling when absent.
  // See wiki/operations/krant-stijlgids.md for the writing rules.
  const kopMatch = content.match(/\*\*Kop:\*\*\s*(.+)/);
  const stellingMatch = content.match(/\*\*Stelling:\*\*\s*(.+)/);
  const bewijsMatch = content.match(/\*\*Bewijs:\*\*\s*([\s\S]*?)(?=\n\*\*Les:|\n\*\*Actie:|\n##)/);
  const lesMatch = content.match(/\*\*Les:\*\*\s*(.+)/);
  const actieMatch = content.match(/\*\*Actie:\*\*\s*(.+)/);
  krant.kop = kopMatch ? kopMatch[1].trim() : null;
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
  krant.hasKrant = !!(krant.kop || krant.stelling || krant.les);
  return krant;
}

// --- Shared utilities for component renderers ---------------------------

window.PulseUtil = (function () {
  function escape(s) {
    if (s == null) return '';
    return String(s).replace(/[&<>"']/g, c => ({
      '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
    }[c]));
  }

  function trimSentence(s, max) {
    if (!s) return null;
    let out = s.trim();
    const firstSentence = out.match(/^[^.]+\./);
    if (firstSentence) out = firstSentence[0].trim();
    if (out.length <= max) return out;

    // Prefer cutting at an em-dash if one falls within range and the head is
    // substantial — em-dash is a natural sentence break, leaves a clean period.
    const dashIdx = out.lastIndexOf('—', max - 1);
    if (dashIdx >= max * 0.5) {
      return out.slice(0, dashIdx).trim().replace(/[,;:—\-]+$/, '') + '.';
    }

    // Default: word-boundary cut, strip trailing punctuation/brackets/quotes
    // before appending ellipsis. Avoids the "— …" or "(…" patterns.
    out = out.slice(0, max - 1).replace(/\s+\S*$/, '');
    out = out.replace(/[\s,;:—\-({[\"']+$/, '');
    return out + '…';
  }

  // Stelling is verbose ("Regime = X — claim. Bevestiging: ... Falsificatie: ...").
  // Headline: shape into one short editorial sentence.
  function shapeHeadline(stelling) {
    if (!stelling) return null;
    let s = stelling.trim();
    // Skip "Regime = X — " prefix when present so the claim itself surfaces.
    const dashIdx = s.indexOf('—');
    if (dashIdx >= 0 && dashIdx < 80) s = s.slice(dashIdx + 1).trim();
    // Strip trailing Bevestiging/Falsificatie sub-clauses.
    s = s.replace(/(Bevestiging|Falsificatie|Pro|Tegen)[:\-].+$/, '').trim();
    return trimSentence(s, 140);
  }

  function shapeDeck(bewijs) {
    if (!bewijs) return null;
    let s = bewijs.trim().replace(/^(Pro|Tegen)[:\-]\s*/i, '');
    return trimSentence(s, 240);
  }

  function shapeBody(les, actie) {
    const parts = [];
    if (les) parts.push(`<p>${escape(trimSentence(les, 600) || les)}</p>`);
    if (actie) parts.push(`<p><strong>Actie.</strong> ${escape(trimSentence(actie, 400) || actie)}</p>`);
    return parts.join('') || `<p class="dim">Geen krant-data.</p>`;
  }

  function shapeTripleBody(les, actie, content) {
    if (les || actie) {
      let h = '';
      if (les) h += `<p>${escape(trimSentence(les, 280) || les)}</p>`;
      if (actie) h += `<p><strong>Actie.</strong> ${escape(trimSentence(actie, 220) || actie)}</p>`;
      return h;
    }
    if (content) {
      const firstPara = content.split(/\n\n/).find(p => {
        const t = p.trim();
        return t && !t.startsWith('#') && !t.startsWith('---')
          && !t.startsWith('>') && !t.startsWith('|')
          && !/^\*\*(State|Cycle|Run|Status):/.test(t);
      });
      if (firstPara) {
        const stripped = firstPara.replace(/\*\*/g, '').trim();
        const trimmed = stripped.length > 280 ? stripped.slice(0, 277) + '…' : stripped;
        return `<p>${escape(trimmed)}</p>`;
      }
    }
    return `<p class="dim">Geen data.</p>`;
  }

  function shapeBodyParagraph() {
    for (let i = 0; i < arguments.length; i++) {
      const s = arguments[i];
      if (!s) continue;
      const trimmed = s.length > 320 ? s.slice(0, 317).replace(/\s+\S*$/, '') + '…' : s;
      return `<p>${escape(trimmed)}</p>`;
    }
    return '';
  }

  function shortenRegime(regime) {
    if (!regime) return '';
    let s = regime.split(/—|\(|\s+\/\s+/)[0].trim();
    if (s.length > 32) s = s.slice(0, 30) + '…';
    return s.toLowerCase();
  }

  function regimeKickerClass(regime) {
    if (!regime) return 'neut';
    const r = regime.toLowerCase();
    if (/^(rally|nominal|flowing|growing|validated|rotation|risk[-_ ]on|bullish|bull|up[-_ ]|extends|extension|live|proved|proven|squeeze|breakout)/.test(r)) return 'bull';
    if (/^(correction|capitulation|down[-_]|stalled|declining|falsified|bearish|bear|dead|degraded|no[-_ ]edge|critical|refuted|breakdown|cement|rejection|risk[-_ ]off|short)/.test(r)) return 'bear';
    return 'neut';
  }

  function extractFalsifier(text) {
    if (!text) return null;
    const m = text.match(/Falsifi(?:catie|er):\s*([^.]+(?:\.|$))/i);
    if (m) return m[1].trim();
    const m2 = text.match(/Falsificatie[\-\s]stop:\s*([^.]+(?:\.|$))/i);
    if (m2) return m2[1].trim();
    return null;
  }

  function extractTradeProposal(actie) {
    if (!actie) return { headline: null, body: null };
    const longShort = actie.match(/^(Long|Short|LONG|SHORT|GEEN ENTRY|HOLD|ADD|EXIT|TRIM|ENTRY)[^.]*\./);
    if (longShort) {
      const h = longShort[0].trim();
      const rest = actie.slice(longShort[0].length).trim();
      const restSentence = rest.match(/^[^.]+\./);
      return {
        headline: h.length > 100 ? h.slice(0, 97) + '…' : h,
        body: restSentence ? restSentence[0].trim() : null,
      };
    }
    const first = actie.match(/^[^.]+\./);
    return first
      ? { headline: first[0].trim().slice(0, 100), body: null }
      : { headline: null, body: null };
  }

  function fallbackHeadline(content) {
    if (!content) return null;
    const stateM = content.match(/\*\*State:\*\*\s*([^\n]+)/);
    if (stateM) return stateM[1].trim().slice(0, 80);
    const reg = content.match(/^>\s*regime:\s*(.+)/mi)
      || content.match(/^regime:\s*(.+)/mi);
    if (reg) return reg[1].trim().slice(0, 80);
    return null;
  }

  function extractByline(content) {
    if (!content) return null;
    const cycleM = content.match(/\*\*Cycle:\*\*\s*([^\n]+)/);
    if (cycleM) return cycleM[1].trim().slice(0, 80);
    const runM = content.match(/\*\*Run:\*\*\s*([^|]+)/);
    if (runM) return runM[1].trim().slice(0, 80);
    return null;
  }

  function titleize(name) {
    if (!name) return '';
    return name.split('-').map(p => p[0].toUpperCase() + p.slice(1)).join(' ');
  }

  return {
    escape,
    shapeHeadline, shapeDeck, shapeBody, shapeTripleBody, shapeBodyParagraph,
    shortenRegime, regimeKickerClass,
    extractFalsifier, extractTradeProposal,
    fallbackHeadline, extractByline, titleize,
  };
})();

// --- Katern map (sensor → katern) ---------------------------------------
//
// Vijf katernen organiseren sensors semantisch (niet per project). Geo-politiek
// register werkt over project-grenzen heen — confluence en anti-fragile leven
// beide in MARKT en kunnen op dezelfde data-snapshot tegengesteld lezen.
//
// LICHAAM heeft ruimte gereserveerd voor cortex (Whoop) maar de sensor staat
// op KANDIDAAT-VERWIJDERING en wordt op het dashboard niet gerendered;
// katern-pagina laat dat expliciet zien.
//
// RESIDU + NECROLOGIE worden bevolkt in PR #7 (observer-residue) en PR #8
// (necrologie-seed).

const KATERN_DEFS = {
  markt: {
    label: 'Markt',
    tagline: 'crypto · macro · positie',
    sensors: ['market', 'fear-greed', 'thesis-trader', 'confluence', 'macro-regime', 'anti-fragile', 'watchlist', 'ma200', 'ta-setups', 'backtest'],
    viz: 'markt',
  },
  machinekamer: {
    label: 'Machinekamer',
    tagline: 'fabriek · pipeline · uptime',
    sensors: ['infra', 'enrichment', 'machinekamer', 'nest-seo'],
    viz: 'machinekamer',
  },
  lichaam: {
    label: 'Lichaam',
    tagline: 'fysiologie · regime · herstel',
    sensors: ['cortex'],
    viz: null,
  },
  residu: {
    label: 'Residu',
    tagline: 'meta · onverklaard · drift',
    sensors: ['observer-residue'],
    viz: 'residu',
    layout: 'lead', // observer-residue rendert als lead-article + heatmap, geen tile-grid
  },
  necrologie: {
    label: 'Necrologie',
    tagline: 'gefalsifieerd · begraven · ritueel',
    sensors: [],
    viz: 'necrologie',
    layout: 'necrologie',
  },
  research: {
    label: 'Research',
    tagline: 'inbox · claims · hypotheses · log',
    sensors: [],
    viz: null,
    layout: 'research',
  },
};

const KATERN_MAP = {};
for (const [katernName, def] of Object.entries(KATERN_DEFS)) {
  for (const s of def.sensors) KATERN_MAP[s] = katernName;
}

// --- Sensor display-override (naam-collisie fix) ------------------------
//
// De sensor `machinekamer` zit in het katern `machinekamer`. Hash-route zou
// `#machinekamer/machinekamer` worden — register-bug, want de katern-naam
// verliest zijn semantisch werk. We geven deze sensor een display-alias
// (`meta-stelling`) voor URL + tile-label, zonder de wiki-file zelf aan te
// raken (dat zou morning-paper, sensor-runner, registry-heading e.d. mee-
// slepen). Wiki file-rename kan los volgen.

const SENSOR_FILE_TO_DISPLAY = {
  'machinekamer': 'meta-stelling',
};
const SENSOR_DISPLAY_TO_FILE = Object.fromEntries(
  Object.entries(SENSOR_FILE_TO_DISPLAY).map(([k, v]) => [v, k])
);

function displaySensor(fileName) {
  return SENSOR_FILE_TO_DISPLAY[fileName] || fileName;
}
function fileSensor(displayName) {
  return SENSOR_DISPLAY_TO_FILE[displayName] || displayName;
}

// --- Tijd-delta (per-katern last-view in localStorage) -------------------
//
// Mechaniek: bij elk bezoek aan een katern-pagina lezen we de vorige
// last-view-timestamp en taggen tiles waar sensor.updated_at > vorige bezoek
// met `verschoven sinds u laatst keek`. Daarna pas overschrijven we de
// timestamp. Bij eerste-bezoek (geen waarde): geen kickers, alleen
// inschrijving. N=1, dus puur localStorage.

const TIJD_DELTA_KEY = 'pulse_last_view';

function getKaternLastView(katern) {
  try {
    const raw = localStorage.getItem(TIJD_DELTA_KEY);
    if (!raw) return null;
    const map = JSON.parse(raw);
    return (map && map[katern]) || null;
  } catch (e) { return null; }
}

function recordKaternView(katern) {
  try {
    let map = {};
    const raw = localStorage.getItem(TIJD_DELTA_KEY);
    if (raw) {
      try { map = JSON.parse(raw) || {}; } catch (e) { map = {}; }
    }
    map[katern] = new Date().toISOString();
    localStorage.setItem(TIJD_DELTA_KEY, JSON.stringify(map));
  } catch (e) { /* localStorage disabled — fail silent */ }
}

// --- Editorial dashboard dispatcher --------------------------------------

const STRIP_NAMES = ['enrichment', 'infra', 'nest-seo', 'backtest', 'machinekamer'];

function updateMastheadMeta(visibleSensors, freshCount) {
  const el = document.getElementById('masthead-meta');
  if (!el) return;
  const today = new Date();
  const days = ['zondag','maandag','dinsdag','woensdag','donderdag','vrijdag','zaterdag'];
  const months = ['jan','feb','mrt','apr','mei','jun','jul','aug','sep','okt','nov','dec'];
  const dayName = days[today.getDay()];
  const dateStr = `${today.getDate()} ${months[today.getMonth()]} ${today.getFullYear()}`;
  const stamp = today.toLocaleTimeString('nl-NL', { hour: '2-digit', minute: '2-digit' });
  el.innerHTML = `${dayName} <strong>${dateStr}</strong> · run-as-of <strong>${stamp} CEST</strong> · sensors ${freshCount}/${visibleSensors.length} ✓`;
}

async function renderDashboard() {
  const editorial = document.getElementById('editorial');
  if (!editorial) return;

  const [names] = await Promise.all([fetchSensorListing(), fetchRegistry()]);
  const visible = names.filter(shouldDisplay);

  // Parallel content fetch.
  const contents = {};
  await Promise.allSettled(visible.map(async name => {
    try { contents[name] = await fetchFile(`sensors/${name}.md`); }
    catch (e) { /* leave blank */ }
  }));

  const slot = (name) => {
    const content = contents[name];
    if (!content) return null;
    return {
      name,
      content,
      krant: parseKrant(content),
      regime: parseRegime(content),
      meta: parseSensorMeta(content),
    };
  };

  // Masthead — show fresh sensor count.
  const freshCount = visible.filter(n => {
    const c = contents[n];
    if (!c) return false;
    const m = parseSensorMeta(c);
    return m.status === 'fresh';
  }).length;
  updateMastheadMeta(visible, freshCount);

  // LEAD — market sensor.
  const market = slot('market');
  if (market && window.PulseLead) {
    window.PulseLead.render({
      section: document.getElementById('sec-lead'),
      content: market.content,
      krant: market.krant,
      regime: market.regime,
      meta: market.meta,
    });
  }

  // F/G band — uses fear-greed sensor if it exists, else market.md F&G line.
  if (window.PulseFearGreed) {
    const fgContent = contents['fear-greed'] || null;
    await window.PulseFearGreed.render({
      section: document.getElementById('sec-fg'),
      marketContent: market ? market.content : null,
      sensorContent: fgContent,
      krant: fgContent ? parseKrant(fgContent) : null,
    });
  }

  // Heat-index already mounted at startup; live tick fills it.

  // POSITION INSET — thesis-trader.
  const thesis = slot('thesis-trader');
  if (window.PulsePositionInset) {
    window.PulsePositionInset.render({
      section: document.getElementById('sec-position'),
      content: thesis ? thesis.content : null,
      krant: thesis ? thesis.krant : null,
    });
  }

  // TRIPLE — confluence | macro-regime | anti-fragile.
  if (window.PulseTriple) {
    window.PulseTriple.render({
      section: document.getElementById('sec-triple'),
      slots: {
        confluence: slot('confluence'),
        macro: slot('macro-regime'),
        antiFragile: slot('anti-fragile'),
      },
    });
  }

  // DUO — watchlist | ma200.
  if (window.PulseDuo) {
    window.PulseDuo.render({
      section: document.getElementById('sec-duo'),
      slots: {
        watchlist: slot('watchlist'),
        ma200: slot('ma200'),
      },
    });
  }

  // STRIP — small sensors. Label gebruikt display-override zodat
  // 'machinekamer' als 'meta-stelling' verschijnt (naam-collisie-fix).
  if (window.PulseStrip) {
    const stripSlots = STRIP_NAMES
      .filter(n => visible.includes(n))
      .map(n => ({ name: n, label: displaySensor(n), content: contents[n] || null }));
    window.PulseStrip.render({
      section: document.getElementById('sec-strip'),
      slots: stripSlots,
    });
  }

  // Wire deep-link clicks on sensor sections to the document view.
  document.querySelectorAll('[data-sensor-link]').forEach(el => {
    el.addEventListener('click', () => navigate(`doc/sensors/${el.dataset.sensorLink}.md`));
  });

  // Charts — re-init after each render (lib/charts.js disposes old instances).
  if (window.PulseCharts) {
    window.PulseCharts.initBtcChart('btc-chart');
    window.PulseCharts.initEthBtcRatio('ethbtc-sparkline');
  }
}

// --- Katern-pagina renderer ----------------------------------------------
//
// Routing is hash-based. Drie lagen:
//   #dashboard           = bestaande krant-flow (ongewijzigd)
//   #<katern>            = katern-voorpagina (markt/machinekamer/lichaam/residu/necrologie)
//   #<katern>/<sensor>   = sensor-deep (toont volledige sensor-md, hergebruikt document-view)
//
// Tijd-delta wordt berekend tegen de last-view BEFORE we recorden — daarna
// pas overschrijven, anders is verschoven altijd false.

// Necrologie-data fetching — apart pad omdat katern niet uit sensors bestaat
// maar uit individuele begrafenis-files met YAML-frontmatter.
async function fetchNecrologieEntries() {
  let listing;
  try {
    const r = await fetch('/api/wiki?path=necrologie');
    if (!r.ok) return [];
    listing = await r.json();
  } catch (e) { return []; }
  if (!Array.isArray(listing)) return [];

  const mdFiles = listing.filter(f =>
    f && f.type === 'file' && f.name.endsWith('.md') && f.name !== 'SCHEMA.md'
  );

  const entries = await Promise.all(mdFiles.map(async f => {
    try {
      const content = await fetchFile(`necrologie/${f.name}`);
      const fm = parseFrontmatter(content);
      if (fm) fm._body = stripFrontmatter(content);
      return fm;
    } catch (e) { return null; }
  }));

  return entries.filter(Boolean);
}

// Minimale YAML-frontmatter-parser. Niet alle YAML — alleen `key: value`
// (optioneel quoted) met enkele inspringings-niveau. Genoeg voor het
// zes-velden-schema (id/naam/geboren/overleden/lifespan/doodsoorzaak/
// achtergebleven). Niet rebuild-PyYAML.
function parseFrontmatter(content) {
  if (!content) return null;
  const match = content.match(/^---\s*\n([\s\S]*?)\n---/);
  if (!match) return null;
  const fm = {};
  for (const line of match[1].split('\n')) {
    const m = line.match(/^(\w+):\s*(.*)$/);
    if (!m) continue;
    let value = m[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    fm[m[1]] = value;
  }
  return Object.keys(fm).length ? fm : null;
}

function stripFrontmatter(content) {
  if (!content) return '';
  const match = content.match(/^---[\s\S]*?\n---\s*\n?([\s\S]*)$/);
  return match ? match[1] : content;
}

// Heuristische sort-key voor `overleden`-veld. Drie formats:
//   - ISO YYYY-MM-DD → exact
//   - Nederlandse maand-jaar → midpoint van die maand
//   - "anti-fragile cycle N" → fallback naar 0 (sorteert achteraan)
// Bewust geen cycle→date-mapping: anti-fragile data-cycles vs research-
// cycles hebben verschillende cadenties, sustain-mapping is brittle.
function overledenSortKey(s) {
  if (!s) return 0;
  const str = String(s);
  const iso = str.match(/(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return new Date(`${iso[1]}-${iso[2]}-${iso[3]}`).getTime();
  const months = {
    jan:0,feb:1,mrt:2,maart:2,apr:3,april:3,mei:4,
    jun:5,juni:5,jul:6,juli:6,aug:7,sep:8,okt:9,nov:10,dec:11,
  };
  const my = str.toLowerCase().match(/(jan|feb|mrt|maart|apr|april|mei|juni?|juli?|aug|sep|okt|nov|dec)\w*\s+(\d{4})/);
  if (my) {
    const monthKey = my[1].length > 5 ? my[1].slice(0, 4) : my[1];
    const m = months[monthKey] ?? months[my[1]] ?? 0;
    return new Date(parseInt(my[2], 10), m, 15).getTime();
  }
  return 0;
}

async function renderKatern(katernName) {
  const def = KATERN_DEFS[katernName];
  const view = document.getElementById('katern-view');
  if (!def || !view) return;

  const lastView = getKaternLastView(katernName);

  // RESEARCH: aparte data-pad — fetch wiki/research/{user}/*. User komt
  // uit subdomain (mathijs.press.me / tara.press.me); apex defaultet
  // naar mathijs in fase 1.
  if (katernName === 'research') {
    if (window.PulseResearch) {
      await window.PulseResearch.render({ view, def });
    }
    recordKaternView(katernName);
    return;
  }

  // NECROLOGIE: aparte data-pad — fetch wiki/necrologie/*.md ipv sensors.
  if (katernName === 'necrologie') {
    const entries = await fetchNecrologieEntries();
    // Sort newest-first by overleden-key.
    entries.sort((a, b) => overledenSortKey(b.overleden) - overledenSortKey(a.overleden));
    if (window.PulseKatern) {
      window.PulseKatern.render({
        view, katernName, def, entries, lastView,
      });
    }
    recordKaternView(katernName);
    return;
  }

  await Promise.all([fetchSensorListing(), fetchRegistry()]);
  // Filter visible sensors. cortex / KANDIDAAT-VERWIJDERING worden door
  // shouldDisplay gefilterd zodat lichaam-katern de empty-state toont.
  const visible = def.sensors.filter(s => shouldDisplay(s));

  const contents = {};
  await Promise.allSettled(visible.map(async name => {
    try { contents[name] = await fetchFile(`sensors/${name}.md`); }
    catch (e) { /* leave blank */ }
  }));

  if (window.PulseKatern) {
    window.PulseKatern.render({
      view,
      katernName,
      def,
      sensors: visible,
      contents,
      lastView,
      parseSensorMeta,
      parseRegime,
      parseKrant,
      displaySensor,
    });
  }

  // Record AFTER render zodat verschoven-flag de vorige-bezoek-timestamp gebruikt.
  recordKaternView(katernName);
}

// --- Live layer (Kraken 15s) --------------------------------------------

function fmtPrice(p) {
  if (p == null || isNaN(p)) return '—';
  const decimals = p >= 100 ? 2 : p >= 1 ? 3 : p >= 0.01 ? 4 : 6;
  return p.toLocaleString('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
}

function fmtStamp(ts) {
  const d = new Date(ts);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  return `${hh}:${mm}:${ss} live`;
}

function injectLivePrices() {
  if (!liveTickers) return;
  const btc = liveTickers.BTC;
  const stamp = liveTickers._fetchedAt || Date.now();

  document.querySelectorAll('[data-live="BTC-price"]').forEach(el => {
    if (btc != null) el.textContent = '$' + fmtPrice(btc);
  });
  document.querySelectorAll('[data-live="BTC-price-tt"]').forEach(el => {
    if (btc != null) el.textContent = '$' + fmtPrice(btc);
  });
  document.querySelectorAll('[data-live="stamp"]').forEach(el => {
    el.textContent = fmtStamp(stamp);
  });

  // Masthead 24h delta — derived from anchor.
  if (liveAnchors && window.Thermometer) {
    const T = window.Thermometer;
    const ank = liveAnchors.BTC && liveAnchors.BTC['24h'];
    const pct = T.pctChange(btc, ank);
    if (pct != null) {
      document.querySelectorAll('[data-live="BTC-24h-delta"]').forEach(el => {
        el.textContent = T.fmtPct(pct);
        el.classList.remove('delta-up', 'delta-down');
        el.classList.add(pct >= 0 ? 'delta-up' : 'delta-down');
      });
    }
  }

  // Position-inset MTM — recompute from live BTC vs entry.
  document.querySelectorAll('[data-live="tt-mtm"]').forEach(el => {
    const insetEl = el.closest('[data-tt-entry]');
    if (!insetEl || btc == null) return;
    const entry = parseFloat(insetEl.dataset.ttEntry);
    const dir = (insetEl.dataset.ttDirection || '').toUpperCase();
    if (!entry || isNaN(entry)) return;
    const pct = dir === 'SHORT'
      ? ((entry - btc) / entry) * 100
      : ((btc - entry) / entry) * 100;
    const sign = pct > 0 ? '+' : '';
    el.textContent = `${sign}${pct.toFixed(2)}%`;
    el.classList.remove('bull', 'bear');
    el.classList.add(pct >= 0 ? '' : 'bear');
  });
}

async function liveTick() {
  try {
    const [tickers, anchors] = await Promise.all([
      window.Kraken.fetchTickers(),
      window.Kraken.fetchAllAnchors(),
    ]);
    liveTickers = tickers;
    liveAnchors = anchors;

    if (window.Thermometers) {
      window.Thermometers.updateThermometers({
        tickers, anchors, fetchedAt: tickers._fetchedAt,
      });
    }

    injectLivePrices();

    if (window.Alerts) {
      const T = window.Thermometer;
      const thermo = {};
      for (const a of window.Kraken.ASSETS) {
        const live = tickers[a.symbol];
        const ank = anchors[a.symbol];
        thermo[a.symbol] = T.classifyAsset(live, ank);
      }
      window.Alerts.tick({
        tickers,
        thermo,
        trade: window.__pulseLiveTrade || null,
      });
    }
  } catch (e) {
    // Live layer is best-effort — don't fail the dashboard.
    console.warn('[pulse] live tick failed', e);
  }
}

let liveTimer = null;
function startLiveLoop() {
  if (liveTimer) clearInterval(liveTimer);
  liveTick();
  liveTimer = setInterval(liveTick, 15000);
}

// --- Document view -------------------------------------------------------

async function renderDocument(path) {
  const bc = document.getElementById('breadcrumb');
  const parts = path.split('/');
  bc.innerHTML = '<a href="#dashboard">dashboard</a> / ' +
    parts.map((p, i) => {
      if (i < parts.length - 1) return `<span>${p}</span>`;
      return `<strong>${p}</strong>`;
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
    contentEl.innerHTML = `<p class="bear-text">Failed to load ${path}</p>`;
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
    sensors: '#1f6e3f',
    prompts: '#b67c0a',
    operations: '#a02a26',
    'domain-knowledge': '#4a463c',
    repos: '#756f5f',
    'api-references': '#1f6e3f',
    bin: '#8a8576',
    root: '#16140f',
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

  const link = svg.append('g').selectAll('line').data(links).join('line').attr('class', 'link');

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

  node.append('circle').attr('r', d => d.radius).attr('fill', d => colors[d.group] || '#666');
  node.append('text').attr('dx', d => d.radius + 4).attr('dy', 4).text(d => d.name);

  node.on('mouseover', (e, d) => {
    tooltip.style.display = 'block';
    tooltip.innerHTML = `<strong>${d.name}</strong><br><span class="dim">${d.id}</span>`;
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
    link.attr('x1', d => d.source.x).attr('y1', d => d.source.y)
      .attr('x2', d => d.target.x).attr('y2', d => d.target.y);
    node.attr('transform', d => `translate(${d.x},${d.y})`);
  });
}

// --- Router --------------------------------------------------------------

function navigate(hash) { window.location.hash = hash; }

function recordView(katern, sensor) {
  if (window.PulseObserver) {
    try { window.PulseObserver.record(katern, 'view', sensor); }
    catch (e) { /* observer is best-effort, never fail navigation */ }
  }
}

// On *.press.me subdomains the default landing is the research katern,
// not the markt-cockpit dashboard. apex (press.me) keeps default behavior.
function defaultRouteForHost() {
  const host = (window.location && window.location.hostname) || '';
  if (/^(mathijs|tara)\.press\.me$/i.test(host)) return 'research';
  return 'dashboard';
}

function handleRoute() {
  const hash = window.location.hash.slice(1) || defaultRouteForHost();
  document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
  document.querySelectorAll('.nav-links a').forEach(a => a.classList.remove('active'));

  if (hash === 'dashboard') {
    document.getElementById('dashboard-view').classList.add('active');
    const link = document.querySelector('[data-view="dashboard"]');
    if (link) link.classList.add('active');
    recordView('dashboard');
    return;
  }
  if (hash === 'graph') {
    document.getElementById('graph-view').classList.add('active');
    const link = document.querySelector('[data-view="graph"]');
    if (link) link.classList.add('active');
    renderGraph();
    recordView('graph');
    return;
  }
  if (hash.startsWith('doc/')) {
    document.getElementById('document-view').classList.add('active');
    renderDocument(hash.slice(4));
    recordView('doc', hash.slice(4));
    return;
  }
  // Katern routes: #<katern> en #<katern>/<sensor>
  // Sensor-segment accepteert lowercase + uppercase + digits + dash zodat
  // necrologie-IDs (`H-CVD-12`) en sensor-aliases (`meta-stelling`) beide passen.
  const katernMatch = hash.match(/^([a-z]+)(?:\/([A-Za-z0-9\-]+))?$/);
  if (katernMatch) {
    const [, katern, sensor] = katernMatch;
    if (KATERN_DEFS[katern]) {
      if (sensor) {
        // Laag 3 — sensor-deep. Tot getrapt-paradigma gemigreerd is (wacht
        // op NEMESIS A/B ≥55%) toont deze view de huidige sensor-md direct
        // via document-view. URL kan een display-alias zijn (`meta-stelling`)
        // — translate terug naar file-naam (`machinekamer`) voor fetch.
        // NECROLOGIE: deep-link is `#necrologie/<id>` waarbij id het filename
        // prefix is (H-CVD-12 → necrologie/H-CVD-12.md). Pad-segment komt uit
        // necrologie/, niet sensors/.
        document.getElementById('document-view').classList.add('active');
        const docPath = (katern === 'necrologie')
          ? `necrologie/${sensor}.md`
          : `sensors/${fileSensor(sensor)}.md`;
        renderDocument(docPath);
        recordView(katern, sensor);
      } else {
        // Laag 2 — katern-voorpagina.
        document.getElementById('katern-view').classList.add('active');
        const link = document.querySelector(`[data-view="${katern}"]`);
        if (link) link.classList.add('active');
        renderKatern(katern);
        recordView(katern);
      }
      return;
    }
  }
  // Onbekende hash — terug naar dashboard.
  document.getElementById('dashboard-view').classList.add('active');
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
  if (window.Alerts) window.Alerts.init(document.getElementById('alert-stack'));
  if (window.Thermometers) {
    window.Thermometers.mountThermometers(document.getElementById('heat-grid'));
  }
  if (window.PulseObserver) window.PulseObserver.start();

  try {
    await fetchTree();
    await renderDashboard();
    handleRoute();
  } catch (e) {
    const editorial = document.getElementById('editorial');
    if (editorial) {
      editorial.innerHTML = '<div class="loading">Failed to connect to wiki API.</div>';
    }
    console.error('[pulse] init failed', e);
  }

  startLiveLoop();

  // Wiki content refresh every 5 minutes — re-renders editorial + re-paints
  // live values into the freshly-rendered DOM.
  setInterval(async () => {
    cache = {};
    tree = null;
    registry = null;
    try {
      await fetchTree();
      if (document.getElementById('dashboard-view').classList.contains('active')) {
        await renderDashboard();
        injectLivePrices();
      }
    } catch (e) { /* silent refresh failure */ }
  }, 300000);
}

init();
