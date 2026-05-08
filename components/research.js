// RESEARCH — voorpagina van het research-katern (press.me).
//
// Eén research-tree per user, geselecteerd via subdomain:
//   mathijs.press.me → user=mathijs
//   tara.press.me    → user=tara
//   press.me / *     → default user (mathijs in fase 1)
//
// Render:
//   lead   = meest recente open hypothese (of empty-state)
//   triple = laatste 3 log-regels (research-log.md tail)
//   strip  = laatste claim-files (filename + subject uit frontmatter)
//
// Geen state-mutatie in deze view — alle promotie/demotie van claims/
// hypotheses gebeurt in de wiki zelf (via editor of inbox-endpoint).

(function () {
  const U = () => window.PulseUtil;
  const API = '/api/wiki';

  function escape(s) { return U().escape(s); }

  function detectUser() {
    const host = (typeof window !== 'undefined' && window.location && window.location.hostname) || '';
    const m = host.match(/^([a-z0-9-]+)\.press\.me$/i);
    if (m && (m[1] === 'mathijs' || m[1] === 'tara')) return m[1];
    return 'mathijs';
  }

  async function fetchListing(path) {
    try {
      const r = await fetch(`${API}?path=${encodeURIComponent(path)}`);
      if (!r.ok) return [];
      const data = await r.json();
      return Array.isArray(data) ? data : [];
    } catch (e) { return []; }
  }

  async function fetchFile(path) {
    try {
      const r = await fetch(`${API}?path=${encodeURIComponent(path)}`);
      if (!r.ok) return null;
      const data = await r.json();
      return data.decoded_content || (data.content ? atob(data.content) : '');
    } catch (e) { return null; }
  }

  function parseFrontmatter(content) {
    if (!content) return null;
    const m = content.match(/^---\s*\n([\s\S]*?)\n---/);
    if (!m) return null;
    const fm = {};
    for (const line of m[1].split('\n')) {
      const lm = line.match(/^(\w+):\s*(.*)$/);
      if (!lm) continue;
      let v = lm[2].trim();
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
        v = v.slice(1, -1);
      }
      fm[lm[1]] = v;
    }
    return Object.keys(fm).length ? fm : null;
  }

  function stripFrontmatter(content) {
    if (!content) return '';
    const m = content.match(/^---[\s\S]*?\n---\s*\n?([\s\S]*)$/);
    return m ? m[1] : content;
  }

  async function fetchResearch(user) {
    const base = `research/${user}`;
    const [claimsListing, openListing, logRaw] = await Promise.all([
      fetchListing(`${base}/claims`),
      fetchListing(`${base}/hypotheses/open`),
      fetchFile(`${base}/log/research-log.md`),
    ]);

    const mdFile = (f) =>
      f && f.type === 'file' && f.name.endsWith('.md') && f.name !== '.gitkeep';

    const claimFiles = claimsListing.filter(mdFile)
      .sort((a, b) => b.name.localeCompare(a.name))
      .slice(0, 12);
    const openFiles = openListing.filter(mdFile)
      .sort((a, b) => b.name.localeCompare(a.name))
      .slice(0, 1);

    const claims = await Promise.all(claimFiles.map(async f => {
      const content = await fetchFile(`${base}/claims/${f.name}`);
      const fm = parseFrontmatter(content) || {};
      return {
        filename: f.name,
        subject: fm.subject || f.name.replace(/\.md$/, ''),
        sender: fm.sender || '',
        received_at: fm.received_at || '',
        project_tag: fm.project_tag && fm.project_tag !== 'null' ? fm.project_tag : null,
      };
    }));

    let leadHypothesis = null;
    if (openFiles.length) {
      const f = openFiles[0];
      const content = await fetchFile(`${base}/hypotheses/open/${f.name}`);
      const fm = parseFrontmatter(content) || {};
      leadHypothesis = {
        filename: f.name,
        falsifier: fm.falsifier || '',
        formulated: fm.formulated || '',
        body: stripFrontmatter(content || '').trim(),
      };
    }

    const logLines = (logRaw || '').split('\n')
      .map(l => l.trim())
      .filter(l => l && !l.startsWith('#') && !l.startsWith('>') && l !== '(leeg)')
      .slice(-3)
      .reverse();

    return { user, claims, leadHypothesis, logLines };
  }

  function leadHtml(user, hyp) {
    if (!hyp) {
      return `
        <section class="lead research-lead">
          <div>
            <div class="kicker neut">Research · ${escape(user)}.press.me</div>
            <h1>Geen open hypothese.</h1>
            <p class="deck">Mail iets naar ${escape(user)}@press.me. Eerste claim landt in de claims-strip; eerste hypothese verschijnt hier zodra die geformuleerd is.</p>
            <div class="lead-body">
              <p>Workflow: <code>claim → hypothese (open) → testing → validated</code>. Falsificatie verhuist een hypothese naar de necrologie. Zie <a href="#doc/research/PROTOCOL.md">PROTOCOL.md</a> en <a href="#doc/research/COMPRESSION.md">COMPRESSION.md</a>.</p>
            </div>
          </div>
          <aside>
            <div class="label">inbox</div>
            <h3>${escape(user)}@press.me</h3>
            <p>Mailen naar dit adres commit een claim-file in <code>wiki/research/${escape(user)}/claims/</code>. Subject = filename. Body = claim-content. Project-tag uit prefix [NEST]/[CORTEQ]/[AF]/[SKYLD].</p>
          </aside>
        </section>
      `;
    }
    const bodyTrimmed = hyp.body.length > 600 ? hyp.body.slice(0, 597) + '…' : hyp.body;
    return `
      <section class="lead research-lead">
        <div>
          <div class="kicker neut">Open hypothese · ${escape(user)}</div>
          <h1>${escape(hyp.filename.replace(/\.md$/, ''))}</h1>
          ${hyp.falsifier ? `<p class="deck">Falsifier: ${escape(hyp.falsifier)}</p>` : ''}
          <div class="lead-body"><p>${escape(bodyTrimmed)}</p></div>
          <a class="deep-link" href="#doc/research/${escape(user)}/hypotheses/open/${escape(hyp.filename)}">→ volledige hypothese</a>
        </div>
        <aside>
          <div class="label">stadium</div>
          <h3>open</h3>
          <p>Geformuleerd, nog geen test gestart. Volgende staat: <code>testing/</code>.</p>
          ${hyp.formulated ? `<div class="meta-row"><span>formulated</span><span>${escape(hyp.formulated)}</span></div>` : ''}
        </aside>
      </section>
    `;
  }

  function tripleHtml(logLines) {
    if (!logLines || !logLines.length) {
      return `
        <section class="triple research-triple">
          <article class="research-mini empty"><p class="dim">Log is leeg.</p></article>
          <div class="rule"></div>
          <article class="research-mini empty"></article>
          <div class="rule"></div>
          <article class="research-mini empty"></article>
        </section>
      `;
    }
    const articles = [0, 1, 2].map(i => {
      const line = logLines[i];
      if (!line) return `<article class="research-mini empty"></article>`;
      return `<article class="research-mini"><pre class="log-line">${escape(line)}</pre></article>`;
    });
    return `
      <section class="triple research-triple">
        ${articles[0]}
        <div class="rule"></div>
        ${articles[1]}
        <div class="rule"></div>
        ${articles[2]}
      </section>
    `;
  }

  function stripHtml(user, claims) {
    if (!claims || !claims.length) {
      return `
        <section class="strip research-strip">
          <div class="item">
            <div class="name">claims</div>
            <div class="v">— (geen claims; mail ${escape(user)}@press.me om de eerste te zien)</div>
          </div>
        </section>
      `;
    }
    const items = claims.slice(0, 8).map(c => {
      const tag = c.project_tag ? `<span class="tag">[${escape(c.project_tag)}]</span> ` : '';
      const path = `research/${user}/claims/${c.filename}`;
      const subj = c.subject.length > 64 ? c.subject.slice(0, 61) + '…' : c.subject;
      return `
        <div class="item">
          <div class="name">${tag}<a href="#doc/${escape(path)}">${escape(subj)}</a></div>
          <div class="v">${escape(c.received_at || c.filename)}</div>
        </div>
      `;
    }).join('');
    return `<section class="strip research-strip">${items}</section>`;
  }

  async function render({ view, def, user }) {
    if (!view || !def) return;
    const targetUser = user || detectUser();
    view.innerHTML = `
      <div class="container katern-page">
        <header class="katern-header">
          <a href="#dashboard" class="back-link">← Dashboard</a>
          <h1>${escape(def.label)} · <span class="dim">${escape(targetUser)}.press.me</span></h1>
          <div class="tagline">${escape(def.tagline)}</div>
        </header>
        <div class="loading">research laden…</div>
      </div>
    `;

    const data = await fetchResearch(targetUser);
    view.innerHTML = `
      <div class="container katern-page">
        <header class="katern-header">
          <a href="#dashboard" class="back-link">← Dashboard</a>
          <h1>${escape(def.label)} · <span class="dim">${escape(targetUser)}.press.me</span></h1>
          <div class="tagline">${escape(def.tagline)}</div>
        </header>
        ${leadHtml(targetUser, data.leadHypothesis)}
        ${tripleHtml(data.logLines)}
        ${stripHtml(targetUser, data.claims)}
      </div>
    `;
  }

  window.PulseResearch = { render, detectUser };
})();
