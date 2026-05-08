// Research-inbox — receives Resend Inbound webhooks for *@press.me and
// commits each mail as a claim file in the wiki under research/{user}/claims/.
//
// Routing:
//   to: mathijs@press.me → research/mathijs/claims/
//   to: tara@press.me    → research/tara/claims/
//   anything else        → 400 (whitelist; fase 1 = mathijs, tara only)
//
// Security: HMAC-SHA256 of raw body with RESEND_WEBHOOK_SECRET, presented
// in header `resend-signature`. bodyParser MUST be disabled so the raw
// bytes can be hashed before JSON.parse.
//
// Attachments are not processed in fase 1 — filenames are recorded in the
// claim body, content is dropped.

import crypto from 'node:crypto';

export const config = { api: { bodyParser: false } };

const ALLOWED_USERS = new Set(['mathijs', 'tara']);
const PROJECT_TAGS = ['NEST', 'CORTEX', 'AF', 'SKYLD'];

async function readRawBody(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks);
}

function verifySignature(rawBody, header, secret) {
  if (!header || !secret) return false;
  const expected = crypto
    .createHmac('sha256', secret)
    .update(rawBody)
    .digest('hex');
  // Header may be "sha256=<hex>" or just "<hex>".
  const provided = String(header).replace(/^sha256=/, '').trim();
  if (provided.length !== expected.length) return false;
  try {
    return crypto.timingSafeEqual(
      Buffer.from(provided, 'hex'),
      Buffer.from(expected, 'hex'),
    );
  } catch (e) {
    return false;
  }
}

function slugify(s) {
  return String(s || 'untitled')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'untitled';
}

function detectProjectTag(subject) {
  if (!subject) return null;
  const m = String(subject).match(/^\s*\[([A-Z]+)\]/);
  if (!m) return null;
  return PROJECT_TAGS.includes(m[1]) ? m[1] : null;
}

function parseToAddress(raw) {
  if (!raw) return null;
  const s = String(raw);
  // Handles "Name <user@press.me>" or "user@press.me"
  const m = s.match(/<([^>]+)>/) || s.match(/([^\s,;]+@[^\s,;]+)/);
  return m ? m[1].toLowerCase().trim() : s.toLowerCase().trim();
}

function userFromTo(toAddr) {
  if (!toAddr) return null;
  const m = toAddr.match(/^([^@]+)@press\.me$/);
  if (!m) return null;
  const local = m[1].toLowerCase();
  return ALLOWED_USERS.has(local) ? local : null;
}

