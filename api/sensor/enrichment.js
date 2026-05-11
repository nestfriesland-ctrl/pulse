/**
 * POST /api/sensor/enrichment
 *
 * Pipeline-brede enrichment sensor — aggregeert enrichment-status over alle
 * ctrl-engine tenants (SKYLD, SANND, NEST). Onderscheidt zich van
 * tara/skyld.js door pipeline-scope ipv tenant-scope.
 *
 * Bron: GET https://app.skyld.nl/api/v1/enrichment/status
 * Auth: Bearer CRON_SECRET (env CTRL_ENGINE_API_TOKEN of CRON_SECRET).
 *
 * Cadence: dagelijks 06:00Z (Vercel cron `0 6 * * *`).
 *
 * Output: wiki/sensors/enrichment.md (mirror van macro-regime pattern).
 *
 * Regime:
 *   PIPELINE_HEALTHY  — totalPending < 5000, errors24h ≤ 10, daemon < 6h idle
 *   PIPELINE_BACKLOG  — totalPending ≥ 5000 OF daemon 6–24h idle
 *   PIPELINE_BLOCKED  — endpoint dood, errors24h > 100, OF daemon > 24h idle
 */

const WIKI_REPO = 'nestfriesland-ctrl/wiki';
const SENSOR_PATH = 'sensors/enrichment.md';
const CTRL_URL = 'https://app.skyld.nl';

const CAP_KOP = 90;
const CAP_STELLING = 240;
const CAP_BEWIJS = 140;
const CAP_LES = 140;
const CAP_ACTIE = 140;

const BACKLOG_THRESHOLD = 5000;
const ERRORS_BLOCKED = 100;
const ERRORS_ATTENTION = 10;
const DAEMON_IDLE_BACKLOG_H = 6;
const DAEMON_IDLE_BLOCKED_H = 24;

function cap(s, n) {
  if (s == null) return '';
  return s.length <= n ? s : s.slice(0, n - 1) + '…';
}

async function fetchEnrichmentStatus(token) {
  const r = await fetch(`${CTRL_URL}/api/v1/enrichment/status`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!r.ok) throw new Error(`status_${r.status}`);
  return r.json();
}

function hoursAgo(iso) {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  return (Date.now() - t) / 3.6e6;
}

function classifyRegime({ totalPending, errors24h, daemonIdleHours, hardErrors }) {
  if (hardErrors.length >= 1) return 'PIPELINE_BLOCKED';
  if (errors24h > ERRORS_BLOCKED) return 'PIPELINE_BLOCKED';
  if (daemonIdleHours != null && daemonIdleHours > DAEMON_IDLE_BLOCKED_H) return 'PIPELINE_BLOCKED';
  if (totalPending >= BACKLOG_THRESHOLD) return 'PIPELINE_BACKLOG';
  if (daemonIdleHours != null && daemonIdleHours > DAEMON_IDLE_BACKLOG_H) return 'PIPELINE_BACKLOG';
  if (errors24h > ERRORS_ATTENTION) return 'PIPELINE_BACKLOG';
  return 'PIPELINE_HEALTHY';
}

