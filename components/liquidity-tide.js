// LIQUIDITY-TIDE feature section — sub-band tussen LEAD/FG en HEAT-INDEX.
//
// Bron: wiki/sensors/liquidity-tide.md (geschreven door mathijs-immortality
// liquidity-tide cron, elke 4u). Markdown-frontmatter bevat sweep_state per
// asset; scorebord-tabel bevat skew/regime per asset.
//
// Layout: drie kolommen — Kop+Stelling links, viz midden (drie lanes), scorebord
// rechts. Falsifier (Bewijs) onder de viz.

(function () {
  // ── Markdown parser ─────────────────────────────────────
  function parseLiquidityTide(content) {
    if (!content) return null;
    const out = {
      regime: null,
      lastUpdated: null,
      cycleCount: null,
      sweepState: {},
      assets: [],
      kop: null,
      stelling: null,
      bewijs: null,
      les: null,
      actie: null,
    };

    const regimeM = content.match(/^>\s*regime:\s*(\S+)/m);
    if (regimeM) out.regime = regimeM[1].trim();

    const luM = content.match(/^>\s*last_updated:\s*([^\n]+)/m);
    if (luM) out.lastUpdated = luM[1].trim();

    const ccM = content.match(/^>\s*cycle_count:\s*(\d+)/m);
    if (ccM) out.cycleCount = parseInt(ccM[1], 10);

    // Sweep-state YAML-block: lines like ">   BTC: long@79850 short@80450"
    const swM = content.match(/^>\s*sweep_state:\s*$([\s\S]*?)(?=\n>\s*[a-z_]+:|\n\n|\n##)/mi);
    if (swM) {
      for (const line of swM[1].split('\n')) {
        const mm = line.match(/^>\s+(\w+):\s*(?:long@([\d.]+))?\s*(?:short@([\d.]+))?/);
        if (mm) {
          out.sweepState[mm[1]] = {
            long: mm[2] ? parseFloat(mm[2]) : null,
            short: mm[3] ? parseFloat(mm[3]) : null,
          };
        }
      }
    }

    // Scorebord tabel — kolommen: Asset | Spot | Long-stack | Short-stack | Skew | Top-long | Top-short | Regime
    const tableMatch = content.match(/\|\s*Asset\s*\|[^\n]+\|\n\|[-\s|]+\|\n([\s\S]*?)(?=\n\n|\n##)/);
    if (tableMatch) {
      const rows = tableMatch[1].split('\n').filter(l => l.trim().startsWith('|'));
      for (const row of rows) {
        const cells = row.split('|').map(s => s.trim()).filter(Boolean);
        if (cells.length < 8) continue;
        const [label, spot, longStack, shortStack, skew, topLong, topShort, regime] = cells;
        out.assets.push({
          label,
          spot: parseFloat(spot),
          longStack,
          shortStack,
          skew: skew === '—' ? null : parseFloat(skew),
          topLong: parseTopCluster(topLong),
          topShort: parseTopCluster(topShort),
          regime,
        });
      }
    }

    const grab = (re) => { const m = content.match(re); return m ? m[1].trim() : null; };
    out.kop = grab(/\*\*Kop:\*\*\s*(.+)/);
    out.stelling = grab(/\*\*Stelling:\*\*\s*(.+)/);
    out.bewijs = grab(/\*\*Bewijs:\*\*\s*([^\n]+)/);
    out.les = grab(/\*\*Les:\*\*\s*(.+)/);
    out.actie = grab(/\*\*Actie:\*\*\s*(.+)/);
    return out;
  }

  // "79850.00 (1.2M)" → { price: 79850, size: '1.2M' }
  function parseTopCluster(cell) {
    if (!cell || cell === '—') return null;
    const m = cell.match(/([\d.]+)\s*\(([^)]+)\)/);
    if (!m) return null;
    return { price: parseFloat(m[1]), sizeLabel: m[2] };
  }

  // ── Regime → color/label ───────────────────────────────
  const REGIME_LABEL = {
    LOW_TIDE: 'Eb',
    BALANCED: 'Balans',
    LONG_HEAVY: 'Long-stack',
    SHORT_HEAVY: 'Short-stack',
    MAGNET_BELOW: 'Magnet ↓',
    MAGNET_ABOVE: 'Magnet ↑',
    HIGH_TIDE: 'Vloed',
    MIXED: 'Mixed',
    UNKNOWN: '—',
  };

  // ── Render in dashboard feature-section ────────────────
  function renderFeature({ section, data }) {
    if (!section) return;
    if (!data || !data.assets || data.assets.length === 0) {
      section.innerHTML = '<div class="lt-empty">Liquidity-Tide: nog geen data — sensor schrijft elke 4u.</div>';
      return;
    }

    const asset = (label) => data.assets.find(a => a.label === label);

    const rows = data.assets.map(a => `
      <tr class="lt-row regime-${a.regime || 'UNKNOWN'}">
        <td class="lt-asset">${a.label}</td>
        <td class="lt-spot">${formatPrice(a.spot)}</td>
        <td class="lt-stack">${a.longStack || '—'}</td>
        <td class="lt-stack">${a.shortStack || '—'}</td>
        <td class="lt-skew">${a.skew != null ? a.skew.toFixed(2) : '—'}</td>
        <td class="lt-regime">${REGIME_LABEL[a.regime] || a.regime || '—'}</td>
      </tr>
    `).join('');

    section.innerHTML = `
      <div class="lt-band">
        <div class="lt-claim">
          <div class="kicker">Liquidity Tide · ${REGIME_LABEL[data.regime] || data.regime || '—'}</div>
          <h3>${escapeHtml(data.kop || data.stelling || '—')}</h3>
          ${data.bewijs ? `<div class="falsifier">${escapeHtml(data.bewijs)}</div>` : ''}
        </div>
        <div class="lt-viz" id="lt-viz-host"></div>
        <div class="lt-table">
          <table>
            <thead>
              <tr><th>Asset</th><th>Spot</th><th>Long</th><th>Short</th><th>Skew</th><th>Regime</th></tr>
            </thead>
            <tbody>${rows}</tbody>
          </table>
          ${data.actie ? `<div class="lt-actie"><span class="kicker">Actie</span> ${escapeHtml(data.actie)}</div>` : ''}
        </div>
      </div>
    `;

    if (window.PulseLiquidityTideViz) {
      const host = section.querySelector('#lt-viz-host');
      window.PulseLiquidityTideViz.render({ container: host, data, height: 220 });
    }
  }

  // ── Render in markt-katern (compactere versie, één rij) ─
  function renderInMarktKatern({ container, data }) {
    if (!container || !data) return;
    const wrap = document.createElement('div');
    wrap.className = 'lt-katern-block';
    wrap.innerHTML = `
      <div class="lt-katern-head">
        <span class="kicker">Liquidity Tide</span>
        <span class="regime regime-${data.regime || 'UNKNOWN'}">${REGIME_LABEL[data.regime] || data.regime || '—'}</span>
      </div>
      ${data.kop ? `<div class="lt-katern-kop">${escapeHtml(data.kop)}</div>` : ''}
      <div class="lt-katern-viz"></div>
    `;
    container.appendChild(wrap);
    if (window.PulseLiquidityTideViz) {
      window.PulseLiquidityTideViz.render({ container: wrap.querySelector('.lt-katern-viz'), data, height: 180 });
    }
  }

  // ── Helpers ────────────────────────────────────────────
  function formatPrice(p) {
    if (p == null || isNaN(p)) return '—';
    if (p >= 1000) return p.toLocaleString('en-US', { maximumFractionDigits: 0 });
    if (p >= 1) return p.toFixed(2);
    return p.toFixed(4);
  }
  function escapeHtml(s) {
    if (s == null) return '';
    return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  window.PulseLiquidityTide = {
    parse: parseLiquidityTide,
    render: renderFeature,
    renderInKatern: renderInMarktKatern,
  };
})();
