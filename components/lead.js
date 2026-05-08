// LEAD article renderer — used for the market-sensor at the top of the page.
// Pulls Stelling/Bewijs/Les/Actie from the krant section and shapes them
// into the editorial lead grammar: kicker, h1 (claim), deck (one-line
// summary), 2-column body with dropcap, sidebar with falsifier.
// Embeds the BTC 4h chart container directly under the body.

(function () {
  const U = () => window.PulseUtil;

  function render({ section, content, krant, regime, meta }) {
    if (!section) return;
    const u = U();

    const headline = (krant && krant.kop) || u.shapeHeadline(krant.stelling) || 'Marktstelling';
    const deck = u.shapeDeck(krant.bewijs) || '';
    const bodyHtml = u.shapeBody(krant.les, krant.actie);

    const falsifier = u.extractFalsifier(krant.stelling)
      || u.extractFalsifier(krant.actie)
      || '';

    const kickerCls = u.regimeKickerClass(regime);
    const kickerText = regime
      ? `Marktstelling · ${u.shortenRegime(regime)}`
      : 'Marktstelling';

    const proposal = u.extractTradeProposal(krant.actie);

    const sidebar = `
      <aside>
        <div class="label">positie-voorstel</div>
        ${proposal.headline ? `<h3>${u.escape(proposal.headline)}</h3>` : '<h3>Geen actief entry-signaal</h3>'}
        ${proposal.body ? `<p>${u.escape(proposal.body)}</p>` : ''}
        ${falsifier ? `<div class="falsifier">${u.escape(falsifier)}</div>` : ''}
        ${meta && meta.lastUpdated ? `<div class="meta-row"><span>Run</span><span>${u.escape(meta.lastUpdated)}</span></div>` : ''}
      </aside>
    `;

    section.innerHTML = `
      <div>
        <div class="kicker ${kickerCls}">${u.escape(kickerText)}</div>
        <h1>${u.escape(headline)}</h1>
        ${deck ? `<p class="deck">${u.escape(deck)}</p>` : ''}
        <div class="lead-body">${bodyHtml}</div>
        <div class="lead-chart">
          <div id="btc-chart"></div>
        </div>
      </div>
      ${sidebar}
    `;
  }

  window.PulseLead = { render };
})();
