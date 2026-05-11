/**
 * POST /api/sensor/infra
 *
 * Infra sensor — HTTP-level uptime checks van services waar pulse + nest-frl
 * + ctrl-engine van afhangen. Snel falen (1u cadens) zodat structurele
 * uitval binnen één cyclus zichtbaar is.
 *
 * Sources (alle public of met env-key):
 *   - Vercel API /v6/deployments (pulse + mathijs-immortality projecten READY?)
 *   - GitHub API /zen (200 = githuB up)
 *   - CoinGecko /api/v3/ping
 *   - FRED /fred/category?api_key=… (requires FRED_API_KEY)
 *   - Kraken /0/public/SystemStatus (online/maintenance/cancel_only/post_only)
 *
 * Regime:
 *   SERVICES_OK        — alle bronnen reachable
 *   SERVICES_DEGRADED  — 1-2 down
 *   SERVICES_KRITIEK   — ≥3 down
 *
 * Output: wiki/sensors/infra.md (YAML frontmatter + Krant-discipline).
 * Cadens: Vercel cron 0 * /1 * * * (elk uur).
 */

const WIKI_REPO = 'nestfriesland-ctrl/wiki';
const SENSOR_PATH = 'sensors/infra.md';

const CAP_KOP = 90;
const CAP_STELLING = 240;
const CAP_BEWIJS = 140;
const CAP_LES = 140;
const CAP_ACTIE = 140;

const HTTP_TIMEOUT_MS = 8000;

async function timedFetch(url, opts = {}) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS);
  try {
    const r = await fetch(url, { ...opts, signal: controller.signal });
    return r;
  } finally {
    clearTimeout(id);
  }
}

async function checkGithub() {
  const r = await timedFetch('https://api.github.com/zen', {
    headers: { 'User-Agent': 'pulse-infra' },
  });
  return { ok: r.ok, status: r.status };
}

async function checkCoinGecko() {
  const r = await timedFetch('https://api.coingecko.com/api/v3/ping');
  return { ok: r.ok, status: r.status };
}

async function checkKraken() {
  const r = await timedFetch('https://api.kraken.com/0/public/SystemStatus');
  if (!r.ok) return { ok: false, status: r.status, detail: 'http_fail' };
  const j = await r.json();
  const status = j?.result?.status || 'unknown';
  return { ok: status === 'online', status: 200, detail: status };
}

async function checkFRED() {
  const key = process.env.FRED_API_KEY;
  if (!key) return { ok: false, status: 0, detail: 'no_key' };
  const r = await timedFetch(`https://api.stlouisfed.org/fred/category?category_id=125&api_key=${key}&file_type=json`);
  return { ok: r.ok, status: r.status };
}

async function checkVercel() {
  const token = process.env.VERCEL_TOKEN;
  const team = process.env.VERCEL_TEAM_ID;
  if (!token || !team) return { ok: false, status: 0, detail: 'no_token' };
  const r = await timedFetch(`https://api.vercel.com/v6/deployments?teamId=${team}&limit=5`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!r.ok) return { ok: false, status: r.status, detail: 'http_fail' };
  const j = await r.json();
  const deployments = j?.deployments || [];
  const errored = deployments.filter(d => d.state === 'ERROR').length;
  return { ok: true, status: 200, detail: `${deployments.length} recent, ${errored} ERROR` };
}

