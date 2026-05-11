// Anti-fragile katern — falsificatie-tracker, geen sentiment.
//
// Bronnen: wiki/sensors/anti-fragile.md (cycle digest, axiom verdicts) +
// wiki/sensors/hyblock-research-cycle.md (frontmatter met paper-trade counts,
// open paper trades blok).
//
// Vier secties:
//   1. ACTIEVE FALSIFIEERBARE STELLING — per open paper-trade. Empty-state
//      als geen trade.
//   2. AXIOMA-STAAT — tabel per axioma met verdict + N-progressie totalen.
//   3. FALSIFIED ARCHIEF — laatste 5 REFUTED-verdicts uit huidige cycle.
//   4. META — anti-fragile + hyblock-research frontmatter (regime, cycle,
//      last-update).
//
// Styling: mosterd-bruin accent --dk-accent (#5a4a2a), hergebruik dk-katern.

(function () {
  function escape(s) {
    if (s === null || s === undefined) return '';
    const u = window.PulseUtil;
    return u && u.escape ? u.escape(String(s)) : String(s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  // Parse `> key: value` en `key: value` (YAML) frontmatter regels.
  function parseFrontmatter(md) {
    const out = {};
    if (!md) return out;
    const yaml = md.match(/^---\r?\n([\s\S]*?)\r?\n---/);
    if (yaml) {
      for (const line of yaml[1].split(/\r?\n/)) {
        const m = line.match(/^([a-zA-Z_][a-zA-Z0-9_]*)\s*:\s*(.+)$/);
        if (m) out[m[1]] = m[2].trim();
      }
    }
    for (const line of md.split('\n').slice(0, 60)) {
      const m = line.match(/^>\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*:\s*(.+)$/);
      if (m && !(m[1] in out)) out[m[1]] = m[2].trim();
    }
    return out;
  }

  // Open paper trades blok uit hyblock-research-cycle.md.
  // Verwacht format: "- **T-001 BTC LONG @ $78,608** | now $80,944 (+2,97%) | SL $79,500 / TP1 $82,900 | HOLD, ..."
  function parseOpenTrades(md) {
    if (!md) return [];
    const m = md.match(/##\s*Open paper trades\s*\n([\s\S]*?)(?=\n##|\n#|$)/i);
    if (!m) return [];
    const out = [];
    const lines = m[1].split('\n').map(l => l.trim()).filter(l => l.startsWith('-'));
    for (const line of lines) {
      const body = line.replace(/^-\s*/, '').trim();
      const parts = body.split('|').map(s => s.trim());
      const head = parts[0] || '';
      const idMatch = head.match(/\*\*\s*(T-\d+)\s+([A-Z]{2,6})\s+(LONG|SHORT)\s*@?\s*\$?([\d.,]+)\s*\*\*/);
      const trade = {
        raw: body,
        id: idMatch ? idMatch[1] : null,
        asset: idMatch ? idMatch[2] : null,
        direction: idMatch ? idMatch[3] : null,
        entry: idMatch ? idMatch[4] : null,
        now: null,
        sl: null,
        tp: null,
        status: null,
        trigger: null,
      };
      for (const p of parts.slice(1)) {
        const nowM = p.match(/now\s+\$?([\d.,]+)\s*(\([^)]+\))?/i);
        if (nowM) { trade.now = nowM[1]; trade.nowPct = nowM[2] || ''; continue; }
        const slM = p.match(/SL\s+\$?([\d.,]+)(?:\s*\/\s*TP1?\s+\$?([\d.,]+))?/i);
        if (slM) { trade.sl = slM[1]; trade.tp = slM[2] || null; continue; }
        // Status zin: alles na het laatste pipe wat geen now/SL is.
        if (!trade.status) trade.status = p;
        else trade.trigger = p;
      }
      // Falsificatie: SL-cross is de directe falsifier.
      if (trade.direction === 'LONG' && trade.sl) {
        trade.falsifier = `${trade.asset} ≤ $${trade.sl} (SL-cross)`;
      } else if (trade.direction === 'SHORT' && trade.sl) {
        trade.falsifier = `${trade.asset} ≥ $${trade.sl} (SL-cross)`;
      } else {
        trade.falsifier = null;
      }
      out.push(trade);
    }
    return out;
  }

  // Axiom verdicts uit anti-fragile.md. Format:
  // "- **#64 BTC retail-trap PROVEN-LATE-FINAL**: bewijs-tekst."
  function parseAxiomVerdicts(md) {
    if (!md) return [];
    const m = md.match(/##\s*Axiom verdicts[^\n]*\n([\s\S]*?)(?=\n##|\n#|$)/i);
    if (!m) return [];
    const out = [];
    const lines = m[1].split('\n').map(l => l.trim()).filter(l => l.startsWith('-'));
    for (const line of lines) {
      const hdr = line.match(/^-\s*\*\*\s*#(\d+)\s+([^*]+?)\s*\*\*\s*:?\s*(.*)$/);
      if (!hdr) continue;
      const id = hdr[1];
      const title = hdr[2].trim();
      const evidence = hdr[3].trim();
      // Verdict-tag uit titel: PROVEN | REFUTED | REFUTING | PROVEN-LATE | PROVEN-EARLY enz.
      let status = 'UNKNOWN';
      const tagMatch = title.match(/(REFUTED|REFUTING|PROVEN-LATE|PROVEN-EARLY|PROVEN)/);
      if (tagMatch) {
        const t = tagMatch[1];
        if (/REFUT/.test(t)) status = 'REFUTED';
        else status = 'PROVEN';
      }
      out.push({ id, title, status, evidence });
    }
    return out;
  }

  // New candidates uit anti-fragile.md — kandidaten zonder verdict yet.
  function parseNewCandidates(md) {
    if (!md) return [];
    const m = md.match(/##\s*New candidates[^\n]*\n([\s\S]*?)(?=\n##|\n#|$)/i);
    if (!m) return [];
    const out = [];
    const lines = m[1].split('\n').map(l => l.trim()).filter(l => l.startsWith('-'));
    for (const line of lines) {
      const hdr = line.match(/^-\s*\*\*\s*#(\d+)\s+([^*]+?)\s*\*\*\s*:?\s*(.*)$/);
      if (!hdr) continue;
      out.push({ id: hdr[1], title: hdr[2].trim(), hypothesis: hdr[3].trim() });
    }
    return out;
  }

  function parse({ antiFragileContent, hyblockContent }) {
    const af = antiFragileContent || null;
    const hb = hyblockContent || null;
    return {
      antiFragile: af ? {
        content: af,
        fm: parseFrontmatter(af),
        verdicts: parseAxiomVerdicts(af),
        candidates: parseNewCandidates(af),
      } : null,
      hyblock: hb ? {
        content: hb,
        fm: parseFrontmatter(hb),
        trades: parseOpenTrades(hb),
      } : null,
    };
  }

  function renderStellingSectie(data) {
    const trades = (data.hyblock && data.hyblock.trades) || [];
    if (!trades.length) {
      // Empty-state: laatst-geleerde refuted axioma als context.
      const verdicts = (data.antiFragile && data.antiFragile.verdicts) || [];
      const lastRefuted = verdicts.filter(v => v.status === 'REFUTED').slice(-1)[0];
      const refutedNote = lastRefuted
        ? `Laatst gerefuted: <strong>#${escape(lastRefuted.id)}</strong> — ${escape(lastRefuted.title)}.`
        : 'Geen recente REFUTED-verdicts.';
      return `
        <section class="dk-bucket af-stelling">
          <h2>ACTIEVE FALSIFIEERBARE STELLING</h2>
          <div class="dk-card af-empty">
            <p class="dk-detail"><em>Geen open paper-trade.</em> ${refutedNote}</p>
          </div>
        </section>
      `;
    }
    const cards = trades.map(t => {
      const idLabel = t.id ? `${escape(t.id)} · ` : '';
      const headline = (t.asset && t.direction)
        ? `${idLabel}${escape(t.asset)} ${escape(t.direction)}`
        : `${idLabel}${escape(t.raw.slice(0, 80))}`;
      const sub = t.entry ? `entry $${escape(t.entry)}${t.now ? ` · now $${escape(t.now)} ${escape(t.nowPct || '')}` : ''}` : '';
      const falsRow = t.falsifier
        ? `<div class="af-row"><span class="af-label">Falsificatie</span><span>${escape(t.falsifier)}</span></div>`
        : '';
      const slRow = t.sl
        ? `<div class="af-row"><span class="af-label">SL / TP</span><span>$${escape(t.sl)}${t.tp ? ` / $${escape(t.tp)}` : ''}</span></div>`
        : '';
      const statusRow = t.status
        ? `<div class="af-row"><span class="af-label">Status</span><span>${escape(t.status)}</span></div>`
        : '';
      return `
        <article class="dk-card dk-card-semantic">
          <header class="dk-card-head"><span class="dk-sensor">${headline}</span><span class="dk-type">paper-trade</span></header>
          ${sub ? `<p class="dk-detail">${sub}</p>` : ''}
          <div class="af-rows">${falsRow}${slRow}${statusRow}</div>
        </article>
      `;
    }).join('');
    return `
      <section class="dk-bucket af-stelling">
        <h2>ACTIEVE FALSIFIEERBARE STELLING (${trades.length})</h2>
        <div class="dk-list">${cards}</div>
      </section>
    `;
  }

  function renderAxiomaStaat(data) {
    const verdicts = (data.antiFragile && data.antiFragile.verdicts) || [];
    const candidates = (data.antiFragile && data.antiFragile.candidates) || [];
    const fm = (data.hyblock && data.hyblock.fm) || {};
    const totalProven = fm.axioma_n_proven || '—';
    const totalRefuted = fm.axioma_n_refuted || '—';

    if (!verdicts.length && !candidates.length) {
      return `
        <section class="dk-bucket af-axioma">
          <h2>AXIOMA-STAAT</h2>
          <p class="dim">Geen axiom-verdicts in huidige cycle.</p>
        </section>
      `;
    }

    const rows = [
      ...verdicts.map(v => ({ id: v.id, title: v.title, status: v.status })),
      ...candidates.map(c => ({ id: c.id, title: c.title, status: 'UNKNOWN' })),
    ].sort((a, b) => parseInt(a.id, 10) - parseInt(b.id, 10));

    const tbody = rows.map(r => `
      <tr>
        <td>#${escape(r.id)}</td>
        <td>${escape(r.title)}</td>
        <td class="af-status af-status-${r.status.toLowerCase()}">${escape(r.status)}</td>
      </tr>
    `).join('');

    return `
      <section class="dk-bucket af-axioma">
        <h2>AXIOMA-STAAT — cycle (proven ${escape(totalProven)} · refuted ${escape(totalRefuted)})</h2>
        <table class="af-table">
          <thead><tr><th>ID</th><th>Hypothese</th><th>Status</th></tr></thead>
          <tbody>${tbody}</tbody>
        </table>
      </section>
    `;
  }

  function renderFalsifiedArchief(data) {
    const verdicts = (data.antiFragile && data.antiFragile.verdicts) || [];
    const refuted = verdicts.filter(v => v.status === 'REFUTED').slice(-5).reverse();
    if (!refuted.length) {
      return `
        <section class="dk-bucket af-falsified">
          <h2>FALSIFIED ARCHIEF</h2>
          <p class="dim">Geen REFUTED-verdicts in huidige cycle.</p>
        </section>
      `;
    }
    const items = refuted.map(v => `
      <article class="dk-card dk-card-mechanical">
        <header class="dk-card-head"><span class="dk-sensor">#${escape(v.id)} · ${escape(v.title)}</span><span class="dk-type">REFUTED</span></header>
        ${v.evidence ? `<p class="dk-detail">${escape(v.evidence)}</p>` : ''}
      </article>
    `).join('');
    return `
      <section class="dk-bucket af-falsified">
        <h2>FALSIFIED ARCHIEF (laatste ${refuted.length})</h2>
        <div class="dk-list">${items}</div>
      </section>
    `;
  }

  function renderMeta(data) {
    const af = data.antiFragile && data.antiFragile.fm;
    const hb = data.hyblock && data.hyblock.fm;
    const row = (label, val) => val
      ? `<div class="af-meta-row"><span class="af-label">${escape(label)}</span><span>${escape(val)}</span></div>`
      : '';
    return `
      <section class="dk-bucket af-meta">
        <h2>META</h2>
        <div class="af-meta-grid">
          <div class="af-meta-col">
            <h3>anti-fragile-sensor</h3>
            ${af ? row('regime', af.regime) : ''}
            ${af ? row('data cycle', af.data_cycle) : ''}
            ${af ? row('repo cycle', af.repo_cycle) : ''}
            ${af ? row('confidence', af.confidence) : ''}
            ${af ? row('last_updated', af.last_updated) : '<p class="dim">niet beschikbaar</p>'}
          </div>
          <div class="af-meta-col">
            <h3>hyblock-research-cycle</h3>
            ${hb ? row('regime', hb.regime) : ''}
            ${hb ? row('cycle_count', hb.cycle_count) : ''}
            ${hb ? row('open paper-trades', hb.open_paper_trades) : ''}
            ${hb ? row('axioma_n_proven', hb.axioma_n_proven) : ''}
            ${hb ? row('axioma_n_refuted', hb.axioma_n_refuted) : ''}
            ${hb ? row('last_updated', hb.last_updated) : '<p class="dim">niet beschikbaar</p>'}
          </div>
        </div>
      </section>
    `;
  }

  function render({ container, data }) {
    if (!container) return;
    if (!data || (!data.antiFragile && !data.hyblock)) {
      container.innerHTML = `
        <section id="af-katern" class="dk-katern af-katern">
          <header class="dk-masthead">
            <h1>Anti-fragile</h1>
            <span class="dk-sub">falsificatie-tracker · geen sentiment</span>
          </header>
          <div class="dk-empty"><p class="dim">Bron-bestanden niet beschikbaar.</p></div>
        </section>
      `;
      return;
    }
    const cycle = (data.hyblock && data.hyblock.fm.cycle_count)
      || (data.antiFragile && data.antiFragile.fm.data_cycle)
      || '—';
    container.innerHTML = `
      <section id="af-katern" class="dk-katern af-katern">
        <header class="dk-masthead">
          <h1>Anti-fragile</h1>
          <span class="dk-sub">falsificatie-tracker · cycle ${escape(cycle)}</span>
        </header>
        ${renderStellingSectie(data)}
        ${renderAxiomaStaat(data)}
        ${renderFalsifiedArchief(data)}
        ${renderMeta(data)}
      </section>
    `;
  }

  window.PulseAntiFragileKatern = {
    parse,
    parseFrontmatter,
    parseOpenTrades,
    parseAxiomVerdicts,
    parseNewCandidates,
    render,
  };
})();
