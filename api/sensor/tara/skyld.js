/**
 * POST /api/sensor/tara/skyld
 *
 * SKYLD-sensor — operationele status van het ctrl-engine CRM (app.skyld.nl)
 * voor de SKYLD-tenant. Wordt gerendered op tara.puls.frl.
 *
 * Bronnen (alle achter CRON_SECRET):
 *   - GET  /api/v1/enrichment/status      → per-org enrichment counts
 *   - POST /api/v1/skill action=list      → contacts (filter op status)
 *   - POST /api/v1/skill action=list_invoices → open facturen
 *   - POST /api/v1/skill action=list_tasks    → open taken
 *
 * Cadence: dagelijks 07:00Z.
 *
 * Schrijft naar wiki/sensors/tara/skyld.md (let op: tara/ prefix — namespace
 * voor tara.puls.frl tenant).
 *
 * Regime:
 *   OPS_HEALTHY  — geen blocker, geen kritieke backlog
 *   OPS_ATTENTION — backlog groeit / enrichment errors / overdue facturen
 *   OPS_BLOCKED   — enrichment status endpoint down of >100 24h errors
 */

const WIKI_REPO = 'nestfriesland-ctrl/wiki';
const SENSOR_PATH = 'sensors/tara/skyld.md';

const CTRL_URL = 'https://app.skyld.nl';
const SKYLD_ORG_ID = 'org_3A263ugZ3zIyALeLPzjHM8WSn8p';

// ── Field caps ──────────────────────────────────────────────
const CAP_KOP = 90;
const CAP_STELLING = 240;
const CAP_BEWIJS = 140;
const CAP_LES = 140;
const CAP_ACTIE = 140;

// ── ctrl-engine fetchers ────────────────────────────────────
async function ctrlGet(path, cronSecret) {
  const r = await fetch(`${CTRL_URL}${path}`, {
    headers: { Authorization: `Bearer ${cronSecret}` },
  });
  if (!r.ok) throw new Error(`ctrl_${path}_${r.status}`);
  return r.json();
}

