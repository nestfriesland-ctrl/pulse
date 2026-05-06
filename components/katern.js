// KATERN — voorpagina van één katern (markt / machinekamer / lichaam / residu / necrologie).
//
// Toont:
//   - katern-header (back-link + h1 + tagline)
//   - viz-section (per-katern, opt-in)
//   - tile-grid van alle visible sensors in dit katern
//   - tijd-delta-kicker boven elke tile waar sensor.updated_at > lastView
//
// Hergebruikt bestaande CSS-klassen waar mogelijk: .kicker, .deck, .meta-row.
// Nieuwe klassen alleen voor katern-page-grid (.katern-page, .katern-header,
// .tile-grid, .tile, .tile-foot, .tijd-delta-kicker, .katern-empty).

(function () {
  const U = () => window.PulseUtil;

  function tileHtml(slot, { verschoven, katernName }) {
    const u = U();
    const { name, content, krant, regime, meta } = slot;
    const kickerCls = u.regimeKickerClass(regime);
    const kickerLabel = u.titleize(name);
    const kickerText = regime
      ? `${kickerLabel} · ${u.shortenRegime(regime)}`
      : kickerLabel;
    const headline = u.shapeHeadline(krant && krant.stelling)
      || u.fallbackHeadline(content)
      || u.titleize(name);
    const deck = u.shapeDeck(krant && krant.bewijs) || '';
    const lastU = (meta && meta.lastUpdated) ? meta.lastUpdated : '—';
    const freshClass = (meta && meta.status) ? ` fresh-${meta.status}` : '';

    return `
      <article class="tile${freshClass}" data-sensor="${u.escape(name)}">
        ${verschoven ? '<div class="tijd-delta-kicker">verschoven sinds u laatst keek</div>' : ''}
        <div class="kicker ${kickerCls}">${u.escape(kickerText)}</div>
        <h2>${u.escape(headline)}</h2>
        ${deck ? `<p class="deck">${u.escape(deck)}</p>` : ''}
        <div class="tile-foot">
          <span class="run">run · ${u.escape(lastU)}</span>
          <a class="deep-link" href="#${u.escape(katernName)}/${u.escape(name)}">→ deep</a>
        </div>
      </article>
    `;
  }

  function emptyHtml(katernName) {
    if (katernName === 'lichaam') {
      return `<div class="katern-empty">
        <h3>Geen actieve sensor in dit katern.</h3>
        <p>Cortex (Whoop) staat op KANDIDAAT-VERWIJDERING — Whoop OAuth dood sinds cycle 1.
        Ruimte gereserveerd voor herstel.</p>
      </div>`;
    }
    if (katernName === 'residu') {
      return `<div class="katern-empty">
        <h3>Observer-residue wordt geseed in PR #7.</h3>
        <p>Daily prompt schrijft één falsifieerbare stelling over jouw eigen leesgedrag — falsificatie-object, geen steering-signal.</p>
      </div>`;
    }
    if (katernName === 'necrologie') {
      return `<div class="katern-empty">
        <h3>Necrologie wordt geseed in PR #8.</h3>
        <p>Formele begrafenissen van gefalsifieerde hypothesen volgen, met SCHEMA + drie backlog-seeds.</p>
      </div>`;
    }
    return `<div class="katern-empty"><h3>Geen sensors om te tonen.</h3></div>`;
  }

  function vizSlotHtml(vizKey) {
    if (vizKey === 'markt') {
      return `
        <section class="katern-viz">
          <div class="viz-block">
            <div class="viz-label">BTC · 4h · entry / SL / TP markers uit thesis-trader</div>
            <div id="markt-btc-chart"></div>
          </div>
          <div class="viz-block">
            <div class="viz-label">Watchlist · 7d sparklines</div>
            <div id="markt-watchlist-grid" class="watchlist-grid"></div>
          </div>
        </section>
      `;
    }
    if (vizKey === 'machinekamer') {
      return `
        <section class="katern-viz">
          <div class="viz-block">
            <div class="viz-label">Service uptime · laatste 30 dagen · groen = sensor-commit op die dag</div>
            <div id="machinekamer-uptime" class="uptime-strip-grid"></div>
          </div>
        </section>
      `;
    }
    return '';
  }

  function render({ view, katernName, def, sensors, contents, lastView, parseSensorMeta, parseRegime, parseKrant }) {
    if (!view || !def) return;
    const u = U();

    const slotsData = sensors.map(name => {
      const content = contents[name] || null;
      return {
        name,
        content,
        krant: parseKrant(content),
        regime: parseRegime(content),
        meta: parseSensorMeta(content),
      };
    });

    const lvTs = lastView ? new Date(lastView).getTime() : null;
    const tilesHtml = slotsData.length
      ? slotsData.map(s => {
          const sensorTs = (s.meta && s.meta.lastUpdated) ? new Date(s.meta.lastUpdated).getTime() : null;
          const verschoven = lvTs && sensorTs && !isNaN(sensorTs) && sensorTs > lvTs;
          return tileHtml(s, { verschoven, katernName });
        }).join('')
      : emptyHtml(katernName);

    const vizHtml = def.viz ? vizSlotHtml(def.viz) : '';

    view.innerHTML = `
      <div class="container katern-page">
        <header class="katern-header">
          <a href="#dashboard" class="back-link">← Dashboard</a>
          <h1>${u.escape(def.label)}</h1>
          <div class="tagline">${u.escape(def.tagline)}</div>
        </header>
        ${vizHtml}
        ${slotsData.length ? `<div class="tile-grid">${tilesHtml}</div>` : tilesHtml}
      </div>
    `;

    // Mount viz after innerHTML so target divs exist.
    if (def.viz === 'markt' && window.PulseKaternViz) {
      window.PulseKaternViz.renderMarkt({ contents });
    } else if (def.viz === 'machinekamer' && window.PulseKaternViz) {
      window.PulseKaternViz.renderMachinekamer({ sensors });
    }
  }

  window.PulseKatern = { render };
})();
