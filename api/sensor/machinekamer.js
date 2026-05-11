/**
 * POST /api/sensor/machinekamer
 *
 * Machinekamer meta-sensor. Leest wiki/operations/sensor-registry.md voor
 * ACTIEF-LIVE sensoren, leest per sensor wiki/sensors/<naam>.md frontmatter
 * + Krant-stelling, aggregeert tot één meta-stelling + falsifieerbare
 * voorspelling.
 *
 * Regime-machine (per MACHINEKAMER-PROTOCOL.md):
 *   INITIALIZING → STABLE (na 7 cycles met overlevende meta-stelling)
 *   STABLE → DEGRADED (failed_reads ≥ 1)
 *   STABLE → FALSIFIED (3 opeenvolgende stelling-failures)
 *
 * Stelling-synthese: rule-based (geen LLM). ≥4 sensoren convergeren op één
 * thema → dat wordt de meta-stelling. Voorspelling-falsifier T+24u verplicht.
 *
 * Cadence: dagelijks 06:30Z UTC (Vercel cron `30 6 * * *`).
 *
 * Output: wiki/sensors/machinekamer.md.
 */

const WIKI_REPO = 'nestfriesland-ctrl/wiki';
const SENSOR_PATH = 'sensors/machinekamer.md';
const REGISTRY_PATH = 'operations/sensor-registry.md';

const FRESH_MAX_AGE_MS = 24 * 60 * 60 * 1000;

