// FEAR & GREED gauge band — sub-band tussen LEAD en HEAT-INDEX.
//
// Layout: drie kolommen — groot getal links, gauge + heatmap midden,
// stelling+falsifier rechts. Geen iconen, geen vlaggetjes (krant-stijl).
//
// Data:
//   - value/classification:
//       1) wiki/sensors/fear-greed.md (parseFearGreed) als die bestaat,
//       2) anders gewoon de F&G regel uit market.md,
//       3) anders alternative.me live API.
//   - 30-day heatmap: alternative.me (?limit=30) — geen auth, CORS open.
//   - Stelling/falsifier: alleen uit fear-greed.md krant-sectie. Als die
//     sensor er nog niet is degradeert deze block naar gewoon de gauge.

(function () {
  const U = () => window.PulseUtil;
  const FNG_URL = 'https://api.alternative.me/fng/?limit=30';

  // Inner classification — derived from numeric value when text label is
  // missing. Aligns with alternative.me's bins:
  //   <25 extreme-fear, <45 fear, <55 neutral, <75 greed, else extreme-greed.
  function classify(v) {
    if (v == null || isNaN(v)) return null;
    if (v < 25) return 'extreme-fear';
    if (v < 45) return 'fear';
    if (v < 55) return 'neutral';
    if (v < 75) return 'greed';
    return 'extreme-greed';
  }

  function classToLabel(cls) {
    return ({
      'extreme-fear': 'Extreme Fear',
      'fear': 'Fear',
      'neutral': 'Neutral',
      'greed': 'Greed',
      'extreme-greed': 'Extreme Greed',
    })[cls] || '—';
  }

  function regimeForBand(cls) {
    if (cls === 'extreme-fear' || cls === 'fear') return 'fg-fear';
    if (cls === 'extreme-greed' || cls === 'greed') return 'fg-greed';
    return 'fg-neutral';
  }

  // --- value sourcing ---------------------------------------------------

  // Pull "Fear & Greed: 46 (Fear)" from market.md content.
  function parseFromMarket(content) {
    if (!content) return null;
    const m = content.match(/Fear\s*&\s*Greed:\s*(\d+)\s*\(([^)]+)\)/i);
    if (!m) return null;
    return { value: parseInt(m[1], 10), label: m[2].trim() };
  }

  // If/when the wiki adds a fear-greed.md sensor, parse value from
  // metadata-style "value: 46" / "classification: Fear" lines.
  function parseFromSensor(content) {
    if (!content) return null;
    const valM = content.match(/^(?:>\s*)?value:\s*(\d+)/m);
    const clsM = content.match(/^(?:>\s*)?classification:\s*([^\n]+)/m);
    if (!valM) return null;
    return {
      value: parseInt(valM[1], 10),
      label: clsM ? clsM[1].trim() : null,
    };
  }

  async function fetchLive() {
    try {
      const r = await fetch(FNG_URL, { cache: 'no-store' });
      if (!r.ok) return null;
      const d = await r.json();
      const data = (d && d.data) || [];
      if (!data.length) return null;
      // Most recent first in alternative.me. Reverse so the heatmap reads
      // left-to-right oldest → today.
      const reversed = [...data].reverse();
      const today = data[0];
      return {
        value: parseInt(today.value, 10),
        label: today.value_classification,
        history: reversed.map(d => ({
          value: parseInt(d.value, 10),
          cls: classify(parseInt(d.value, 10)),
        })),
      };
    } catch (e) {
      return null;
    }
  }

  function gaugeHtml(value) {
    const tickPct = Math.max(0, Math.min(100, value)) + '%';
    return `
      <div class="fg-gauge">
        <div class="mark" style="left:25%"></div>
        <div class="mark" style="left:50%"></div>
        <div class="mark" style="left:75%"></div>
        <div class="tick" style="left:${tickPct}"></div>
      </div>
      <div class="fg-gauge-scale">
        <span>0</span><span>25</span><span>50</span><span>75</span><span>100</span>
      </div>
    `;
  }

  function heatmapHtml(history) {
    if (!history || !history.length) {
      return `<div class="fg-heatmap"></div>
              <div class="fg-heatmap-label dim">30-dag history niet beschikbaar</div>`;
    }
    const cells = history.map(d => `<div class="cell ${d.cls || ''}" title="${d.value}"></div>`).join('');
    return `
      <div class="fg-heatmap">${cells}</div>
      <div class="fg-heatmap-label">30 dagen — links oudste, rechts vandaag</div>
    `;
  }

  async function render({ section, marketContent, sensorContent, krant }) {
    if (!section) return;
    const u = U();

    // Determine value: sensor → market → live.
    let parsed = parseFromSensor(sensorContent)
      || parseFromMarket(marketContent);

    // Live fetch always (we want the 30-day history regardless).
    const live = await fetchLive();
    if (!parsed && live) parsed = { value: live.value, label: live.label };

    if (!parsed) {
      section.innerHTML = `
        <div class="fg-num fg-neutral"><div class="value">—</div><div class="label">Sentiment</div></div>
        <div class="fg-mid">${gaugeHtml(50)}${heatmapHtml(null)}</div>
        <div class="fg-claim"><div class="kicker">sentiment</div><h3>Geen F&G data beschikbaar</h3></div>
      `;
      return;
    }

    const cls = classify(parsed.value);
    const bandCls = regimeForBand(cls);
    const labelText = parsed.label || classToLabel(cls);
    const headline = (krant && krant.kop) || u.shapeHeadline(krant && krant.stelling) || `${labelText} — score ${parsed.value}`;
    const falsifier = u.extractFalsifier(krant && krant.stelling) || '';

    section.innerHTML = `
      <div class="fg-num ${bandCls}">
        <div class="value">${parsed.value}</div>
        <div class="label">${u.escape(labelText)}</div>
      </div>
      <div class="fg-mid">
        ${gaugeHtml(parsed.value)}
        ${heatmapHtml(live && live.history)}
      </div>
      <div class="fg-claim">
        <div class="kicker">sentiment · ${u.escape(labelText.toLowerCase())}</div>
        <h3>${u.escape(headline)}</h3>
        ${falsifier ? `<div class="falsifier">${u.escape(falsifier)}</div>` : ''}
      </div>
    `;
  }

  window.PulseFearGreed = { render };
})();
