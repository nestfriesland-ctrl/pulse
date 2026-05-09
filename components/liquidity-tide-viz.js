// LIQUIDITY-TIDE viz — drie horizontale lanes (BTC/ETH/HYPE), spot in het
// midden, top-long/short clusters als banden links/rechts. Sweep-markers
// (vorige cyclus cluster die door spot is) worden als doorkruiste lijnen
// getekend. Geen libs — pure D3 SVG.
//
// ViewBox 700x220 (of 700x180 voor katern). Schaal per asset is symmetrisch
// rond spot in ±5% range.

(function () {
  const NEAR_PCT = 0.05;
  const PALETTE = {
    accent: '#2a5a6e',     // tide-accent
    long: '#a04040',       // donkerrood — long-cluster (cascade-down magnet)
    short: '#3a6e3a',      // donkergroen — short-cluster (squeeze-up magnet)
    spot: '#16140f',       // ink
    sweep: '#d4a23c',      // amber — gekruiste cluster
    paper: '#f2ecdf',
    rule: 'rgba(22,20,15,0.18)',
  };

  function render({ container, data, height }) {
    if (!container || !data || !data.assets || !window.d3) return;
    container.innerHTML = '';

    const W = 700;
    const H = height || 220;
    const padL = 60, padR = 12, padT = 14, padB = 22;
    const innerW = W - padL - padR;
    const innerH = H - padT - padB;

    const svg = window.d3.select(container).append('svg')
      .attr('viewBox', `0 0 ${W} ${H}`)
      .attr('preserveAspectRatio', 'xMidYMid meet')
      .attr('class', 'lt-svg');

    const g = svg.append('g').attr('transform', `translate(${padL},${padT})`);

    const assets = data.assets.slice(0, 3);
    const laneH = innerH / assets.length;

    assets.forEach((a, i) => {
      const y = i * laneH + laneH / 2;
      const lane = g.append('g').attr('transform', `translate(0,${y})`);

      // Asset label
      g.append('text')
        .attr('x', -8)
        .attr('y', y + 4)
        .attr('text-anchor', 'end')
        .attr('font-family', 'IBM Plex Mono, monospace')
        .attr('font-size', 11)
        .attr('fill', PALETTE.spot)
        .text(a.label);

      // Lane bar — spot ±5%
      const spotLo = a.spot * (1 - NEAR_PCT);
      const spotHi = a.spot * (1 + NEAR_PCT);
      const x = window.d3.scaleLinear().domain([spotLo, spotHi]).range([0, innerW]);

      lane.append('line')
        .attr('x1', 0).attr('x2', innerW)
        .attr('y1', 0).attr('y2', 0)
        .attr('stroke', PALETTE.rule)
        .attr('stroke-width', 1);

      // Long cluster band (below spot)
      if (a.topLong && a.topLong.price > spotLo && a.topLong.price < a.spot) {
        const cx = x(a.topLong.price);
        lane.append('rect')
          .attr('x', cx - 14).attr('y', -8)
          .attr('width', 28).attr('height', 16)
          .attr('fill', PALETTE.long).attr('opacity', 0.55);
        lane.append('text')
          .attr('x', cx).attr('y', -10)
          .attr('text-anchor', 'middle')
          .attr('font-family', 'IBM Plex Sans Condensed, sans-serif')
          .attr('font-size', 9)
          .attr('fill', PALETTE.long)
          .text(a.topLong.sizeLabel || '');
      }
      // Short cluster band (above spot)
      if (a.topShort && a.topShort.price < spotHi && a.topShort.price > a.spot) {
        const cx = x(a.topShort.price);
        lane.append('rect')
          .attr('x', cx - 14).attr('y', -8)
          .attr('width', 28).attr('height', 16)
          .attr('fill', PALETTE.short).attr('opacity', 0.55);
        lane.append('text')
          .attr('x', cx).attr('y', -10)
          .attr('text-anchor', 'middle')
          .attr('font-family', 'IBM Plex Sans Condensed, sans-serif')
          .attr('font-size', 9)
          .attr('fill', PALETTE.short)
          .text(a.topShort.sizeLabel || '');
      }

      // Spot tick
      const sx = x(a.spot);
      lane.append('line')
        .attr('x1', sx).attr('x2', sx)
        .attr('y1', -10).attr('y2', 10)
        .attr('stroke', PALETTE.spot)
        .attr('stroke-width', 2);

      lane.append('text')
        .attr('x', sx).attr('y', 22)
        .attr('text-anchor', 'middle')
        .attr('font-family', 'IBM Plex Mono, monospace')
        .attr('font-size', 9)
        .attr('fill', PALETTE.spot)
        .text(formatSpot(a.spot));

      // Sweep markers — previous-cycle clusters that current spot has crossed.
      const prev = (data.sweepState || {})[a.label];
      if (prev) {
        if (prev.long != null && a.spot <= prev.long) drawSweep(lane, x(prev.long));
        if (prev.short != null && a.spot >= prev.short) drawSweep(lane, x(prev.short));
      }
    });

    // Scale label (one shared label, top-right): ±5% rond spot
    svg.append('text')
      .attr('x', W - padR).attr('y', 12)
      .attr('text-anchor', 'end')
      .attr('font-family', 'IBM Plex Sans Condensed, sans-serif')
      .attr('font-size', 9)
      .attr('letter-spacing', '0.16em')
      .attr('fill', PALETTE.accent)
      .text('±5% RANGE');
  }

  function drawSweep(lane, cx) {
    lane.append('line')
      .attr('x1', cx - 5).attr('x2', cx + 5)
      .attr('y1', -10).attr('y2', 10)
      .attr('stroke', PALETTE.sweep)
      .attr('stroke-width', 2);
    lane.append('line')
      .attr('x1', cx - 5).attr('x2', cx + 5)
      .attr('y1', 10).attr('y2', -10)
      .attr('stroke', PALETTE.sweep)
      .attr('stroke-width', 2);
  }

  function formatSpot(p) {
    if (p == null) return '—';
    if (p >= 1000) return p.toLocaleString('en-US', { maximumFractionDigits: 0 });
    if (p >= 1) return p.toFixed(2);
    return p.toFixed(4);
  }

  window.PulseLiquidityTideViz = { render };
})();
