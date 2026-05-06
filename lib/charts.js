// Lightweight-charts wrappers for the editorial layout.
// Two charts in this layer:
//   initBtcChart(containerId)      — BTC 4h candlesticks, 30 candles (lead body)
//   initEthBtcRatio(containerId)   — ETH/BTC daily ratio sparkline (macro col)
//
// Both pull from window.Kraken.fetchCandles(), refresh every 5 min, and
// degrade gracefully to a text fallback if the library or data is missing.
//
// Style: paper-aesthetic editorial — no grid, no toolbar, transparent bg,
// CSS-variable-driven colors so palette changes propagate.

(function () {
  const REFRESH_MS = 5 * 60 * 1000;
  // Per-container chart state so re-init (after a wiki-refresh re-render
  // wipes the section innerHTML) cleans up the previous chart's interval
  // and DOM instead of leaking detached observers.
  const state = {};

  function dispose(containerId) {
    const s = state[containerId];
    if (!s) return;
    if (s.timer) clearInterval(s.timer);
    if (s.observer) try { s.observer.disconnect(); } catch (e) {}
    if (s.chart) try { s.chart.remove(); } catch (e) {}
    delete state[containerId];
  }

  function readVar(name, fallback) {
    if (typeof getComputedStyle !== 'function') return fallback;
    const v = getComputedStyle(document.documentElement)
      .getPropertyValue(name)
      .trim();
    return v || fallback;
  }

  function paletteColors() {
    return {
      bull: readVar('--bull', '#1f6e3f'),
      bear: readVar('--bear', '#a02a26'),
      ink: readVar('--ink', '#16140f'),
      inkSoft: readVar('--ink-soft', '#4a463c'),
      inkMute: readVar('--ink-mute', '#756f5f'),
      paperRule: readVar('--paper-rule', '#d9d2c3'),
    };
  }

  function fallback(container, msg) {
    if (!container) return;
    container.innerHTML = `<div class="chart-fallback">${msg}</div>`;
  }

  function fmtUsd(n) {
    if (n == null) return '—';
    return '$' + Number(n).toLocaleString('en-US', { maximumFractionDigits: 0 });
  }

  function fmtDate(t) {
    const d = new Date(t * 1000);
    return d.toLocaleDateString('nl-NL', { day: 'numeric', month: 'short' });
  }

  // --- BTC 4h candlestick chart ----------------------------------------

  async function initBtcChart(containerId) {
    dispose(containerId);
    const container = document.getElementById(containerId);
    if (!container) return;
    if (typeof window.LightweightCharts === 'undefined') {
      fallback(container, 'BTC chart unavailable (charts library not loaded).');
      return;
    }
    if (!window.Kraken || !window.Kraken.fetchCandles) {
      fallback(container, 'BTC chart unavailable (Kraken module not loaded).');
      return;
    }

    container.innerHTML = '';
    const canvas = document.createElement('div');
    canvas.className = 'chart-canvas';
    canvas.style.height = '220px';
    container.appendChild(canvas);

    const caption = document.createElement('div');
    caption.className = 'chart-caption';
    caption.textContent = 'BTC · 4h · Kraken';
    container.appendChild(caption);

    const c = paletteColors();
    const chart = window.LightweightCharts.createChart(canvas, {
      width: canvas.clientWidth,
      height: 220,
      layout: {
        background: { type: 'solid', color: 'transparent' },
        textColor: c.inkSoft,
        fontFamily: "'IBM Plex Mono', monospace",
        fontSize: 10,
      },
      grid: {
        vertLines: { visible: false },
        horzLines: { color: c.paperRule, style: 0 },
      },
      rightPriceScale: { borderColor: c.paperRule },
      timeScale: { borderColor: c.paperRule, timeVisible: false, secondsVisible: false },
      crosshair: { mode: 0 },
      handleScroll: false,
      handleScale: false,
    });

    const series = chart.addCandlestickSeries({
      upColor: c.bull,
      downColor: c.bear,
      wickUpColor: c.bull,
      wickDownColor: c.bear,
      borderUpColor: c.bull,
      borderDownColor: c.bear,
    });

    let lastCandle = null;
    async function load() {
      const candles = await window.Kraken.fetchCandles('XBTUSD', 240, 30);
      if (!candles || !candles.length) {
        if (!lastCandle) fallback(container, 'BTC OHLC data unavailable.');
        return;
      }
      series.setData(candles);
      chart.timeScale().fitContent();
      lastCandle = candles[candles.length - 1];
      caption.textContent = `BTC · 4h · ${candles.length} candles · close ${fmtUsd(lastCandle.close)} on ${fmtDate(lastCandle.time)} · Kraken`;
    }

    await load();
    const timer = setInterval(load, REFRESH_MS);

    // Resize observer keeps the chart filling the container width.
    let observer = null;
    if (typeof ResizeObserver !== 'undefined') {
      observer = new ResizeObserver(() => {
        chart.applyOptions({ width: canvas.clientWidth });
      });
      observer.observe(canvas);
    }
    state[containerId] = { chart, timer, observer };
  }

  // --- ETH/BTC daily ratio sparkline -----------------------------------
  // 7 daily candles, line of closes, with a horizontal reference at 0.029
  // (the sub-floor breakdown trigger from the brief).

  async function initEthBtcRatio(containerId) {
    dispose(containerId);
    const container = document.getElementById(containerId);
    if (!container) return;
    if (typeof window.LightweightCharts === 'undefined') {
      fallback(container, 'ETH/BTC sparkline unavailable.');
      return;
    }
    if (!window.Kraken || !window.Kraken.fetchCandles) {
      fallback(container, 'ETH/BTC sparkline unavailable.');
      return;
    }

    container.innerHTML = '';
    const canvas = document.createElement('div');
    canvas.style.height = '90px';
    canvas.style.width = '100%';
    container.appendChild(canvas);

    const c = paletteColors();
    const chart = window.LightweightCharts.createChart(canvas, {
      width: canvas.clientWidth,
      height: 90,
      layout: {
        background: { type: 'solid', color: 'transparent' },
        textColor: c.inkSoft,
        fontFamily: "'IBM Plex Mono', monospace",
        fontSize: 9,
      },
      grid: { vertLines: { visible: false }, horzLines: { visible: false } },
      rightPriceScale: { visible: false },
      leftPriceScale: { visible: false },
      timeScale: { visible: false },
      crosshair: { mode: 0 },
      handleScroll: false,
      handleScale: false,
    });

    const line = chart.addLineSeries({
      color: c.ink,
      lineWidth: 1.5,
      priceLineVisible: false,
      lastValueVisible: false,
    });

    async function load() {
      // Kraken pair for ETH/BTC: 'ETHXBT' (canonical key 'XETHXXBT').
      const candles = await window.Kraken.fetchCandles('ETHXBT', 1440, 7);
      if (!candles || !candles.length) {
        fallback(container, 'ETH/BTC ratio data unavailable.');
        return;
      }
      line.setData(candles.map(k => ({ time: k.time, value: k.close })));
      // Horizontal reference at 0.029 — sub-floor breakdown level.
      try {
        line.createPriceLine({
          price: 0.029,
          color: c.bear,
          lineWidth: 1,
          lineStyle: 2,
          axisLabelVisible: false,
          title: '',
        });
      } catch (e) { /* createPriceLine missing in older builds — silent */ }
      chart.timeScale().fitContent();
    }

    await load();
    const timer = setInterval(load, REFRESH_MS);

    let observer = null;
    if (typeof ResizeObserver !== 'undefined') {
      observer = new ResizeObserver(() => {
        chart.applyOptions({ width: canvas.clientWidth });
      });
      observer.observe(canvas);
    }
    state[containerId] = { chart, timer, observer };
  }

  // --- BTC 4h candlestick chart with thesis-trader markers ------------
  // Adds price-line markers for entry / SL / TP1 / TP2 if provided.
  // Renders 60 candles (vs 30 in lead-chart) so context around entry is visible.

  async function initBtcChartWithMarkers(containerId, markers) {
    dispose(containerId);
    const container = document.getElementById(containerId);
    if (!container) return;
    if (typeof window.LightweightCharts === 'undefined') {
      fallback(container, 'BTC chart unavailable (charts library not loaded).');
      return;
    }
    if (!window.Kraken || !window.Kraken.fetchCandles) {
      fallback(container, 'BTC chart unavailable (Kraken module not loaded).');
      return;
    }

    container.innerHTML = '';
    const canvas = document.createElement('div');
    canvas.className = 'chart-canvas';
    canvas.style.height = '300px';
    container.appendChild(canvas);

    const caption = document.createElement('div');
    caption.className = 'chart-caption';
    caption.textContent = 'BTC · 4h · Kraken';
    container.appendChild(caption);

    const c = paletteColors();
    const chart = window.LightweightCharts.createChart(canvas, {
      width: canvas.clientWidth,
      height: 300,
      layout: {
        background: { type: 'solid', color: 'transparent' },
        textColor: c.inkSoft,
        fontFamily: "'IBM Plex Mono', monospace",
        fontSize: 10,
      },
      grid: {
        vertLines: { visible: false },
        horzLines: { color: c.paperRule, style: 0 },
      },
      rightPriceScale: { borderColor: c.paperRule },
      timeScale: { borderColor: c.paperRule, timeVisible: false, secondsVisible: false },
      crosshair: { mode: 0 },
      handleScroll: false,
      handleScale: false,
    });

    const series = chart.addCandlestickSeries({
      upColor: c.bull,
      downColor: c.bear,
      wickUpColor: c.bull,
      wickDownColor: c.bear,
      borderUpColor: c.bull,
      borderDownColor: c.bear,
    });

    // Marker-completeness wordt expliciet in de caption getoond zodat een
    // halfgevulde markers-set niet visueel niet te onderscheiden is van een
    // volledig-correct geparseerde set. Anti-fragiel — geen silent failure.
    const ALL_MARKER_KEYS = ['entry', 'sl', 'tp1', 'tp2'];

    let lastCandle = null;
    async function load() {
      const candles = await window.Kraken.fetchCandles('XBTUSD', 240, 60);
      if (!candles || !candles.length) {
        if (!lastCandle) fallback(container, 'BTC OHLC data unavailable.');
        return;
      }
      series.setData(candles);

      const placed = [];
      const missing = [];
      if (markers) {
        const tryLine = (price, color, title, key) => {
          if (price == null || isNaN(price)) { missing.push(key); return; }
          try {
            series.createPriceLine({
              price,
              color,
              lineWidth: 1,
              lineStyle: 2,
              axisLabelVisible: true,
              title,
            });
            placed.push(key);
          } catch (e) { missing.push(key); /* older builds */ }
        };
        tryLine(markers.entry, c.ink,  'entry', 'entry');
        tryLine(markers.sl,    c.bear, 'SL',    'sl');
        tryLine(markers.tp1,   c.bull, 'TP1',   'tp1');
        tryLine(markers.tp2,   c.bull, 'TP2',   'tp2');
      } else {
        ALL_MARKER_KEYS.forEach(k => missing.push(k));
      }
      const markerNote = !markers
        ? 'markers: 0/4 — thesis-trader ongeparseerd of geen open positie'
        : missing.length === 0
          ? `markers: 4/4 (entry ${fmtUsd(markers.entry)} · SL ${fmtUsd(markers.sl)} · TP1 ${fmtUsd(markers.tp1)} · TP2 ${fmtUsd(markers.tp2)})`
          : `markers: ${placed.length}/4 — ontbreekt: ${missing.join(', ')}`;

      chart.timeScale().fitContent();
      lastCandle = candles[candles.length - 1];
      caption.textContent = `BTC · 4h · ${candles.length} candles · close ${fmtUsd(lastCandle.close)} on ${fmtDate(lastCandle.time)} · ${markerNote} · Kraken`;
    }

    await load();
    const timer = setInterval(load, REFRESH_MS);

    let observer = null;
    if (typeof ResizeObserver !== 'undefined') {
      observer = new ResizeObserver(() => {
        chart.applyOptions({ width: canvas.clientWidth });
      });
      observer.observe(canvas);
    }
    state[containerId] = { chart, timer, observer };
  }

  // --- Watchlist sparkline (7d daily, color by trend) -----------------

  async function initWatchlistSparkline(containerId, symbol) {
    dispose(containerId);
    const container = document.getElementById(containerId);
    if (!container) return;
    if (typeof window.LightweightCharts === 'undefined') {
      fallback(container, 'spark unavailable');
      return;
    }
    if (!window.Kraken || !window.Kraken.fetchCandles) {
      fallback(container, 'spark unavailable');
      return;
    }
    const asset = window.Kraken.getAsset(symbol);
    if (!asset) {
      fallback(container, `${symbol}: pair niet bekend`);
      return;
    }

    container.innerHTML = '';
    const canvas = document.createElement('div');
    canvas.style.height = '40px';
    canvas.style.width = '100%';
    container.appendChild(canvas);

    const c = paletteColors();
    const chart = window.LightweightCharts.createChart(canvas, {
      width: canvas.clientWidth,
      height: 40,
      layout: {
        background: { type: 'solid', color: 'transparent' },
        textColor: 'transparent',
        fontSize: 8,
      },
      grid: { vertLines: { visible: false }, horzLines: { visible: false } },
      rightPriceScale: { visible: false },
      leftPriceScale: { visible: false },
      timeScale: { visible: false },
      crosshair: { mode: 0 },
      handleScroll: false,
      handleScale: false,
    });

    const line = chart.addLineSeries({
      color: c.ink,
      lineWidth: 1.25,
      priceLineVisible: false,
      lastValueVisible: false,
    });

    async function load() {
      const candles = await window.Kraken.fetchCandles(asset.pair, 1440, 7);
      if (!candles || !candles.length) {
        fallback(container, `${symbol}: geen data`);
        return;
      }
      line.setData(candles.map(k => ({ time: k.time, value: k.close })));
      chart.timeScale().fitContent();
      const first = candles[0].close;
      const last = candles[candles.length - 1].close;
      const trendColor = last > first ? c.bull : c.bear;
      line.applyOptions({ color: trendColor });
    }

    await load();
    const timer = setInterval(load, REFRESH_MS);

    let observer = null;
    if (typeof ResizeObserver !== 'undefined') {
      observer = new ResizeObserver(() => {
        chart.applyOptions({ width: canvas.clientWidth });
      });
      observer.observe(canvas);
    }
    state[containerId] = { chart, timer, observer };
  }

  window.PulseCharts = {
    initBtcChart,
    initEthBtcRatio,
    initBtcChartWithMarkers,
    initWatchlistSparkline,
    dispose,
  };
})();