async function ctrlSkill(action, params, cronSecret) {
  const r = await fetch(`${CTRL_URL}/api/v1/skill`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${cronSecret}`,
      'X-Org-Id': SKYLD_ORG_ID,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ action, params }),
  });
  if (!r.ok) throw new Error(`skill_${action}_${r.status}`);
  return r.json();
}

async function fetchEnrichmentStatus(cronSecret) {
  const data = await ctrlGet('/api/v1/enrichment/status', cronSecret);
  const skyld = (data.orgs || []).find(o => o.orgId === SKYLD_ORG_ID) || null;
  return {
    skyld,
    errors24h: data.errors24h ?? 0,
    lastEnrichedAt: data.lastEnrichedAt ?? null,
  };
}

async function fetchOpenInvoices(cronSecret) {
  // list_invoices accepts no status filter param universally — fetch top N and
  // count locally. Status enum includes VERZONDEN/BETAALD/CONCEPT/VERVALLEN.
  const data = await ctrlSkill('list_invoices', { limit: 100 }, cronSecret);
  const invoices = data?.result?.invoices || [];
  const total = data?.result?.total ?? invoices.length;
  let open = 0;
  let overdue = 0;
  const now = Date.now();
  for (const inv of invoices) {
    if (inv.status === 'BETAALD') continue;
    if (inv.status === 'CONCEPT') continue;
    if (inv.status === 'VOID' || inv.status === 'GEANNULEERD') continue;
    open += 1;
    const due = inv.dueDate ? Date.parse(inv.dueDate) : null;
    if (due && due < now && !inv.paidAt) overdue += 1;
  }
  return { open, overdue, totalReturned: invoices.length, totalReported: total };
}

async function fetchOpenTasks(cronSecret) {
  const data = await ctrlSkill('list_tasks', { limit: 100 }, cronSecret);
  const tasks = data?.result?.tasks || [];
  const open = tasks.filter(t => t.status === 'open').length;
  const urgent = tasks.filter(t => t.status === 'open' && t.priority === 'urgent').length;
  return { open, urgent };
}

async function fetchEngagedCount(cronSecret) {
  const data = await ctrlSkill('list', { status: 'ENGAGED', limit: 200 }, cronSecret);
  return data?.result?.count ?? (data?.result?.contacts?.length ?? 0);
}

// ── Regime classification ───────────────────────────────────
function classifyRegime({ enrichment, invoices, tasks, errors24h, hardErrors }) {
  if (hardErrors.length >= 3) return 'OPS_BLOCKED';
  if (errors24h > 100) return 'OPS_BLOCKED';
  if (!enrichment.skyld) return 'OPS_BLOCKED';

  const pending = enrichment.skyld.pendingEnrichment ?? 0;
  const total = enrichment.skyld.total ?? 1;
  const pendingRatio = pending / total;

  const attentionFlags = [
    errors24h > 10,
    pendingRatio > 0.6,
    (invoices?.overdue ?? 0) > 5,
    (tasks?.urgent ?? 0) > 3,
    hardErrors.length >= 1,
  ].filter(Boolean).length;

  if (attentionFlags >= 1) return 'OPS_ATTENTION';
  return 'OPS_HEALTHY';
}

// ── Wiki I/O (mirrors macro-regime pattern) ─────────────────
async function loadPreviousMarkdown() {
  const PAT = process.env.GITHUB_PAT;
  if (!PAT) return null;
  const r = await fetch(`https://api.github.com/repos/${WIKI_REPO}/contents/${SENSOR_PATH}?ref=main`, {
    headers: { Authorization: `token ${PAT}`, Accept: 'application/vnd.github+json', 'User-Agent': 'pulse-skyld' },
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
    message: `sensor(tara/skyld): ${new Date().toISOString().slice(0, 16)} dispatch`,
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
      'User-Agent': 'pulse-skyld',
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

// ── Markdown builder ────────────────────────────────────────
function cap(s, n) {
  if (s == null) return '';
  return s.length <= n ? s : s.slice(0, n - 1) + '…';
}

function buildKrant({ regime, enrichment, invoices, tasks, errors24h }) {
  const skyld = enrichment.skyld;
  const pending = skyld?.pendingEnrichment ?? 0;
  const total = skyld?.total ?? 0;
  const enriched = skyld?.hasEnrichment ?? 0;

  const verb = regime === 'OPS_HEALTHY' ? 'draait' : regime === 'OPS_ATTENTION' ? 'piept' : 'stokt';
  const kop = cap(
    `SKYLD ${verb} — ${enriched}/${total} verrijkt, ${pending} pending, ${invoices?.open ?? 0} open facturen.`,
    CAP_KOP,
  );

  const stelling = cap(
    regime === 'OPS_BLOCKED'
      ? `Operationele blocker actief: enrichment status onbereikbaar of >100 errors/24u. Pipeline staat.`
      : regime === 'OPS_ATTENTION'
        ? `Ops onder druk: pending ${pending}, errors24h ${errors24h}, urgent taken ${tasks?.urgent ?? 0}. Backlog groeit als geen aandacht binnen 24u.`
        : `Ops gezond: pending ${pending}/${total}, errors24h ${errors24h}, open facturen ${invoices?.open ?? 0}, urgent taken ${tasks?.urgent ?? 0}. Geen actie nodig vandaag.`,
    CAP_STELLING,
  );

  const bewijs = cap(
    `Pending ${pending} | Verrijkt ${enriched} | Errors24h ${errors24h} | Open fact ${invoices?.open ?? 0} (${invoices?.overdue ?? 0} overdue) | Open taken ${tasks?.open ?? 0} (${tasks?.urgent ?? 0} urgent).`,
    CAP_BEWIJS,
  );

  const les = cap(
    regime === 'OPS_BLOCKED'
      ? 'Blocker eerst, dan backlog. Geen nieuwe import tot enrichment daemon weer status rapporteert.'
      : regime === 'OPS_ATTENTION'
        ? 'Backlog inlopen vóór nieuwe import. Urgent taken hebben menselijke beslissing nodig — niet wegduwen.'
        : 'Healthy ops = unnoticed ops. Geen interventie nodig; alleen monitoren.',
    CAP_LES,
  );

  const actie = cap(
    regime === 'OPS_BLOCKED'
      ? 'Check enrichment daemon + ctrl-engine /api/v1/health. Pas restart na root cause.'
      : regime === 'OPS_ATTENTION'
        ? `Inboard urgent taken (${tasks?.urgent ?? 0}). Bel overdue facturen (${invoices?.overdue ?? 0}). Pause new imports.`
        : 'Geen actie. Volgende cyclus 07:00Z.',
    CAP_ACTIE,
  );

  return { kop, stelling, bewijs, les, actie };
}

function buildMarkdown({
  cycleCount, lastAttemptedAt, lastSuccessfulAt,
  regime, enrichment, invoices, tasks, errors24h, hardErrors,
}) {
  const krant = buildKrant({ regime, enrichment, invoices, tasks, errors24h });
  const skyld = enrichment.skyld || {};

  return [
    '---',
    'sensor: skyld',
    `regime: ${regime}`,
    `last_attempted_at: ${lastAttemptedAt}`,
    `last_successful_at: ${lastSuccessfulAt || 'never'}`,
    `last_updated: ${lastAttemptedAt}`,
    'freshness: 0',
    'confidence: HARD',
    `cycle_count: ${cycleCount}`,
    `contacts_total: ${skyld.total ?? 0}`,
    `contacts_new: ${skyld.new ?? 0}`,
    `contacts_enriched: ${skyld.enriched ?? 0}`,
    `enrichment_done: ${skyld.hasEnrichment ?? 0}`,
    `enrichment_pending: ${skyld.pendingEnrichment ?? 0}`,
    `enrichment_errors_24h: ${errors24h}`,
    `last_enriched_at: ${enrichment.lastEnrichedAt || 'never'}`,
    `invoices_open: ${invoices?.open ?? 0}`,
    `invoices_overdue: ${invoices?.overdue ?? 0}`,
    `tasks_open: ${tasks?.open ?? 0}`,
    `tasks_urgent: ${tasks?.urgent ?? 0}`,
    '---',
    '',
    '# SKYLD',
    '',
    `> Run ${cycleCount} — ${lastAttemptedAt}. Regime: **${regime}**.`,
    '',
    '## Scorebord',
    '',
    '| Variabele | Waarde | Niveau |',
    '|-----------|--------|--------|',
    `| Contacts (SKYLD) | ${skyld.total ?? 0} | totaal in pool |`,
    `| Enriched | ${skyld.hasEnrichment ?? 0} | ${pct(skyld.hasEnrichment, skyld.total)}% van totaal |`,
    `| Pending enrichment | ${skyld.pendingEnrichment ?? 0} | ${pct(skyld.pendingEnrichment, skyld.total)}% van totaal |`,
    `| Enrichment errors (24h) | ${errors24h} | ${errors24h > 100 ? 'BLOCKED' : errors24h > 10 ? 'attention' : 'gezond'} |`,
    `| Open facturen | ${invoices?.open ?? 0} | ${invoices?.overdue ?? 0} overdue |`,
    `| Open taken | ${tasks?.open ?? 0} | ${tasks?.urgent ?? 0} urgent |`,
    `| Laatst verrijkt | ${enrichment.lastEnrichedAt || '—'} | timestamp |`,
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
    `Bronnen: ctrl-engine API op ${CTRL_URL}. Endpoints: GET /api/v1/enrichment/status (per-org pipeline counts), POST /api/v1/skill action=list_invoices + list_tasks + list. Auth: Bearer CRON_SECRET + X-Org-Id ${SKYLD_ORG_ID}. Cadence dagelijks 07:00Z.`,
    `Regime-rules: OPS_BLOCKED = >100 errors/24h, status-endpoint dood, of ≥3 hard errors. OPS_ATTENTION = pending>60% van totaal, errors>10, overdue>5, urgent taken>3, of 1+ hard error. Anders OPS_HEALTHY.`,
    hardErrors.length ? `\n> errors: ${hardErrors.join(' | ')}` : '',
  ].filter(l => l !== '').join('\n');
}

function pct(n, d) {
  if (!d) return '0';
  return ((n / d) * 100).toFixed(1);
}

// ── Main handler ────────────────────────────────────────────
export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const lastAttemptedAt = new Date().toISOString();
  const cronSecret = process.env.CRON_SECRET || 'skyld-cron-x7k9m2p4q8';

  // Cycle count from prior MD
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

  const hardErrors = [];
  const safe = async (label, p) => {
    try { return await p; }
    catch (e) { hardErrors.push(`${label}:${e.message}`); return null; }
  };

  const [enrichment, invoices, tasks] = await Promise.all([
    safe('enrichment', fetchEnrichmentStatus(cronSecret)),
    safe('invoices', fetchOpenInvoices(cronSecret)),
    safe('tasks', fetchOpenTasks(cronSecret)),
  ]);

  const enr = enrichment || { skyld: null, errors24h: 0, lastEnrichedAt: null };
  const inv = invoices || { open: 0, overdue: 0 };
  const tsk = tasks || { open: 0, urgent: 0 };
  const errors24h = enr.errors24h ?? 0;

  const regime = classifyRegime({
    enrichment: enr, invoices: inv, tasks: tsk, errors24h, hardErrors,
  });

  const successAt = regime === 'OPS_BLOCKED' ? lastSuccessfulAt : new Date().toISOString();
  const md = buildMarkdown({
    cycleCount, lastAttemptedAt, lastSuccessfulAt: successAt,
    regime, enrichment: enr, invoices: inv, tasks: tsk, errors24h, hardErrors,
  });

  const written = await writeToWiki(md, prevSha).catch(() => false);

  return res.status(200).json({
    regime, cycleCount, written, errors: hardErrors,
    snapshot: {
      enrichment: enr.skyld,
      errors24h,
      invoices: inv,
      tasks: tsk,
    },
    trigger: req.body?.trigger || 'manual',
  });
}