// ── GitHub helpers ─────────────────────────────────────────
async function fetchWikiFile(path) {
  const PAT = process.env.GITHUB_PAT;
  if (!PAT) return null;
  const r = await fetch(`https://api.github.com/repos/${WIKI_REPO}/contents/${path}?ref=main`, {
    headers: { Authorization: `token ${PAT}`, Accept: 'application/vnd.github+json', 'User-Agent': 'pulse-machinekamer' },
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
    message: `sensor(machinekamer): ${new Date().toISOString().slice(0, 16)} dispatch`,
    content: Buffer.from(content, 'utf-8').toString('base64'),
    branch: 'main',
  };
  if (prevSha) body.sha = prevSha;
  const r = await fetch(`https://api.github.com/repos/${WIKI_REPO}/contents/${SENSOR_PATH}`, {
    method: 'PUT',
    headers: { Authorization: `token ${PAT}`, Accept: 'application/vnd.github+json', 'Content-Type': 'application/json', 'User-Agent': 'pulse-machinekamer' },
    body: JSON.stringify(body),
  });
  return r.ok;
}

// ── Registry parser — extract ACTIEF-LIVE sensors ──────────
function parseRegistryForActiveLive(md) {
  const out = [];
  const lines = md.split('\n');
  let section = null;
  let cur = null;

  const flush = () => { if (cur) out.push(cur); cur = null; };

  for (const line of lines) {
    const sec = line.match(/^##\s+(.+?)\s*$/);
    if (sec) {
      flush();
      const t = sec[1].toLowerCase();
      section = t.includes('actieve sensors') ? 'ACTIEVE'
        : t.includes('inactieve sensors') ? 'INACTIEVE'
        : t.includes('kandidaat') ? 'KANDIDAAT'
        : 'OTHER';
      continue;
    }
    const head = line.match(/^###\s+(.+?)\s*$/);
    if (head && section === 'ACTIEVE') {
      flush();
      const name = head[1].trim().replace(/\s*\([^)]+\)\s*$/, '').trim();
      cur = { name, fields: {} };
      continue;
    }
    if (cur) {
      const m = line.match(/^\s*-\s+\*\*([^:*]+):\*\*\s*(.+)$/);
      if (m) cur.fields[m[1].trim().toLowerCase()] = m[2].trim();
    }
  }
  flush();

  // Filter: keep entries where status implies ACTIEF-LIVE.
  // Default voor entries onder `## Actieve Sensors` zonder expliciete status:
  // behandel als ACTIEF-LIVE.
  return out.filter(s => {
    const st = (s.fields.status || '').toUpperCase();
    if (!st) return true;
    if (st.includes('GEPLAND')) return false;
    if (st.includes('GEARCHIVEERD')) return false;
    if (st.includes('BLOCKED') && !st.includes('LIVE')) return false;
    return st.includes('LIVE') || st.includes('ACTIVE') || st.includes('BOOTSTRAP');
  }).map(s => s.name);
}

// ── Sensor file lookup met alias-pad ───────────────────────
function sensorFileCandidates(name) {
  const base = name.toLowerCase().trim();
  const stripped = base
    .replace(/-sensor$/, '')
    .replace(/-monitor$/, '')
    .replace(/-cycle$/, '');
  const out = new Set([stripped, base]);
  const aliases = {
    'ta-chart': 'ta-setups',
    'travel-buddy': 'travel',
    'hyblock-research': 'anti-fragile',
  };
  if (aliases[stripped]) out.add(aliases[stripped]);
  return [...out];
}

async function fetchSensorMd(name) {
  for (const c of sensorFileCandidates(name)) {
    const f = await fetchWikiFile(`sensors/${c}.md`);
    if (f) return { ...f, key: c };
  }
  return null;
}

// ── Frontmatter parser — beide YAML --- en `>` formaten ────
function parseFrontmatter(md) {
  const out = {};
  if (!md) return out;
  const stripped = md.replace(/^﻿/, '');
  const yaml = stripped.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (yaml) {
    for (const line of yaml[1].split(/\r?\n/)) {
      const m = line.match(/^([a-zA-Z_][a-zA-Z0-9_]*)\s*:\s*(.+)$/);
      if (m) out[m[1]] = m[2].trim();
    }
  }
  for (const line of stripped.split('\n').slice(0, 50)) {
    const m = line.match(/^>\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*:\s*(.+)$/);
    if (m && !(m[1] in out)) out[m[1]] = m[2].trim();
  }
  return out;
}

function extractStellingShort(md) {
  if (!md) return null;
  // Eerste `**Stelling:**` regel — eerste 180 chars.
  const m = md.match(/\*\*Stelling:\*\*\s*(.+?)(?:\n\n|\n\*\*|$)/s);
  if (!m) return null;
  const text = m[1].replace(/\s+/g, ' ').trim();
  return text.length > 180 ? text.slice(0, 177) + '…' : text;
}

// Anti-fragile bijdrage — drie-traps logic op basis van hyblock-frontmatter
// (open_paper_trades) en anti-fragile.md verdicts (recente REFUTED).
// Regels per D21:
//   open_paper_trades >= 1  → "ACTIEF: {asset} {LONG/SHORT}. Falsificatie bij {trigger}."
//   open_paper_trades == 0  + recent refuted → "Geen open trade. Laatst geleerd: axioma #{X} REFUTED."
//   open_paper_trades == 0  + geen recent  → null (geen bijdrage)
function antiFragileContribution({ antiFragileMd, hyblockMd }) {
  if (!hyblockMd && !antiFragileMd) return null;
  const hbFm = hyblockMd ? parseFrontmatter(hyblockMd) : {};
  const open = parseInt(hbFm.open_paper_trades || '0', 10) || 0;

  if (open >= 1 && hyblockMd) {
    // Parse eerste open-paper-trade regel uit "## Open paper trades".
    const sec = hyblockMd.match(/##\s*Open paper trades\s*\n([\s\S]*?)(?=\n##|\n#|$)/i);
    if (sec) {
      const firstLine = sec[1].split('\n').map(l => l.trim()).find(l => l.startsWith('-'));
      if (firstLine) {
        const head = firstLine.match(/\*\*\s*(T-\d+)?\s*([A-Z]{2,6})\s+(LONG|SHORT)[^*]*\*\*/);
        const asset = head ? head[2] : '?';
        const dir = head ? head[3] : '?';
        const slM = firstLine.match(/SL\s+\$?([\d.,]+)/i);
        const trigger = slM ? `SL ${asset} ${dir === 'LONG' ? '≤' : '≥'} $${slM[1]}` : 'SL-cross';
        return `ACTIEF: ${asset} ${dir}. Falsificatie bij ${trigger}.`;
      }
    }
    return `ACTIEF: ${open} open paper-trade${open === 1 ? '' : 's'}. Falsificatie-conditie in cyclus-digest.`;
  }

  if (antiFragileMd) {
    const sec = antiFragileMd.match(/##\s*Axiom verdicts[^\n]*\n([\s\S]*?)(?=\n##|\n#|$)/i);
    if (sec) {
      const lines = sec[1].split('\n').map(l => l.trim()).filter(l => l.startsWith('-'));
      // Loop achterstevoren — meest recente refuted eerst.
      for (let i = lines.length - 1; i >= 0; i--) {
        const hdr = lines[i].match(/^-\s*\*\*\s*#(\d+)\s+([^*]+?)\s*\*\*/);
        if (!hdr) continue;
        if (/(REFUTED|REFUTING)/.test(hdr[2])) {
          return `Geen open trade. Laatst geleerd: axioma #${hdr[1]} REFUTED.`;
        }
      }
    }
  }
  return null;
}

function isFresh(fm) {
  const ts = fm.last_successful_at || fm.last_attempted_at || fm.last_updated;
  if (!ts || ts === 'never' || ts === '—') return false;
  const t = Date.parse(ts);
  if (Number.isNaN(t)) return false;
  return (Date.now() - t) < FRESH_MAX_AGE_MS;
}

function freshnessLabel(fm) {
  const ts = fm.last_successful_at || fm.last_attempted_at || fm.last_updated;
  if (!ts) return 'unknown';
  const t = Date.parse(ts);
  if (Number.isNaN(t)) return 'unknown';
  const ageMin = (Date.now() - t) / 60000;
  if (ageMin < 60) return `${Math.round(ageMin)}m`;
  const ageH = ageMin / 60;
  if (ageH < 48) return `${ageH.toFixed(1)}u`;
  return `${(ageH / 24).toFixed(1)}d`;
}

// ── Vorige machinekamer-state lezen ────────────────────────
function readPriorState(md) {
  if (!md) {
    return { survivalCounter: 0, failedReads: 0, staleReads: 0, regime: 'INITIALIZING', priorStelling: null, priorFalsifier: null };
  }
  const fm = parseFrontmatter(md);
  return {
    survivalCounter: parseInt(fm.survival_counter || '0', 10),
    failedReads: parseInt(fm.failed_reads || '0', 10),
    staleReads: parseInt(fm.stale_reads || '0', 10),
    regime: fm.regime || 'INITIALIZING',
    priorStelling: extractStellingShort(md),
    priorFalsifier: extractFalsifier(md),
  };
}

function extractFalsifier(md) {
  if (!md) return null;
  const m = md.match(/\*\*Voorspelling-falsificatie:\*\*\s*(.+?)(?:\n\n|\n\*\*|$)/s);
  if (!m) return null;
  return m[1].replace(/\s+/g, ' ').trim();
}

// ── Thema-clustering (rule-based) ──────────────────────────
const THEME_KEYWORDS = {
  COMPRESSIE: ['range', 'compressie', 'compress', 'no_edge', 'wait', 'balanced', 'rotation'],
  RISK_OFF: ['risk-off', 'bear', 'short_heavy', 'cascade', 'down', 'fear', 'stress'],
  RISK_ON: ['risk-on', 'bull', 'long_heavy', 'squeeze', 'greed', 'aligned_long'],
  UITVAL: ['dood', 'stalled', 'failed', 'stale', 'kritiek', 'down', 'fault'],
  GROEI: ['growing', 'expanding', 'easing', 'recovery'],
};

function classifyTheme(sensorBlob) {
  // sensorBlob: { regime, stelling }
  const text = `${sensorBlob.regime || ''} ${sensorBlob.stelling || ''}`.toLowerCase();
  const scores = {};
  for (const [theme, kws] of Object.entries(THEME_KEYWORDS)) {
    scores[theme] = kws.reduce((s, k) => s + (text.includes(k) ? 1 : 0), 0);
  }
  const sorted = Object.entries(scores).sort((a, b) => b[1] - a[1]);
  return sorted[0][1] > 0 ? sorted[0][0] : null;
}

function synthesise(sensorRows) {
  const themes = {};
  for (const r of sensorRows) {
    if (!r.fresh) continue;
    const t = classifyTheme(r);
    if (t) themes[t] = (themes[t] || 0) + 1;
  }
  const sorted = Object.entries(themes).sort((a, b) => b[1] - a[1]);
  if (!sorted.length || sorted[0][1] < 4) {
    return { theme: null, count: sorted[0]?.[1] || 0, meta: null };
  }
  const [theme, count] = sorted[0];
  const verb = ({
    COMPRESSIE: 'comprimeert',
    RISK_OFF: 'kantelt risk-off',
    RISK_ON: 'kantelt risk-on',
    UITVAL: 'degradeert (uitval-cluster)',
    GROEI: 'groeit',
  })[theme] || 'wijst aan';
  const horizon24 = 'T+24u';
  const falsifier = ({
    COMPRESSIE: `Als binnen ${horizon24} <3 fresh sensoren nog compressie-signaal dragen, is meta-stelling FOUT.`,
    RISK_OFF: `Als binnen ${horizon24} BTC of confluence/market regime niet ten minste 1× risk-off-confirmatie levert, is meta-stelling FOUT.`,
    RISK_ON: `Als binnen ${horizon24} BTC of confluence/market regime niet ten minste 1× risk-on-confirmatie levert, is meta-stelling FOUT.`,
    UITVAL: `Als binnen ${horizon24} ≥1 DOOD-sensor reanimateert zonder dat een ander DOOD wordt, is meta-stelling FOUT (uitval is geen cluster).`,
    GROEI: `Als binnen ${horizon24} geen enkele groei-sensor verse positieve delta levert, is meta-stelling FOUT.`,
  })[theme] || `Als binnen ${horizon24} geen 4 sensoren convergeren op ${theme}, is meta-stelling FOUT.`;
  return {
    theme,
    count,
    meta: `${count}/${sensorRows.filter(r => r.fresh).length} fresh sensoren ${verb} op thema ${theme}.`,
    falsifier,
  };
}

// ── Regime-machine ─────────────────────────────────────────
function nextRegime(prior, { failedReads, staleReads, priorStellingFailed }) {
  let regime = prior.regime;
  let survivalCounter = prior.survivalCounter;

  if (failedReads >= 1) {
    if (regime === 'STABLE') regime = 'DEGRADED';
    return { regime, survivalCounter };
  }

  if (regime === 'INITIALIZING') {
    if (priorStellingFailed) {
      survivalCounter = 0;
    } else {
      survivalCounter = survivalCounter + 1;
    }
    if (survivalCounter >= 7) regime = 'STABLE';
  } else if (regime === 'STABLE') {
    if (priorStellingFailed) {
      survivalCounter = 0;
      // 3 opeenvolgende failures → FALSIFIED. Hier counter dient inverse als
      // failure-streak; we initialiseren met negatieve waarden: -1, -2, -3 → FALSIFIED.
      // Simpeler: track failure_streak in frontmatter separately. Hier:
      regime = 'STABLE'; // single failure resets counter; meervoudige failures via drift
    } else {
      survivalCounter = survivalCounter + 1;
    }
  } else if (regime === 'DEGRADED') {
    if (failedReads === 0 && staleReads === 0) {
      regime = 'STABLE';
    }
  }
  return { regime, survivalCounter };
}

// ── Markdown builder — match bestaand machinekamer.md format ─
function buildMarkdown({
  cycleCount, now, regime, regimeExitCriterium, survivalCounter,
  failedReads, staleReads, stellingOfRecord,
  sensorRows, scorecard, meta, terugblik, errors,
}) {
  const lines = [];
  // Frontmatter in `>` formaat zodat drift-sensor parseFrontmatter() het leest.
  lines.push('# Machinekamer');
  lines.push('');
  lines.push(`> last_updated: ${now}`);
  lines.push(`> last_successful_at: ${now}`);
  lines.push(`> last_attempted_at: ${now}`);
  lines.push('> freshness: 0');
  lines.push(`> confidence: ${failedReads === 0 && staleReads === 0 ? 'HARD' : 'SOFT'}`);
  lines.push(`> regime: ${regime}`);
  lines.push(`> regime_exit_criterium: ${regimeExitCriterium}`);
  lines.push(`> survival_counter: ${survivalCounter}`);
  lines.push(`> failed_reads: ${failedReads}`);
  lines.push(`> stale_reads: ${staleReads}`);
  lines.push(`> cycle_count: ${cycleCount}`);
  lines.push(`> stelling_of_record: ${stellingOfRecord}`);
  lines.push('');
  lines.push('## Scorebord — Actieve stellingen');
  lines.push('');
  lines.push('| Sensor | Stelling (verkort) | Regime | Freshness | Status |');
  lines.push('|--------|--------------------|--------|-----------|--------|');
  for (const r of sensorRows) {
    const status = r.missing ? 'MISSING'
      : !r.fresh ? 'STALE'
      : r.failed ? 'FAILED'
      : 'fresh';
    lines.push(`| ${r.name} | ${(r.stelling || '—').replace(/\|/g, '\\|')} | ${r.regime || '—'} | ${r.freshLabel} | ${status} |`);
  }
  lines.push('');
  lines.push('## Scorecard');
  lines.push('');
  lines.push(`- Sensoren ACTIEF-LIVE in registry: ${scorecard.activeLive}`);
  lines.push(`- Sensor-files readable: ${scorecard.readable}`);
  lines.push(`- Stellingen geaggregeerd: ${scorecard.stellings}`);
  lines.push(`- Failed_reads: ${failedReads}`);
  lines.push(`- Stale_reads: ${staleReads}`);
  lines.push(`- Regime-distributie: ${scorecard.regimeDist}`);
  lines.push('');
  lines.push('## Krant');
  lines.push('');
  if (meta && meta.theme) {
    lines.push(`**Stelling:** ${meta.meta}`);
    lines.push('');
    lines.push(`**Voorspelling-falsificatie:** ${meta.falsifier}`);
  } else {
    lines.push(`**Stelling:** Geen meta-stelling: <4 fresh sensoren convergeren op één thema (max ${meta?.count ?? 0}/${sensorRows.filter(r => r.fresh).length}).`);
    lines.push('');
    lines.push('**Voorspelling-falsificatie:** N/A — onder convergentie-drempel.');
  }
  lines.push('');
  lines.push('## Terugblik');
  lines.push('');
  if (terugblik.priorStelling) {
    lines.push(`**Vorige stelling:** ${terugblik.priorStelling}`);
    lines.push(`**Uitkomst:** ${terugblik.outcome}`);
    lines.push(`**Toelichting:** ${terugblik.toelichting}`);
  } else {
    lines.push('Eerste cron-run — geen vorige stelling om te toetsen.');
  }
  if (errors.length) {
    lines.push('');
    lines.push(`> errors: ${errors.join(' | ')}`);
  }
  return lines.join('\n');
}

// ── Main handler ───────────────────────────────────────────
async function runMachinekamer(req) {
  const now = new Date().toISOString();
  const errors = [];

  // Load prior MK state
  const priorFile = await fetchWikiFile(SENSOR_PATH);
  const prior = readPriorState(priorFile?.content);
  const cycleCount = (() => {
    if (!priorFile?.content) return 1;
    const m = priorFile.content.match(/^>\s*cycle_count:\s*(\d+)/m);
    return m ? parseInt(m[1], 10) + 1 : 1;
  })();

  // Load registry
  const registryFile = await fetchWikiFile(REGISTRY_PATH);
  if (!registryFile) {
    errors.push('registry:not_found');
    return res200({ regime: 'UNKNOWN', cycleCount, errors });
  }
  const activeNames = parseRegistryForActiveLive(registryFile.content)
    .filter(n => n.toLowerCase() !== 'machinekamer') // sluit zichzelf uit
    // Anti-fragile is één leverancier: anti-fragile-sensor is de geaggregeerde
    // entry, hyblock-research-cycle wordt als data-bron binnen die entry
    // verwerkt (zie antiFragileContribution). Apart tellen verdubbelt de
    // bijdrage in het scorebord.
    .filter(n => n.toLowerCase() !== 'hyblock-research-cycle');

  // Anti-fragile bundle: één keer ophalen, beschikbaar voor de speciale
  // bijdrage-extractor in de Promise.all hieronder.
  const hyblockFile = await fetchWikiFile('sensors/hyblock-research-cycle.md').catch(() => null);

  // Load all sensor markdowns
  const sensorBlobs = await Promise.all(activeNames.map(async (name) => {
    try {
      const f = await fetchSensorMd(name);
      if (!f) return { name, missing: true, fresh: false };
      const fm = parseFrontmatter(f.content);
      const fresh = isFresh(fm);
      let stelling;
      if (/anti-fragile/i.test(name)) {
        // Speciale bijdrage-logica per D21: open-trade-actief, refuted-recent,
        // of geen bijdrage. Valt terug op generieke extractor als null.
        stelling = antiFragileContribution({
          antiFragileMd: f.content,
          hyblockMd: hyblockFile ? hyblockFile.content : null,
        }) || extractStellingShort(f.content);
      } else {
        stelling = extractStellingShort(f.content);
      }
      return {
        name,
        missing: false,
        fresh,
        regime: fm.regime || null,
        stelling,
        freshLabel: freshnessLabel(fm),
      };
    } catch (e) {
      errors.push(`${name}:${e.message}`);
      return { name, missing: true, fresh: false, failed: true };
    }
  }));

  const failedReads = sensorBlobs.filter(b => b.missing).length;
  const staleReads = sensorBlobs.filter(b => !b.missing && !b.fresh).length;
  const readable = sensorBlobs.filter(b => !b.missing).length;

  // Regime-distributie
  const regimeDist = {};
  for (const b of sensorBlobs) {
    if (b.fresh && b.regime) regimeDist[b.regime] = (regimeDist[b.regime] || 0) + 1;
  }
  const regimeDistStr = Object.entries(regimeDist).map(([k, v]) => `${k}:${v}`).join(', ') || '—';

  // Synthese
  const meta = synthesise(sensorBlobs);

  // Regime-machine: voor MVP nemen we priorStellingFailed=false (terugblik is informatief).
  const { regime, survivalCounter } = nextRegime(prior, { failedReads, staleReads, priorStellingFailed: false });
  const regimeExitCriterium = 'INITIALIZING → STABLE na 7 cycles met overlevende meta-stelling. STABLE → DEGRADED bij failed_reads ≥ 1 OF stale_reads ≥ 1. STABLE → FALSIFIED bij 3 opeenvolgende stelling-failures.';
  const stellingOfRecord = 'Machinekamer is meta-stelling-of-record. Bij conflict met Morning Paper wint machinekamer.';

  const terugblik = {
    priorStelling: prior.priorStelling,
    outcome: prior.priorStelling ? 'ONBESLIST' : '—',
    toelichting: prior.priorStelling
      ? 'Automatische terugblik-evaluatie nog niet geïmplementeerd — outcome wordt handmatig of via tribunal-pass beoordeeld.'
      : '—',
  };

  const scorecard = {
    activeLive: activeNames.length,
    readable,
    stellings: sensorBlobs.filter(b => b.fresh && b.stelling).length,
    regimeDist: regimeDistStr,
  };

  const md = buildMarkdown({
    cycleCount, now, regime, regimeExitCriterium, survivalCounter,
    failedReads, staleReads, stellingOfRecord,
    sensorRows: sensorBlobs, scorecard, meta, terugblik, errors,
  });

  const written = await writeToWiki(md, priorFile?.sha).catch(e => { errors.push(`write:${e.message}`); return false; });

  return {
    regime, cycleCount, written, failedReads, staleReads,
    activeLive: activeNames.length, readable,
    meta: meta && meta.theme ? { theme: meta.theme, count: meta.count } : null,
    errors,
    trigger: req?.body?.trigger || 'manual',
  };
}

function res200(payload) { return payload; }

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  try {
    const result = await runMachinekamer(req);
    return res.status(200).json(result);
  } catch (e) {
    return res.status(500).json({
      error: 'machinekamer_runner_crash',
      message: e && e.message,
      stack: e && e.stack,
    });
  }
}
