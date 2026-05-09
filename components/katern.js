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

  function tileHtml(slot, { verschoven, katernName, displaySensor, isKandidaat }) {
    const u = U();
    const { name, content, krant, regime, meta } = slot;
    // displaySensor maps sensor file-name → display alias (machinekamer →
    // meta-stelling) zodat de URL `#machinekamer/meta-stelling` wordt en
    // niet `#machinekamer/machinekamer`.
    const display = displaySensor ? displaySensor(name) : name;
    const kickerCls = u.regimeKickerClass(regime);
    const kickerLabel = u.titleize(display);
    const kickerText = regime
      ? `${kickerLabel} · ${u.shortenRegime(regime)}`
      : kickerLabel;
    const headline = (krant && krant.kop)
      || u.shapeHeadline(krant && krant.stelling)
      || u.fallbackHeadline(content)
      || u.titleize(display);
    const deck = u.shapeDeck(krant && krant.bewijs) || '';
    const lastU = (meta && meta.lastUpdated) ? meta.lastUpdated : '—';
    const freshClass = (meta && meta.status) ? ` fresh-${meta.status}` : '';
    const kandidaatClass = (typeof isKandidaat === 'function' && isKandidaat(name)) ? ' kandidaat' : '';

    return `
      <article class="tile${freshClass}${kandidaatClass}" data-sensor="${u.escape(name)}">
        ${verschoven ? '<div class="tijd-delta-kicker">verschoven sinds u laatst keek</div>' : ''}
        <div class="kicker ${kickerCls}">${u.escape(kickerText)}</div>
        <h2>${u.escape(headline)}</h2>
        ${deck ? `<p class="deck">${u.escape(deck)}</p>` : ''}
        <div class="tile-foot">
          <span class="run">run · ${u.escape(lastU)}</span>
          <a class="deep-link" href="#${u.escape(katernName)}/${u.escape(display)}">Lees verder</a>
        </div>
      </article>
    `;
  }

  function emptyHtml(katernName) {
    if (katernName === 'residu') {
      return `<div class="katern-empty">
        <h3>Observer-residue sensor wacht op wiki-merge.</h3>
        <p>Daily prompt schrijft één falsifieerbare stelling over jouw eigen leesgedrag — falsificatie-object, geen steering-signal. BOOTSTRAP tot ≥14d window én ≥200 events.</p>
      </div>`;
    }
    if (katernName === 'necrologie') {
      return `<div class="katern-empty">
        <h3>Geen begrafenissen geregistreerd.</h3>
        <p>Wacht op wiki/necrologie/*.md merge. Drie backlog-seeds (H-META-01, H-CVD-12, H-EBP-PIXEL-01) staan klaar in feat/necrologie-seed.</p>
      </div>`;
    }
    return `<div class="katern-empty"><h3>Geen sensors om te tonen.</h3></div>`;
  }

  // Lead-style article voor RESIDU (één-sensor katern: observer-residue).
  // Hergebruikt bestaande .lead-CSS — kicker + h1 + deck + body + falsifier-aside.
  function leadHtml(slot) {
    const u = U();
    const { content, krant, regime, meta } = slot;
    const headline = (krant && krant.kop)
      || u.shapeHeadline(krant && krant.stelling)
      || u.fallbackHeadline(content)
      || 'Observer-residue';
    const deck = u.shapeDeck(krant && krant.bewijs) || '';
    const bodyHtml = u.shapeBody(krant && krant.les, krant && krant.actie);
    const falsifier = u.extractFalsifier(krant && krant.stelling)
      || u.extractFalsifier(krant && krant.actie)
      || '';
    const kickerCls = u.regimeKickerClass(regime);
    const kickerText = regime
      ? `Aandacht-residu · ${u.shortenRegime(regime)}`
      : 'Aandacht-residu';

    return `
      <section class="lead residu-lead">
        <div>
          <div class="kicker ${kickerCls}">${u.escape(kickerText)}</div>
          <h1>${u.escape(headline)}</h1>
          ${deck ? `<p class="deck">${u.escape(deck)}</p>` : ''}
          <div class="lead-body">${bodyHtml}</div>
        </div>
        <aside>
          <div class="label">observatie-laag</div>
          <h3>Strikt observatie</h3>
          <p>Sensor beschrijft Mathijs's eigen leesgedrag op pulse. Geen feedback-loop terug naar andere sensors, geen ranking, geen advies — falsificatie-object.</p>
          ${falsifier ? `<div class="falsifier">${u.escape(falsifier)}</div>` : ''}
          ${meta && meta.lastUpdated ? `<div class="meta-row"><span>Run</span><span>${u.escape(meta.lastUpdated)}</span></div>` : ''}
        </aside>
      </section>
    `;
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
    if (vizKey === 'residu') {
      return `
        <section class="katern-viz residu-viz">
          <div class="viz-block">
            <div class="viz-label">Aandacht-heatmap · 14 dagen × 6 katernen · cel-intensiteit = view-count</div>
            <div id="residu-heatmap"></div>
          </div>
        </section>
      `;
    }
    if (vizKey === 'necrologie') {
      return `
        <section class="katern-viz necrologie-viz">
          <div class="viz-block">
            <div class="viz-label">Doodsoorzaak-distributie · aggregate over alle begrafenissen</div>
            <div id="necrologie-aggregate"></div>
          </div>
        </section>
      `;
    }
    return '';
  }

  // NECROLOGIE — lead = recente begrafenis (alle 6 velden), triple = volgende
  // 2 met korte typering, strip = ID-reeks lopende kwartaal, footer-link archief.
  // Géén viz binnen individuele begrafenis — ritueel = formule + vorm.

  function necrologieLeadHtml(entry) {
    const u = U();
    const e = entry || {};
    return `
      <section class="lead necrologie-lead">
        <div>
          <div class="kicker bear">Begrafenis · ${u.escape(e.doodsoorzaak || '—')}</div>
          <h1>${u.escape(e.naam || '—')}</h1>
          <p class="deck">${u.escape(e.achtergebleven || '')}</p>
          <div class="necrologie-grafsteen">
            <div class="grafsteen-row"><span class="lbl">id</span><span class="v">${u.escape(e.id || '—')}</span></div>
            <div class="grafsteen-row"><span class="lbl">geboren</span><span class="v">${u.escape(e.geboren || '—')}</span></div>
            <div class="grafsteen-row"><span class="lbl">overleden</span><span class="v">${u.escape(e.overleden || '—')}</span></div>
            <div class="grafsteen-row"><span class="lbl">lifespan</span><span class="v">${u.escape(e.lifespan || '—')}</span></div>
          </div>
          <a class="deep-link" href="#necrologie/${u.escape(e.id || '')}">→ post-mortem</a>
        </div>
        <aside>
          <div class="label">register</div>
          <h3>Afgesloten · dood · formeel begraven</h3>
          <p>Necrologie is index met ritueel, geen post-mortem-analyse. Verhaal staat in de body of begraven-elders, niet in de zes-velden-grafsteen.</p>
          <div class="meta-row"><span>schema</span><a href="#doc/necrologie/SCHEMA.md">SCHEMA.md</a></div>
        </aside>
      </section>
    `;
  }

  function necrologieTripleArticle(entry) {
    const u = U();
    if (!entry) return `<article class="necrologie-mini empty"></article>`;
    return `
      <article class="necrologie-mini">
        <div class="kicker bear">${u.escape(entry.doodsoorzaak || '—')}</div>
        <h2><a href="#necrologie/${u.escape(entry.id || '')}">${u.escape(entry.naam || '—')}</a></h2>
        <div class="byline">${u.escape(entry.id || '')} · ${u.escape(entry.lifespan || '—')}</div>
        <p>${u.escape(entry.achtergebleven || '')}</p>
      </article>
    `;
  }

  function necrologieTripleHtml(entries) {
    if (!entries.length) return '';
    const slots = entries.slice(0, 3);
    const articles = slots.map(necrologieTripleArticle);
    while (articles.length < 3) articles.push(necrologieTripleArticle(null));
    return `
      <section class="triple necrologie-triple">
        ${articles[0]}
        <div class="rule"></div>
        ${articles[1]}
        <div class="rule"></div>
        ${articles[2]}
      </section>
    `;
  }

  function quarterLabel(date) {
    const q = Math.floor(date.getMonth() / 3) + 1;
    return `Q${q}-${date.getFullYear()}`;
  }

  function necrologieStripHtml(entries) {
    const u = U();
    const now = new Date();
    const qStart = new Date(now.getFullYear(), Math.floor(now.getMonth() / 3) * 3, 1);
    // Filter entries by overleden in current quarter (best-effort heuristic).
    // overleden parser is buiten scope hier — we tonen alle id's als kale strip
    // tot een dedicated quarter-filter relevant wordt (≥10 begrafenissen).
    const ids = entries.map(e => e.id).filter(Boolean);
    const archiveLabel = quarterLabel(qStart);
    return `
      <section class="strip necrologie-strip">
        <div class="item">
          <div class="name">${u.escape(archiveLabel)} · ID-reeks</div>
          <div class="v">${ids.length ? u.escape(ids.join(' · ')) : '—'}</div>
        </div>
        <div class="item">
          <div class="name">archief</div>
          <div class="v"><a href="#doc/necrologie/SCHEMA.md">schema</a></div>
        </div>
      </section>
    `;
  }

  function render({ view, katernName, def, sensors, contents, lastView, parseSensorMeta, parseRegime, parseKrant, displaySensor, isKandidaat, entries }) {
    if (!view || !def) return;
    const u = U();

    const vizHtml = def.viz ? vizSlotHtml(def.viz) : '';

    // Layout-keuze:
    //   'necrologie' — entries-driven (geen sensors). Lead = recente, triple
    //     = volgende 3, strip = ID-reeks. Aggregate-staaf onder lead.
    //   'lead' (RESIDU): één sensor, gerenderd als lead-article + viz onder.
    //   default: viz boven + tile-grid OF empty-state.
    let bodyHtml;
    if (def.layout === 'necrologie') {
      const list = Array.isArray(entries) ? entries : [];
      if (list.length === 0) {
        bodyHtml = `${vizHtml}${emptyHtml(katernName)}`;
      } else {
        const lead = list[0];
        const next = list.slice(1, 4);
        bodyHtml = `
          ${necrologieLeadHtml(lead)}
          ${vizHtml}
          ${necrologieTripleHtml(next)}
          ${necrologieStripHtml(list)}
        `;
      }
    } else {
      const slotsData = (sensors || []).map(name => {
        const content = (contents && contents[name]) || null;
        return {
          name, content,
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
            return tileHtml(s, { verschoven, katernName, displaySensor, isKandidaat });
          }).join('')
        : emptyHtml(katernName);
      const useLead = def.layout === 'lead' && slotsData.length && slotsData[0].content;
      if (useLead) {
        bodyHtml = `${leadHtml(slotsData[0])}${vizHtml}`;
      } else if (slotsData.length) {
        bodyHtml = `${vizHtml}<div class="tile-grid">${tilesHtml}</div>`;
      } else {
        bodyHtml = `${vizHtml}${emptyHtml(katernName)}`;
      }
    }

    view.innerHTML = `
      <div class="container katern-page">
        <header class="katern-header">
          <a href="#dashboard" class="back-link">← Dashboard</a>
          <h1>${u.escape(def.label)}</h1>
          <div class="tagline">${u.escape(def.tagline)}</div>
        </header>
        ${bodyHtml}
      </div>
    `;

    // Mount viz after innerHTML so target divs exist.
    if (def.viz === 'markt' && window.PulseKaternViz) {
      window.PulseKaternViz.renderMarkt({ contents });
    } else if (def.viz === 'machinekamer' && window.PulseKaternViz) {
      window.PulseKaternViz.renderMachinekamer({ sensors });
    } else if (def.viz === 'residu' && window.PulseKaternViz && window.PulseKaternViz.renderResidu) {
      window.PulseKaternViz.renderResidu({ container: document.getElementById('residu-heatmap') });
    } else if (def.viz === 'necrologie' && window.PulseKaternViz && window.PulseKaternViz.renderNecrologie) {
      window.PulseKaternViz.renderNecrologie({
        container: document.getElementById('necrologie-aggregate'),
        entries: entries || [],
      });
    }
  }

  window.PulseKatern = { render };
})();