async function loadPreviousMarkdown() {
  const PAT = process.env.GITHUB_PAT;
  if (!PAT) return null;
  const r = await fetch(`https://api.github.com/repos/${WIKI_REPO}/contents/${SENSOR_PATH}?ref=main`, {
    headers: { Authorization: `token ${PAT}`, Accept: 'application/vnd.github+json', 'User-Agent': 'pulse-enrichment' },
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
    message: `sensor(enrichment): ${new Date().toISOString().slice(0, 16)} dispatch`,
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
      'User-Agent': 'pulse-enrichment',
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

function pct(n, d) {
  if (!d) return '0';
  return ((n / d) * 100).toFixed(1);
}

function buildKrant({ regime, orgs, totalPending, totalContacts, errors24h, daemonIdleHours }) {
  const verb = regime === 'PIPELINE_HEALTHY' ? 'draait' : regime === 'PIPELINE_BACKLOG' ? 'kreunt' : 'stokt';
  const idleStr = daemonIdleHours != null ? `${daemonIdleHours.toFixed(1)}u idle` : 'idle onbekend';

  const kop = cap(
    `Pipeline ${verb} — ${totalContacts} contacts, ${totalPending} pending, ${errors24h} err/24u, ${idleStr}.`,
    CAP_KOP,
  );

  const stelling = cap(
    regime === 'PIPELINE_BLOCKED'
      ? `Enrichment pipeline geblokkeerd: ${errors24h > ERRORS_BLOCKED ? `${errors24h} errors/24u boven ${ERRORS_BLOCKED}-grens` : (daemonIdleHours != null && daemonIdleHours > DAEMON_IDLE_BLOCKED_H) ? `daemon ${daemonIdleHours.toFixed(1)}u idle (>${DAEMON_IDLE_BLOCKED_H}u)` : 'endpoint of status onbereikbaar'}. Pipeline staat — geen verse verrijking tot blocker opgelost.`
      : regime === 'PIPELINE_BACKLOG'
        ? `Backlog actief: ${totalPending} pending verdeeld over ${orgs.length} tenants. ${errors24h > ERRORS_ATTENTION ? `${errors24h} errors/24u verhoogd. ` : ''}${daemonIdleHours != null && daemonIdleHours > DAEMON_IDLE_BACKLOG_H ? `Daemon ${daemonIdleHours.toFixed(1)}u idle. ` : ''}Doorvoer < intake.`
        : `Pipeline gezond: ${totalPending} pending onder ${BACKLOG_THRESHOLD}-grens, errors24h ${errors24h} ≤ ${ERRORS_ATTENTION}, daemon ${idleStr}. Verrijking houdt intake bij.`,
    CAP_STELLING,
  );

  const tenantBreakdown = orgs.map(o => `${o.org}=${o.pendingEnrichment ?? 0}/${o.total ?? 0}`).join(' ');
  const bewijs = cap(
    `Pending totaal ${totalPending}/${totalContacts} (${pct(totalPending, totalContacts)}%). Per tenant: ${tenantBreakdown}. Errors24h ${errors24h}. Daemon ${idleStr}.`,
    CAP_BEWIJS,
  );

  const les = cap(
    regime === 'PIPELINE_BLOCKED'
      ? 'Blocker eerst — geen nieuwe import zolang daemon dood is. Restart pas na root cause; KeepAlive boolean=true triggert niet bij clean exit.'
      : regime === 'PIPELINE_BACKLOG'
        ? 'Backlog inlopen voor nieuwe import. Pending boven 5k = systemic, niet transient. Check throughput per tenant.'
        : 'Healthy pipeline = stille pipeline. Geen interventie nodig; monitoren via daily cron.',
    CAP_LES,
  );

  const actie = cap(
    regime === 'PIPELINE_BLOCKED'
      ? 'Check ctrl-engine daemon + /api/v1/enrichment/status. Inspect launchd KeepAlive plist (boolean→dict).'
      : regime === 'PIPELINE_BACKLOG'
        ? `Throughput-meting: per-tenant uur/dag delta. Pauzeer import tot pending<${BACKLOG_THRESHOLD}. Profileer slowest tenant.`
        : 'Geen actie. Volgende cyclus 06:00Z.',
    CAP_ACTIE,
  );

  return { kop, stelling, bewijs, les, actie };
}

function buildMarkdown({
  cycleCount, lastAttemptedAt, lastSuccessfulAt,
  regime, orgs, totalPending, totalContacts, errors24h, lastEnrichedAt, daemonIdleHours, hardErrors,
}) {
  const krant = buildKrant({ regime, orgs, totalPending, totalContacts, errors24h, daemonIdleHours });

  const orgsRows = orgs.map(o =>
    `| ${o.org} | ${o.total ?? 0} | ${o.hasEnrichment ?? 0} | ${o.pendingEnrichment ?? 0} | ${o.new ?? 0} |`
  ).join('\n');

  return [
    '---',
    'sensor: enrichment',
    `regime: ${regime}`,
    `last_attempted_at: ${lastAttemptedAt}`,
    `last_successful_at: ${lastSuccessfulAt || 'never'}`,
    `last_updated: ${lastAttemptedAt}`,
    'freshness: 0',
    'confidence: HARD',
    `cycle_count: ${cycleCount}`,
    `total_contacts: ${totalContacts}`,
    `total_pending: ${totalPending}`,
    `total_enriched: ${orgs.reduce((s, o) => s + (o.hasEnrichment ?? 0), 0)}`,
    `errors_24h: ${errors24h}`,
    `last_enriched_at: ${lastEnrichedAt || 'never'}`,
    `daemon_idle_hours: ${daemonIdleHours != null ? daemonIdleHours.toFixed(2) : 'null'}`,
    `tenant_count: ${orgs.length}`,
    '---',
    '',
    '# Enrichment',
    '',
    `> Run ${cycleCount} — ${lastAttemptedAt}. Regime: **${regime}**.`,
    '',
    '## Scorebord per tenant',
    '',
    '| Tenant | Total | Enriched | Pending | New |',
    '|--------|-------|----------|---------|-----|',
    orgsRows,
    '',
    '## Pipeline-totalen',
    '',
    `- Total contacts: **${totalContacts}**`,
    `- Total pending: **${totalPending}** (${pct(totalPending, totalContacts)}%)`,
    `- Errors laatste 24h: **${errors24h}**`,
    `- Laatst verrijkt: **${lastEnrichedAt || '—'}** (${daemonIdleHours != null ? daemonIdleHours.toFixed(1) + 'u idle' : 'idle onbekend'})`,
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
    `Bron: \`GET ${CTRL_URL}/api/v1/enrichment/status\` met Bearer CTRL_ENGINE_API_TOKEN. Aggregeert per-org counters (total, new, hasEnrichment, pendingEnrichment) over alle tenants. Cadence 06:00Z dagelijks via Vercel cron.`,
    `Regime-rules: PIPELINE_BLOCKED = endpoint dood / errors24h>${ERRORS_BLOCKED} / daemon>${DAEMON_IDLE_BLOCKED_H}u idle. PIPELINE_BACKLOG = pending≥${BACKLOG_THRESHOLD} / daemon>${DAEMON_IDLE_BACKLOG_H}u idle / errors>${ERRORS_ATTENTION}. Anders PIPELINE_HEALTHY.`,
    hardErrors.length ? `\n> errors: ${hardErrors.join(' | ')}` : '',
  ].filter(l => l !== '').join('\n');
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const lastAttemptedAt = new Date().toISOString();
  const token = process.env.CTRL_ENGINE_API_TOKEN || process.env.CRON_SECRET;
  if (!token) return res.status(500).json({ error: 'CTRL_ENGINE_API_TOKEN/CRON_SECRET ontbreekt' });

  let cycleCount = 1;
  let prevSha = null;
  let lastSuccessfulAt = null;
  try {
    const prev = await loadPreviousMarkdown();
    if (prev) {
      prevSha = prev.sha;
      cycleCount = readCycleCountFromMd(prev.content) + 1;
      const m = prev.content.match(/^last_successful_at:\s*(.+)$/m);
      if (m && m[1].trim() !== 'never') lastSuccessfulAt = m[1].trim();
    }
  } catch (_) { /* first run */ }

  const hardErrors = [];
  let data = null;
  try {
    data = await fetchEnrichmentStatus(token);
  } catch (e) {
    hardErrors.push(`status_endpoint: ${e.message}`);
  }

  const orgs = data?.orgs || [];
  const totalContacts = orgs.reduce((s, o) => s + (o.total ?? 0), 0);
  const totalPending = orgs.reduce((s, o) => s + (o.pendingEnrichment ?? 0), 0);
  const errors24h = data?.errors24h ?? 0;
  const lastEnrichedAt = data?.lastEnrichedAt || null;
  const daemonIdleHours = hoursAgo(lastEnrichedAt);

  const regime = classifyRegime({ totalPending, errors24h, daemonIdleHours, hardErrors });

  const newLastSuccessfulAt = hardErrors.length === 0 ? lastAttemptedAt : lastSuccessfulAt;

  const md = buildMarkdown({
    cycleCount,
    lastAttemptedAt,
    lastSuccessfulAt: newLastSuccessfulAt,
    regime,
    orgs,
    totalPending,
    totalContacts,
    errors24h,
    lastEnrichedAt,
    daemonIdleHours,
    hardErrors,
  });

  let written = false;
  try {
    written = await writeToWiki(md, prevSha);
  } catch (e) {
    hardErrors.push(`wiki_write: ${e.message}`);
  }

  return res.status(200).json({
    ok: hardErrors.length === 0,
    regime,
    cycleCount,
    totalContacts,
    totalPending,
    errors24h,
    daemonIdleHours,
    tenants: orgs.length,
    written,
    errors: hardErrors,
    timestamp: lastAttemptedAt,
  });
}
