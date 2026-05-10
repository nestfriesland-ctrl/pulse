// TRIPLE — three-column section: confluence | macro-regime | anti-fragile.
// Each column is an editorial article with kicker, h2 (claim), byline, body.
// The macro column hosts the ETH/BTC ratio sparkline directly below its
// byline.

(function () {
  const U = () => window.PulseUtil;

  function articleHtml(slot, opts) {
    const u = U();
    if (!slot) {
      return `<article><div class="kicker dim">geen data</div></article>`;
    }
    const { name, content, krant, regime, meta, howell } = slot;
    const kickerCls = u.regimeKickerClass(regime);
    const kickerLabel = (opts && opts.kickerLabel) || u.titleize(name);
    const kickerText = regime
      ? `${kickerLabel} · ${u.shortenRegime(regime)}`
      : kickerLabel;
    const headline = (krant && krant.kop) || u.shapeHeadline(krant && krant.stelling)
      || u.fallbackHeadline(content)
      || u.titleize(name);
    const byline = u.extractByline(content) || '';
    const body = u.shapeTripleBody(krant && krant.les, krant && krant.actie, content);
    const sparkline = (opts && opts.sparkline)
      ? `<div class="macro-sparkline" id="${opts.sparkline}"></div>`
      : '';
    const stat = (opts && opts.stat)
      ? `<div class="stat"><span>${u.escape(opts.stat.label)}</span><span>${u.escape(opts.stat.value)}</span></div>`
      : '';
    const howellHtml = howellSubsectionHtml(howell, u);

    return `
      <article>
        <div class="kicker ${kickerCls}">${u.escape(kickerText)}</div>
        <h2>${u.escape(headline)}</h2>
        ${byline ? `<div class="byline">${u.escape(byline)}</div>` : ''}
        ${howellHtml}
        ${sparkline}
        ${body}
        ${stat}
      </article>
    `;
  }

  function howellSubsectionHtml(howell, u) {
    if (!howell) return '';
    const parts = [];
    if (howell.cyclePhase) {
      const label = howell.cycleLabel ? ` ${howell.cycleLabel.toLowerCase()}` : '';
      parts.push(`Howell fase ${howell.cyclePhase}${label}`);
    }
    if (howell.pbocDirection) parts.push(`PBoC ${howell.pbocDirection.toLowerCase()}`);
    if (howell.yieldCurveSignal) parts.push(`yield curve ${howell.yieldCurveSignal.toLowerCase()}`);
    if (!parts.length && !howell.summary) return '';
    const headline = parts.join(' · ');
    const upd = howell.lastHowellUpdate ? ` · upd ${howell.lastHowellUpdate}` : '';
    const head = headline
      ? `<div class="byline">${u.escape(headline + upd)}</div>`
      : '';
    const detail = howell.summary
      ? `<details><summary class="byline">Howell-samenvatting</summary><p>${u.escape(howell.summary)}</p></details>`
      : '';
    return head + detail;
  }

  function render({ section, slots }) {
    if (!section) return;
    // slots: { confluence, macro, antiFragile } where each is sensor-data
    // or null. Macro column gets the sparkline.
    section.innerHTML = `
      ${articleHtml(slots.confluence, { kickerLabel: 'Confluence' })}
      <div class="rule"></div>
      ${articleHtml(slots.macro, { kickerLabel: 'Macro', sparkline: 'ethbtc-sparkline' })}
      <div class="rule"></div>
      ${articleHtml(slots.antiFragile, { kickerLabel: 'Anti-fragile' })}
    `;
  }

  window.PulseTriple = { render };
})();
