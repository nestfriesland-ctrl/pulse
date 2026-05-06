// Render the thermometers grid (majors + alts, each 4 timeframes).
// Works in two phases:
//   mountThermometers(container)  -> static skeleton with empty cells
//   updateThermometers(state)     -> fill cells from live + anchors
//
// State shape:
//   { tickers: { BTC: 84210.3, ETH: 3201.2, ... },
//     anchors: { BTC: { '1h': 84000, '4h': ..., '24h': ..., '7d': ... }, ... },
//     fetchedAt: 1714976400000 }
//
// Exposed as window.Thermometers.

(function () {
  const TF_ORDER  = ['1h', '4h', '24h', '7d'];
  const TF_LABELS = { '1h': '1u', '4h': '4u', '24h': '24h', '7d': '7d' };

  function rowHtml(symbol) {
    const cells = TF_ORDER.map(tf =>
      `<div class="thermo-cell thermo-pending" data-asset="${symbol}" data-tf="${tf}">
         <div class="thermo-bar">
           <div class="thermo-bar-track"></div>
           <div class="thermo-bar-fill" style="left:50%;width:0%"></div>
           <div class="thermo-bar-mid"></div>
         </div>
         <div class="thermo-pct">…</div>
       </div>`
    ).join('');
    return `
      <div class="thermo-row" data-asset="${symbol}">
        <div class="thermo-asset">${symbol}</div>
        ${cells}
      </div>
    `;
  }

  function sectionHtml(label, symbols) {
    const head = `
      <div class="thermo-row thermo-head">
        <div class="thermo-asset"></div>
        ${TF_ORDER.map(tf => `<div class="thermo-head-cell">${TF_LABELS[tf]}</div>`).join('')}
      </div>
    `;
    return `
      <div class="thermo-section">
        <div class="thermo-section-label">${label}</div>
        <div class="thermo-grid">
          ${head}
          ${symbols.map(rowHtml).join('')}
        </div>
      </div>
    `;
  }

  function mountThermometers(container) {
    if (!container) return;
    const K = window.Kraken;
    container.innerHTML = `
      ${sectionHtml('MAJORS', K.MAJORS)}
      ${sectionHtml('ALTS',   K.ALTS)}
      <div class="thermo-meta">
        <span id="thermo-stamp">–</span>
        <span class="thermo-divider">·</span>
        <span class="thermo-source">Kraken live · 15s</span>
      </div>
    `;
  }

  function updateThermometers(state) {
    if (!state) return;
    const T = window.Thermometer;
    const tickers = state.tickers || {};
    const anchors = state.anchors || {};
    const symbols = window.Kraken.ASSETS.map(a => a.symbol);

    for (const sym of symbols) {
      const live = tickers[sym];
      const ank  = anchors[sym] || {};
      for (const tf of ['1h', '4h', '24h', '7d']) {
        const cell = document.querySelector(
          `.thermo-cell[data-asset="${sym}"][data-tf="${tf}"]`
        );
        if (!cell) continue;
        const pct = T.pctChange(live, ank[tf]);
        const cls = T.classify(pct, tf);
        const w   = T.barWidth(pct, tf);
        let fillLeft, fillWidth;
        if (w >= 50) { fillLeft = 50; fillWidth = w - 50; }
        else         { fillLeft = w;  fillWidth = 50 - w; }
        cell.classList.remove('thermo-pending', 'thermo-bull', 'thermo-bear', 'thermo-neutral');
        cell.classList.add(`thermo-${cls}`);
        const fill = cell.querySelector('.thermo-bar-fill');
        if (fill) {
          fill.style.left  = fillLeft + '%';
          fill.style.width = fillWidth + '%';
        }
        const pctEl = cell.querySelector('.thermo-pct');
        if (pctEl) pctEl.textContent = T.fmtPct(pct);
      }
    }

    const stamp = document.getElementById('thermo-stamp');
    if (stamp && state.fetchedAt) {
      const d = new Date(state.fetchedAt);
      const hh = String(d.getHours()).padStart(2, '0');
      const mm = String(d.getMinutes()).padStart(2, '0');
      const ss = String(d.getSeconds()).padStart(2, '0');
      stamp.textContent = `${hh}:${mm}:${ss}`;
    }
  }

  window.Thermometers = { mountThermometers, updateThermometers };
})();
