// POSITION INSET — editorial inset rendering for the thesis-trader sensor.
// Three-column grid: corner (T-001 symbol + side), body (claim + paragraph),
// levels (entry/mark/TP/SL with the live MTM percentage).
//
// Stashes the parsed open trade on `window.__pulseLiveTrade` so the live
// layer's TP/SL/expiry alert detector can consume it without app.js needing
// to dig into component internals.

(function () {
  const U = () => window.PulseUtil;

  // --- thesis-trader-specific parsers (kept here so the sensor format and
  // its rendering live together)
  function parseThesisTrader(content) {
    const statusMatch = content.match(/\*\*Status:\*\*\s*([^\n|]+)/);
    const priceMatch = content.match(/^-?\s*BTC:\s*\$([0-9,.]+)/m);
    const openBlock = content.match(/##\s+Open trade\s+(\S+)[^\n]*\n([\s\S]+?)(?=\n##\s|$)/i);
    let trade = null;
    if (openBlock) {
      const id = openBlock[1];
      const body = openBlock[2];
      const direction = (openBlock[0].match(/(LONG|SHORT)/) || [])[1] || null;
      const entry = body.match(/Entry:\s*\$?([0-9,.]+)\s*@\s*([^\n|]+)\|\s*leeftijd:\s*([^\n]+)/);
      const mtm = body.match(/MTM\s+\*?\*?([+\-][0-9.,]+%)\s*\/\s*([+\-][0-9.,]+R)/);
      const tp1 = body.match(/TP1\s+\$?([0-9,.]+)[:\s]+\$?([0-9,.]+)\s+verwijderd[^\n]*?\(([~0-9.%-]+)\)/);
      const tp2 = body.match(/TP2\s+\$?([0-9,.]+)[:\s]+\$?([0-9,.]+)\s+verwijderd/);
      const sl = body.match(/SL[^\n]*?\$([0-9.,]+)[^\n]*\):\s*([A-Z]+)(?:[^\n]*?\$([0-9.,]+)\s*buffer)?/);
      const expiry = body.match(/Expiry\s+([\d\-]+):\s*(\d+\s*dagen)/);
      trade = {
        id,
        direction,
        entryPrice: entry ? entry[1] : null,
        entryWhen: entry ? entry[2].trim() : null,
        age: entry ? entry[3].trim() : null,
        mtmPct: mtm ? mtm[1] : null,
        mtmR: mtm ? mtm[2] : null,
        tp1: tp1 ? { price: tp1[1], distance: tp1[2], pct: tp1[3] } : null,
        tp2: tp2 ? { price: tp2[1], distance: tp2[2] } : null,
        sl: sl ? { price: sl[1], status: sl[2], buffer: sl[3] || null } : null,
        expiry: expiry ? { date: expiry[1], daysLeft: expiry[2] } : null,
      };
    }
    return {
      status: statusMatch ? statusMatch[1].trim() : null,
      price: priceMatch ? priceMatch[1] : null,
      trade,
    };
  }

  function numFromStr(s) {
    return s ? parseFloat(String(s).replace(/[^0-9.-]/g, '')) : null;
  }

  function render({ section, content, krant }) {
    if (!section) return;
    const u = U();
    if (!content) {
      section.innerHTML = '<div class="position-inset empty">Geen trade-data</div>';
      window.__pulseLiveTrade = null;
      return;
    }
    const d = parseThesisTrader(content);
    const t = d.trade;

    // Stash for live alerts.
    if (t) {
      window.__pulseLiveTrade = {
        id: t.id,
        direction: t.direction,
        entry: numFromStr(t.entryPrice),
        tp1: t.tp1 ? numFromStr(t.tp1.price) : null,
        tp2: t.tp2 ? numFromStr(t.tp2.price) : null,
        sl: t.sl ? numFromStr(t.sl.price) : null,
        expiryISO: t.expiry ? t.expiry.date : null,
      };
    } else {
      window.__pulseLiveTrade = null;
    }

    if (!t) {
      section.innerHTML = `<div class="position-inset empty">${u.escape(d.status || 'Geen open trade')}</div>`;
      return;
    }

    const sideCls = (t.direction || '').toUpperCase() === 'SHORT' ? 'short' : '';
    const mtmCls = t.mtmPct && t.mtmPct.startsWith('-') ? 'bear' : '';
    const headline = (krant && krant.kop) || u.shapeHeadline(krant && krant.stelling)
      || `${t.id} ${t.direction} draait door`;
    const body = u.shapeBodyParagraph(krant && krant.les, krant && krant.actie)
      || u.shapeBodyParagraph(d.status);
    const entryNum = numFromStr(t.entryPrice);

    section.innerHTML = `
      <div class="position-inset"
           data-tt-entry="${entryNum || ''}"
           data-tt-direction="${t.direction || ''}"
           data-tt-id="${t.id || ''}">
        <div class="corner">
          <div>open positie</div>
          <div class="symbol">${u.escape(t.id)}</div>
          <div class="side ${sideCls}">${t.direction ? 'BTC ' + t.direction : ''}</div>
        </div>
        <div class="body">
          <h3>${u.escape(headline)}</h3>
          ${body}
        </div>
        <div class="levels">
          ${t.mtmPct ? `<div class="mtm ${mtmCls}" data-live="tt-mtm">${u.escape(t.mtmPct)}${t.mtmR ? ' <span class="dim">' + u.escape(t.mtmR) + '</span>' : ''}</div>` : ''}
          ${t.entryPrice ? `<div><span class="lbl">entry</span><span class="v">$${u.escape(t.entryPrice)}</span></div>` : ''}
          ${d.price ? `<div><span class="lbl">mark</span><span class="v" data-live="BTC-price-tt">$${u.escape(d.price)}</span></div>` : ''}
          ${t.tp1 ? `<div><span class="lbl">tp1</span><span class="v">$${u.escape(t.tp1.price)}</span></div>` : ''}
          ${t.tp2 ? `<div><span class="lbl">tp2</span><span class="v">$${u.escape(t.tp2.price)}</span></div>` : ''}
          ${t.sl ? `<div><span class="lbl">sl</span><span class="v">$${u.escape(t.sl.price)}</span></div>` : ''}
          ${t.expiry ? `<div><span class="lbl">expiry</span><span class="v">${u.escape(t.expiry.date)}</span></div>` : ''}
        </div>
      </div>
    `;
  }

  window.PulsePositionInset = { render };
})();