function frontmatterEscape(s) {
  if (s == null) return '';
  return String(s).replace(/"/g, '\\"').replace(/\n/g, ' ').slice(0, 500);
}

function buildClaimMarkdown({ id, receivedAt, sender, subject, projectTag, text, attachments }) {
  const fm = [
    '---',
    `id: ${id}`,
    'source: email',
    `received_at: ${receivedAt}`,
    `sender: "${frontmatterEscape(sender)}"`,
    `subject: "${frontmatterEscape(subject)}"`,
    `project_tag: ${projectTag || 'null'}`,
    'status: raw',
    '---',
    '',
  ].join('\n');

  const body = [
    `# ${subject || '(no subject)'}`,
    '',
    text ? text.trim() : '_(no text body)_',
  ];

  if (Array.isArray(attachments) && attachments.length) {
    body.push('', '## Attachments', '');
    for (const a of attachments) {
      const name = (a && (a.filename || a.name)) || '(unnamed)';
      const type = (a && (a.contentType || a.content_type)) || '';
      body.push(`- ${name}${type ? ` (${type})` : ''}`);
    }
    body.push('', '_Attachments not processed in fase 1; only filenames recorded._');
  }

  return fm + body.join('\n') + '\n';
}

async function commitToWiki({ pat, filePath, content, message }) {
  const baseUrl = 'https://api.github.com/repos/nestfriesland-ctrl/wiki';
  const headers = {
    'Authorization': `token ${pat}`,
    'Accept': 'application/vnd.github.v3+json',
    'Content-Type': 'application/json',
    'User-Agent': 'pulse-research-inbox',
  };

  // GET to detect collisions (extremely unlikely with timestamp-prefixed slugs).
  const getRes = await fetch(`${baseUrl}/contents/${filePath}?ref=main`, {
    headers: { ...headers, 'Content-Type': undefined },
  });
  let sha = null;
  if (getRes.ok) {
    const data = await getRes.json();
    sha = data.sha || null;
  } else if (getRes.status !== 404) {
    const err = await getRes.text();
    throw new Error(`GET ${filePath} failed (${getRes.status}): ${err.slice(0, 160)}`);
  }

  const putBody = {
    message,
    content: Buffer.from(content, 'utf-8').toString('base64'),
    branch: 'main',
  };
  if (sha) putBody.sha = sha;

  const putRes = await fetch(`${baseUrl}/contents/${filePath}`, {
    method: 'PUT',
    headers,
    body: JSON.stringify(putBody),
  });
  if (!putRes.ok) {
    const err = await putRes.text();
    throw new Error(`PUT ${filePath} failed (${putRes.status}): ${err.slice(0, 160)}`);
  }
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'POST only' });
  }

  const PAT = process.env.GITHUB_PAT;
  const SECRET = process.env.RESEND_WEBHOOK_SECRET;
  if (!PAT) return res.status(500).json({ error: 'GITHUB_PAT not configured' });
  if (!SECRET) return res.status(500).json({ error: 'RESEND_WEBHOOK_SECRET not configured' });

  let raw;
  try {
    raw = await readRawBody(req);
  } catch (e) {
    return res.status(400).json({ error: 'failed to read body' });
  }

  const sigHeader = req.headers['resend-signature'] || req.headers['Resend-Signature'];
  if (!verifySignature(raw, sigHeader, SECRET)) {
    return res.status(401).json({ error: 'invalid signature' });
  }

  let payload;
  try {
    payload = JSON.parse(raw.toString('utf-8'));
  } catch (e) {
    return res.status(400).json({ error: 'invalid JSON body' });
  }

  // Resend Inbound payload shape varies — try common locations.
  const data = payload.data || payload;
  const toRaw = data.to || data.to_address || (Array.isArray(data.recipients) ? data.recipients[0] : null);
  const toAddr = parseToAddress(Array.isArray(toRaw) ? toRaw[0] : toRaw);
  const user = userFromTo(toAddr);
  if (!user) {
    return res.status(400).json({ error: `unknown recipient: ${toAddr || '(missing)'}` });
  }

  const fromRaw = data.from || data.sender || '';
  const sender = parseToAddress(Array.isArray(fromRaw) ? fromRaw[0] : fromRaw) || String(fromRaw);
  const subject = data.subject || '';
  const text = data.text || data.body_text || data.plain || '';
  const attachments = data.attachments || data.attachment_list || [];
  const receivedAtRaw = data.received_at || data.created_at || new Date().toISOString();
  const receivedAt = (() => {
    const d = new Date(receivedAtRaw);
    return isNaN(d.getTime()) ? new Date().toISOString() : d.toISOString();
  })();

  const date = receivedAt.slice(0, 10); // YYYY-MM-DD
  const compactTs = receivedAt.replace(/[-:]/g, '').replace(/\.\d+/, '').replace('T', '-').slice(0, 15);
  const slug = slugify(subject);
  const id = `${compactTs}-${slug}`;
  const projectTag = detectProjectTag(subject);

  const content = buildClaimMarkdown({
    id, receivedAt, sender, subject, projectTag, text, attachments,
  });
  const filePath = `research/${user}/claims/${date}-${slug}.md`;

  try {
    await commitToWiki({
      pat: PAT,
      filePath,
      content,
      message: `research(${user}): claim ${date}-${slug}`,
    });
  } catch (e) {
    return res.status(502).json({ error: String(e.message || e).slice(0, 240) });
  }

  return res.status(200).json({
    committed: true,
    user,
    path: filePath,
    project_tag: projectTag,
  });
}
