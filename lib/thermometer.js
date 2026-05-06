// Thermometer math + cell render. Pure (no fetch, no DOM mutation outside the
// cell HTML it returns). Exposed as window.Thermometer.

(function () {
  // Bull/bear thresholds per timeframe (% change vs anker close).
  // Within +/- threshold = neutral.
  const THRESHOLDS = {
    '1h':  0.5,
    '4h':  1.0,
    '24h': 2.0,
    '7d':  5.0,
  };

  // Visual scale: at +/- threshold the bar is at 50% of half-side; at +/- 2x
  // threshold it pegs the end. That keeps small signals visible but avoids
  // outliers blowing the whole row.
  function classify(pct, tf) {
    const t = THRESHOLDS[tf];
    if (t == null || pct == null || isNaN(pct)) return 'neutral';
    if (pct >= t) return 'bull';
    if (pct <= -t) return 'bear';
    return 'neutral';
  }

  // Compute fill width 0..100 for the centered bar. 50 = midpoint (no signal),
  // 100 = full bull, 0 = full bear. Capped via 2x threshold.
  function barWidth(pct, tf) {
    const t = THRESHOLDS[tf];
    if (t == null || pct == null || isNaN(pct)) return 50;
    const max = t * 2;
    const clamped = Math.max(-max, Math.min(max, pct));
    return 50 + (clamped / max) * 50;
  }

  function fmtPct(pct) {
    if (pct == null || isNaN(pct)) return '—';
    const sign = pct > 0 ? '+' : '';
    return `${sign}${pct.toFixed(pct >= 10 || pct <= -10 ? 1 : 2)}%`;
  }

  // Compute pct from anker -> live. Returns null if either is missing.
  function pctChange(live, anker) {
    if (!live || !anker) return null;
    return ((live - anker) / anker) * 100;
  }

  // Render a single thermometer cell. The bar is a horizontal track with a
  // colored fill anchored at center; bull pushes right, bear pushes left.
  function renderCell(tf, live, anker) {
    const pct = pctChange(live, anker);
    const cls = classify(pct, tf);
    const w = barWidth(pct, tf);
    // Translate width 0..100 into left+width pair around 50%.
    let fillLeft, fillWidth;
    if (w >= 50) { fillLeft = 50; fillWidth = w - 50; }
    else         { fillLeft = w;  fillWidth = 50 - w; }
    const pctText = fmtPct(pct);
    return `
      <div class="thermo-cell thermo-${cls}" data-tf="${tf}">
        <div class="thermo-bar">
          <div class="thermo-bar-track"></div>
          <div class="thermo-bar-fill" style="left:${fillLeft}%;width:${fillWidth}%"></div>
          <div class="thermo-bar-mid"></div>
        </div>
        <div class="thermo-pct">${pctText}</div>
      </div>
    `;
  }

  // Build full state object for an asset across all 4 timeframes.
  // Returns { '1h': 'bull'|'bear'|'neutral', '4h': ..., ... }.
  function classifyAsset(live, anchors) {
    const out = {};
    for (const tf of Object.keys(THRESHOLDS)) {
      const pct = pctChange(live, anchors ? anchors[tf] : null);
      out[tf] = classify(pct, tf);
    }
    return out;
  }

  window.Thermometer = {
    THRESHOLDS,
    classify, barWidth, pctChange, fmtPct, renderCell, classifyAsset,
  };
})();