// ── Wiki I/O ────────────────────────────────────────────────
async function loadPreviousMarkdown() {
  const PAT = process.env.GITHUB_PAT;
  if (!PAT) return null;
  const r = await fetch(`https://api.github.com/repos/${WIKI_REPO}/contents/${SENSOR_PATH}?ref=main`, {
    headers: { Authorization: `token ${PAT}`, Accept: 'application/vnd.github+json', 'User-Agent': 'pulse-infra' },
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
    message: `sensor(infra): ${new Date().toISOString().slice(0, 16)} dispatch`,
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
      'User-Agent': 'pulse-infra',
    },
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

function buildKrant({ regime, downCount, totalCount, downList }) {
  const verb = regime === 'SERVICES_OK' ? 'draait gezond' : regime === 'SERVICES_DEGRADED' ? 'wankelt' : 'staat KRITIEK';
  const kop = cap(`Infra ${verb} — ${totalCount - downCount}/${totalCount} services up.`, CAP_KOP);

  const stelling = cap(
    `Komend uur blijft regime ${regime} stabiel als alle nu-down services down blijven en geen extra service uitvalt; valsifieerbaar bij wijziging in up/down-telling of regime-flip.`,
    CAP_STELLING,
  );

  const bewijs = cap(
    downList.length
      ? `Down: ${downList.join(', ')}. Total ${totalCount - downCount}/${totalCount} OK.`
      : `Alle ${totalCount} services reachable; latency binnen ${HTTP_TIMEOUT_MS}ms.`,
    CAP_BEWIJS,
  );

  const les = cap(
    regime === 'SERVICES_OK'
      ? 'Geen actie nodig; pipeline-output is betrouwbaar op infra-niveau.'
      : regime === 'SERVICES_DEGRADED'
        ? 'Eén bron uit; markt/macro-sensors degraderen mogelijk stil — check error-velden in afhankelijke outputs.'
        : 'Meerdere bronnen uit; pipeline-output wantrouwen tot infra-herstel.',
    CAP_LES,
  );

  const actie = cap(
    regime === 'SERVICES_OK'
      ? 'Geen actie.'
      : `Onderzoek ${downList.join(', ') || 'down-services'} — check status-pages en env-keys.`,
    CAP_ACTIE,
  );

  return { kop, stelling, bewijs, les, actie };
}

function buildMarkdown({
  cycleCount, lastAttemptedAt, lastSuccessfulAt,
  regime, results, downList, errors,
}) {
  const downCount = downList.length;
  const totalCount = Object.keys(results).length;
  const krant = buildKrant({ regime, downCount, totalCount, downList });

  return [
    '---',
    'sensor: infra',
    `regime: ${regime}`,
    `last_attempted_at: ${lastAttemptedAt}`,
    `last_successful_at: ${lastSuccessfulAt || 'never'}`,
    `last_updated: ${lastAttemptedAt}`,
    'freshness: 0',
    'confidence: HARD',
    `cycle_count: ${cycleCount}`,
    `services_up: ${totalCount - downCount}`,
    `services_down: ${downCount}`,
    `services_total: ${totalCount}`,
    `down_services: ${downList.join(',') || '-'}`,
    `vercel_ok: ${results.vercel.ok}`,
    `github_ok: ${results.github.ok}`,
    `coingecko_ok: ${results.coingecko.ok}`,
    `fred_ok: ${results.fred.ok}`,
    `kraken_ok: ${results.kraken.ok}`,
    '---',
    '',
    '# Infra',
    '',
    `> Run ${cycleCount} — ${lastAttemptedAt}. Regime: **${regime}** (${totalCount - downCount}/${totalCount} up).`,
    '',
    '## Scorebord',
    '',
    '| Service | Status | HTTP | Detail |',
    '|---------|--------|------|--------|',
    `| Vercel API | ${results.vercel.ok ? '✓' : '✗'} | ${results.vercel.status} | ${results.vercel.detail || '—'} |`,
    `| GitHub API | ${results.github.ok ? '✓' : '✗'} | ${results.github.status} | ${results.github.detail || '—'} |`,
    `| CoinGecko | ${results.coingecko.ok ? '✓' : '✗'} | ${results.coingecko.status} | ${results.coingecko.detail || '—'} |`,
    `| FRED | ${results.fred.ok ? '✓' : '✗'} | ${results.fred.status} | ${results.fred.detail || '—'} |`,
    `| Kraken | ${results.kraken.ok ? '✓' : '✗'} | ${results.kraken.status} | ${results.kraken.detail || '—'} |`,
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
    `Bronnen: Vercel /v6/deployments, GitHub /zen, CoinGecko /ping, FRED /category, Kraken /SystemStatus. Cadens 1u. HTTP timeout ${HTTP_TIMEOUT_MS}ms.`,
    `Regime: 0 down=OK, 1-2 down=DEGRADED, ≥3 down=KRITIEK. Detect: snel falen i.p.v. brede uitval-tolerantie. Down=non-2xx of vereiste env-keys ontbreken.`,
    errors && errors.length ? `\n> errors: ${errors.join(' | ')}` : '',
  ].filter(l => l !== '').join('\n');
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

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
    catch (e) {
      errors.push(`${label}:${e.message}`);
      return { ok: false, status: 0, detail: `error_${e.message.slice(0, 40)}` };
    }
  };

  const [vercel, github, coingecko, fred, kraken] = await Promise.all([
    safe('vercel', checkVercel()),
    safe('github', checkGithub()),
    safe('coingecko', checkCoinGecko()),
    safe('fred', checkFRED()),
    safe('kraken', checkKraken()),
  ]);

  const results = { vercel, github, coingecko, fred, kraken };
  const downList = Object.entries(results).filter(([, v]) => !v.ok).map(([k]) => k);
  const downCount = downList.length;
  const regime = downCount === 0 ? 'SERVICES_OK' : downCount <= 2 ? 'SERVICES_DEGRADED' : 'SERVICES_KRITIEK';

  const successAt = new Date().toISOString();
  const md = buildMarkdown({
    cycleCount, lastAttemptedAt, lastSuccessfulAt: successAt,
    regime, results, downList, errors,
  });

  const written = await writeToWiki(md, prevSha).catch(() => false);

  return res.status(200).json({
    regime, cycleCount, written, errors,
    snapshot: { downList, results },
    trigger: req.body?.trigger || 'manual',
  });
}
