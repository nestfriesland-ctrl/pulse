// DUO — two-column section: watchlist | ma200.

(function () {
  const U = () => window.PulseUtil;

  function articleHtml(slot, kickerLabel) {
    const u = U();
    if (!slot) {
      return `<article><div class="kicker dim">geen data</div></article>`;
    }
    const { name, content, krant, regime } = slot;
    const kickerCls = u.regimeKickerClass(regime);
    const kickerText = regime
      ? `${kickerLabel} · ${u.shortenRegime(regime)}`
      : kickerLabel;
    const headline = (krant && krant.kop) || u.shapeHeadline(krant && krant.stelling)
      || u.fallbackHeadline(content)
      || u.titleize(name);
    const body = u.shapeTripleBody(krant && krant.les, krant && krant.actie, content);

    return `
      <article>
        <div class="kicker ${kickerCls}">${u.escape(kickerText)}</div>
        <h2>${u.escape(headline)}</h2>
        ${body}
      </article>
    `;
  }

  function render({ section, slots }) {
    if (!section) return;
    section.innerHTML = `
      ${articleHtml(slots.watchlist, 'Watchlist')}
      <div class="rule"></div>
      ${articleHtml(slots.ma200, 'MA200')}
    `;
  }

  window.PulseDuo = { render };
})();
