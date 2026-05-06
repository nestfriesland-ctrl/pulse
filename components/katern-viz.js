// KATERN-VIZ — per-katern visualisaties.
//
// Hard principe (briefing 2026-05-06): claim of niets. Een viz mag alleen
// renderen als hij een falsifieerbare claim ondersteunt. Geen decoratieve
// charts, geen placeholders die data suggereren die er niet is.
//
// MARKT:
//   - BTC 4h candlestick met entry/SL/TP-markers uit thesis-trader sensor.
//     CLAIM: T-001 entry/SL/TP-niveaus zijn visueel zichtbaar tegen prijs-actie
//     zodat de lezer ziet hoe ver T-001 van TP1 of falsificatie-zone (SL) zit.
//     FALSIFIEERBAAR: markers volgen niet thesis-trader updates.
//   - Watchlist sparkline-grid (7d per coin, kleur naar trend).
//     CLAIM: per-coin 7d-trend ondersteunt watchlist-regime-classificatie
//     (CONCENTRATED-ZEC-LEADERSHIP zou een ZEC-spark-spike moeten tonen).
//     FALSIFIEERBAAR: spark toont vlakke lijn ondanks regime-claim.
//
// MACHINEKAMER:
//   - Uptime-strip per service (30 dagen-grid uit /api/wiki?path=_history).
//     CLAIM: groene blok per dag = sensor-commit op die dag = service draaide.
//     FALSIFIEERBAAR: strip toont alleen groen ondanks bekende dood-windows.
//
// LICHAAM, RESIDU, NECROLOGIE: geen viz in PR #5 (claim-of-niets — cortex
// dood, observer-residue komt in PR #7, necrologie-aggregaat in PR #8).

(function () {
  // --- MARKT ----------------------------------------------------------

  function parseThesisMarkers(thesisContent) {
    if (!thesisContent) return null;
    const parseNumber = (s) => {
      if (!s) return null;
      // Strip $, separators (. and ,), keep digits + optional decimal.
      // Heuristiek: thesis-trader gebruikt $78.608 (NL-puntformat).
      const cleaned = s.replace(/[\$,\s]/g, '').replace(/\./g, '');
      const n = parseFloat(cleaned);
      return isNaN(n) ? null : n;
    };
    const out = {};
    let m;
    if ((m = thesisContent.match(/entry\s*\$?([\d\.,]+)/i))) out.entry = parseNumber(m[1]);
    if ((m = thesisContent.match(/TP1\s*\$?([\d\.,]+)/i)))   out.tp1   = parseNumber(m[1]);
    if ((m = thesisContent.match(/TP2\s*\$?([\d\.,]+)/i)))   out.tp2   = parseNumber(m[1]);
    if ((m = thesisContent.match(/SL\s*[^\$]{0,40}\$?([\d\.,]+)/i))) out.sl = parseNumber(m[1]);
    return Object.keys(out).length ? out : null;
  }

  async function renderMarkt({ contents }) {
    const markers = parseThesisMarkers(contents['thesis-trader']);
    if (window.PulseCharts && window.PulseCharts.initBtcChartWithMarkers) {
      await window.PulseCharts.initBtcChartWithMarkers('markt-btc-chart', markers);
    }
    const grid = document.getElementById('markt-watchlist-grid');
    if (!grid) return;
    const symbols = ['BTC', 'ETH', 'SOL', 'ZEC', 'TAO', 'HYPE', 'FET'];
    grid.innerHTML = symbols.map(s => `
      <div class="watchlist-item">
        <div class="watchlist-name">${s}</div>
        <div class="watchlist-spark" id="watchlist-spark-${s}"></div>
      </div>
    `).join('');
    if (window.PulseCharts && window.PulseCharts.initWatchlistSparkline) {
      symbols.forEach(s => window.PulseCharts.initWatchlistSparkline(`watchlist-spark-${s}`, s));
    }
  }

  // --- MACHINEKAMER ---------------------------------------------------

  async function fetchHistory(file, days) {
    try {
      const r = await fetch(`/api/wiki?path=_history&file=${encodeURIComponent(file)}&days=${days}`);
      if (!r.ok) return null;
      return await r.json();
    } catch (e) { return null; }
  }

  function buildUptimeRow(name, dates) {
    const today = new Date();
    today.setUTCHours(0, 0, 0, 0);
    const setOfDays = new Set((dates || []).map(d => String(d).slice(0, 10)));
    const blocks = [];
    for (let i = 29; i >= 0; i--) {
      const d = new Date(today.getTime() - i * 86400000);
      const iso = d.toISOString().slice(0, 10);
      const cls = setOfDays.has(iso) ? 'block fresh' : 'block stale';
      blocks.push(`<span class="${cls}" title="${iso}"></span>`);
    }
    return `
      <div class="uptime-row">
        <div class="uptime-label">${name}</div>
        <div class="uptime-blocks">${blocks.join('')}</div>
      </div>
    `;
  }

  async function renderMachinekamer({ sensors }) {
    const host = document.getElementById('machinekamer-uptime');
    if (!host) return;
    host.innerHTML = `<div class="uptime-loading">commit-historie laden…</div>`;
    const histories = await Promise.all(sensors.map(async s => ({
      name: s,
      data: await fetchHistory(`sensors/${s}.md`, 30),
    })));
    host.innerHTML = histories.map(h => {
      const dates = (h.data && Array.isArray(h.data)) ? h.data : [];
      return buildUptimeRow(h.name, dates);
    }).join('');
  }

  window.PulseKaternViz = { renderMarkt, renderMachinekamer };
})();
