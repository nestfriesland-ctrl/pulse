// PULSE — Wiki renderer + sensor dashboard
// Zero dependencies (d3 + marked from CDN)

const API = '/api/wiki';
let tree = null;
let cache = {};
const SENSORS = ['market', 'derivatives', 'watchlist', 'nest-seo', 'infra', 'enrichment', 'anti-fragile'];

// --- API layer ---

async function fetchTree() {
  if (tree) return tree;
  const r = await fetch(`${API}?path=_tree`);
  if (!r.ok) throw new Error('Failed to load wiki tree');
  const data = await r.json();
  tree = data.tree ? data.tree.filter(f => f.type === 'blob' && f.path.endsWith('.md')) : [];
  return tree;
}

async function fetchFile(path) {
  if (cache[path]) return cache[path];
  const r = await fetch(`${API}?path=${encodeURIComponent(path)}`);
  if (!r.ok) throw new Error(`Failed to load ${path}`);
  const data = await r.json();
  const content = data.decoded_content || (data.content ? atob(data.content) : '');
  cache[path] = content;
  return content;
}

// --- Sensor meta parsing ---

function parseSensorMeta(content) {
  const meta = { lastUpdated: null, hoursAgo: null, status: 'unknown', notDeployed: false };

  if (content.includes('NOT DEPLOYED')) {
    meta.notDeployed = true;
    return meta;
  }

  const tsMatch = content.match(/last_updated:\s*(.+)/);
  if (tsMatch) {
    meta.lastUpdated = tsMatch[1].trim();
    if (meta.lastUpdated === '—' || meta.lastUpdated === '-') {
      meta.notDeployed = true;
      return meta;
    }
    try {
      const dt = new Date(meta.lastUpdated);
      if (!isNaN(dt.getTime())) {
        meta.hoursAgo = Math.floor((Date.now() - dt.getTime()) / 3600000);
      }
    } catch (e) { /* invalid date */ }
  }

  if (meta.hoursAgo !== null) {
    meta.status = meta.hoursAgo < 4 ? 'fresh' : meta.hoursAgo < 12 ? 'stale' : 'down';
  }

  return meta;
}

// --- Sensor-specific parsers ---

function stripTags(s) {
  return s ? s.replace(/\s*\[[A-Z]+\]/g, '').trim() : s;
}

function colorClass(val) {
  if (!val) return '';
  return val.startsWith('-') ? 'neg' : 'pos';
}

function parseMarket(content) {
  const btcMatch = content.match(/BTC:\s*\$([0-9,]+)\s*\|\s*24h:\s*([+-][0-9.]+%)/);
  const ethMatch = content.match(/ETH:\s*\$([0-9,]+)\s*\|\s*24h:\s*([+-][0-9.]+%)/);
  const btcAthMatch = content.match(/BTC:.*?ATH[^|]*\|\s*(-[0-9.]+%)\s*van top/);
  const ethAthMatch = content.match(/ETH:.*?ATH[^|]*\|\s*(-[0-9.]+%)\s*van top/);
  const macroMatch = content.match(/Macro:\s*(.+)/);

  return {
    btcPrice: btcMatch ? btcMatch[1] : null,
    btc24h: btcMatch ? btcMatch[2] : null,
    ethPrice: ethMatch ? ethMatch[1] : null,
    eth24h: ethMatch ? ethMatch[2] : null,
    btcAthDist: btcAthMatch ? btcAthMatch[1] : null,
    ethAthDist: ethAthMatch ? ethAthMatch[1] : null,
    macro: macroMatch ? stripTags(macroMatch[1]) : null,
  };
}

function parseInfra(content) {
  const sitesMatch = content.match(/SITES:\s*(.+)/m);
  const deploysMatch = content.match(/DEPLOYS:\s*(.+)/m);
  const gitMatch = content.match(/GIT:\s*(.+)/m);
  const bridgeMatch = content.match(/M4-BRIDGE:\s*(.+)/m);

  const sites = [];
  if (sitesMatch) {
    for (const part of stripTags(sitesMatch[1]).split('|')) {
      const m = part.trim().match(/^(\S+)\s+(\d{3})$/);
      if (m) sites.push({ name: m[1], code: parseInt(m[2]) });
    }
  }

  const deploys = [];
  if (deploysMatch) {
    for (const part of stripTags(deploysMatch[1]).split('|')) {
      const m = part.trim().match(/^(\S+)\s+(\w+)$/);
      if (m) deploys.push({ name: m[1], status: m[2] });
    }
  }

  return {
    sites,
    deploys,
    git: gitMatch ? stripTags(gitMatch[1]) : null,
    bridge: bridgeMatch ? stripTags(bridgeMatch[1]) : null,
  };
}

function parseNestSeo(content) {
  const drMatch = content.match(/DR:\s*([0-9.]+)/);
  const refMatch = content.match(/Ref domains:\s*(\d+)\s*live/);
  const blMatch = content.match(/Backlinks:\s*(\d+)\s*live/);
  const trendMatch = content.match(/Trend:\s*(.+)/);

  const backlinkRows = [];
  const re = /^([^\s|]+)\s*\|\s*DR(\d+)\s*\|\s*(\d+)\s*dofollow\s*\|\s*([^\[]+)/gm;
  let m;
  while ((m = re.exec(content)) !== null) {
    backlinkRows.push({ domain: m[1], dr: m[2], count: m[3], date: m[4].trim() });
  }

  return {
    dr: drMatch ? drMatch[1] : null,
    refDomains: refMatch ? refMatch[1] : null,
    backlinks: blMatch ? blMatch[1] : null,
    backlinkRows: backlinkRows.slice(0, 5),
    trend: trendMatch ? stripTags(trendMatch[1]) : null,
  };
}

function parseDerivatives(content) {
  const regimeMatch = content.match(/Regime[:\s]+(\w+)/i);
  const frMatch = content.match(/^FR[:\s]+(.+)/im);
  const oiMatch = content.match(/^OI[:\s]+(.+)/im);
  const barMatch = content.match(/^BAR[:\s]+(.+)/im);
  const cascadeMatch = content.match(/[Cc]ascade[^:]*:\s*(.+)/);

  return {
    regime: regimeMatch ? regimeMatch[1].trim() : null,
    fr: frMatch ? stripTags(frMatch[1]) : null,
    oi: oiMatch ? stripTags(oiMatch[1]) : null,
    bar: barMatch ? stripTags(barMatch[1]) : null,
    cascade: cascadeMatch ? stripTags(cascadeMatch[1]) : null,
  };
}

function parseEnrichment(content) {
  const pendingMatch = content.match(/[Pp]ending[:\s]+(\d+)/);
  const completeMatch = content.match(/[Cc]omplete[:\s]+(\d+)/);
  const errorMatch = content.match(/[Ee]rrors?[:\s]+(\d+)/);

  return {
    pending: pendingMatch ? pendingMatch[1] : null,
    complete: completeMatch ? completeMatch[1] : null,
    errors: errorMatch ? errorMatch[1] : null,
  };
}

function parseWatchlist(content) {
  const assets = [];
  // Match table data rows (skip header Asset row and separator ---)
  const tableRe = /^\|\s*([A-Z]+)\s*\|\s*(\S+)\s*\|\s*([+-][0-9.]+%|—|-)\s*\|\s*(\S+)\s*\|\s*(\S+)\s*\|\s*([0-9,.\-]+|—|-)\s*\|/gm;
  let m;
  while ((m = tableRe.exec(content)) !== null) {
    if (m[1] === 'Asset') continue; // skip header row
    const deltaStr = m[3];
    const deltaNum = parseFloat(deltaStr.replace('%', '').replace('+', ''));
    assets.push({
      asset: m[1],
      price: m[2],
      delta: deltaStr,
      deltaNum: isNaN(deltaNum) ? 0 : deltaNum,
      high: m[4],
      low: m[5],
      volume: m[6],
    });
  }

  const signals = [];
  const signalsMatch = content.match(/## Signalen\n([\s\S]*?)(?:\n##|$)/);
  if (signalsMatch) {
    for (const line of signalsMatch[1].split('\n')) {
      const s = line.replace(/^-\s*/, '').trim();
      if (s) signals.push(s);
    }
  }

  return { assets, signals };
}

function parseAntiFrag(content) {
  const cycleMatch = content.match(/[Cc]ycle[:\s#*]+([^\n]+)/);
  const hypothesisMatch = content.match(/[Hh]ypothes[ie]s[:\s]+([^\n]+)/);
  const statusMatch = content.match(/[Ss]tatus[:\s]+([^\n]+)/);
  const edgesMatch = content.match(/[Ee]dges?[:\s]+([^\n]+)/);

  return {
    cycle: cycleMatch ? cycleMatch[1].trim() : null,
    hypothesis: hypothesisMatch ? hypothesisMatch[1].trim() : null,
    status: statusMatch ? statusMatch[1].trim() : null,
    edges: edgesMatch ? edgesMatch[1].trim() : null,
  };
}

// --- Card renderers ---

function renderMarketCard(content) {
  const d = parseMarket(content);
  if (!d.btcPrice) return '<div class="card-waiting">Geen data</div>';

  return `
    <div class="market-primary">
      <div class="market-main">
        <div class="market-ticker">BTC</div>
        <div class="market-price">$${d.btcPrice}</div>
        <div class="market-change ${colorClass(d.btc24h)}">${d.btc24h}</div>
      </div>
      ${d.btcAthDist ? `<div class="market-ath-block">
        <div class="ath-label">van ATH</div>
        <div class="ath-value ${colorClass(d.btcAthDist)}">${d.btcAthDist}</div>
      </div>` : ''}
    </div>
    <div class="market-divider"></div>
    <div class="market-alt">
      ${d.ethPrice ? `<div class="market-alt-row">
        <span class="alt-ticker">ETH</span>
        <span class="alt-price">$${d.ethPrice}</span>
        <span class="alt-change ${colorClass(d.eth24h)}">${d.eth24h}</span>
        ${d.ethAthDist ? `<span class="alt-ath ${colorClass(d.ethAthDist)}">${d.ethAthDist}</span>` : ''}
      </div>` : ''}
    </div>
    ${d.macro ? `<div class="market-macro">${d.macro}</div>` : ''}
  `;
}

function renderDerivativesCard(content) {
  const d = parseDerivatives(content);

  const regimeClass = d.regime === 'UP' ? 'regime-up'
    : d.regime === 'DOWN' ? 'regime-down'
    : d.regime ? 'regime-sideways'
    : 'regime-unknown';

  return `
    <div class="deriv-primary">
      <span class="regime-badge ${regimeClass}">${d.regime || '—'}</span>
    </div>
    <div class="deriv-stats">
      ${d.fr ? `<div class="deriv-stat"><div class="deriv-label">FR</div><div class="deriv-value">${d.fr}</div></div>` : ''}
      ${d.oi ? `<div class="deriv-stat"><div class="deriv-label">OI</div><div class="deriv-value">${d.oi}</div></div>` : ''}
      ${d.bar ? `<div class="deriv-stat"><div class="deriv-label">BAR</div><div class="deriv-value">${d.bar}</div></div>` : ''}
      ${d.cascade ? `<div class="deriv-stat"><div class="deriv-label">CASCADE</div><div class="deriv-value">${d.cascade}</div></div>` : ''}
    </div>
  `;
}

function renderNestSeoCard(content) {
  const d = parseNestSeo(content);

  const tableRows = d.backlinkRows.map(row => {
    const drNum = parseInt(row.dr);
    const drClass = drNum >= 70 ? 'dr-high' : drNum >= 30 ? 'dr-mid' : 'dr-low';
    return `<tr>
      <td class="bl-domain">${row.domain}</td>
      <td class="bl-dr ${drClass}">${row.dr}</td>
      <td class="bl-count">${row.count}</td>
      <td class="bl-date">${row.date}</td>
    </tr>`;
  }).join('');

  return `
    <div class="seo-layout">
      <div class="seo-left">
        <div class="seo-dr-block">
          <div class="seo-dr-value">${d.dr || '—'}</div>
          <div class="seo-dr-label">Domain Rating</div>
        </div>
        <div class="seo-kpis">
          <div class="seo-kpi">
            <div class="seo-kpi-value">${d.refDomains || '—'}</div>
            <div class="seo-kpi-label">ref domains</div>
          </div>
          <div class="seo-kpi">
            <div class="seo-kpi-value">${d.backlinks || '—'}</div>
            <div class="seo-kpi-label">backlinks</div>
          </div>
        </div>
        ${d.trend ? `<div class="seo-trend">${d.trend}</div>` : ''}
      </div>
      ${tableRows ? `<div class="seo-right">
        <div class="seo-table-label">Nieuwe backlinks (7d)</div>
        <table class="seo-table">
          <thead><tr><th>Domain</th><th>DR</th><th>#</th><th>Datum</th></tr></thead>
          <tbody>${tableRows}</tbody>
        </table>
      </div>` : ''}
    </div>
  `;
}

function renderInfraCard(content) {
  const d = parseInfra(content);

  const sitesDots = d.sites.map(s => {
    const ok = s.code >= 200 && s.code < 400;
    return `<div class="dot-row">
      <span class="dot ${ok ? 'dot-green' : 'dot-red'}"></span>
      <span class="dot-name">${s.name}</span>
      <span class="dot-code">${s.code}</span>
    </div>`;
  }).join('');

  const deployDots = d.deploys.map(dep => {
    const ok = dep.status === 'READY';
    return `<div class="dot-row">
      <span class="dot ${ok ? 'dot-green' : 'dot-red'}"></span>
      <span class="dot-name">${dep.name}</span>
    </div>`;
  }).join('');

  return `
    ${sitesDots ? `<div class="infra-section">
      <div class="infra-label">SITES</div>
      <div class="infra-dots">${sitesDots}</div>
    </div>` : ''}
    ${deployDots ? `<div class="infra-section">
      <div class="infra-label">DEPLOYS</div>
      <div class="infra-dots">${deployDots}</div>
    </div>` : ''}
    ${d.git ? `<div class="infra-meta"><span class="infra-meta-key">GIT</span> ${d.git}</div>` : ''}
    ${d.bridge ? `<div class="infra-meta"><span class="infra-meta-key">BRIDGE</span> ${d.bridge}</div>` : ''}
  `;
}

function renderEnrichmentCard(content) {
  const d = parseEnrichment(content);

  return `
    <div class="enrichment-counts">
      <div class="e-count">
        <div class="e-value yellow">${d.pending || '—'}</div>
        <div class="e-label">pending</div>
      </div>
      <div class="e-count">
        <div class="e-value green">${d.complete || '—'}</div>
        <div class="e-label">complete</div>
      </div>
      <div class="e-count">
        <div class="e-value red">${d.errors || '—'}</div>
        <div class="e-label">errors</div>
      </div>
    </div>
  `;
}

function renderWatchlistCard(content) {
  const d = parseWatchlist(content);
  if (!d.assets.length) return '<div class="card-waiting">Geen data</div>';

  const rows = d.assets.map(a => {
    const cls = a.deltaNum > 0 ? 'pos' : a.deltaNum < 0 ? 'neg' : '';
    const hot = Math.abs(a.deltaNum) >= 5 ? ' wl-hot' : '';
    return `<tr class="${hot.trim()}">
      <td class="wl-asset">${a.asset}</td>
      <td class="wl-price">${a.price}</td>
      <td class="wl-delta ${cls}">${a.delta}</td>
      <td class="wl-hl">${a.high}</td>
      <td class="wl-hl">${a.low}</td>
      <td class="wl-vol">${a.volume}</td>
    </tr>`;
  }).join('');

  const signalsHtml = d.signals.length
    ? `<div class="wl-signals">${d.signals.map(s => `<span class="wl-signal">${s}</span>`).join('')}</div>`
    : '';

  return `
    <div class="wl-layout">
      <table class="wl-table">
        <thead><tr>
          <th>Asset</th><th>Prijs</th><th>24h</th><th>High</th><th>Low</th><th>Vol</th>
        </tr></thead>
        <tbody>${rows}</tbody>
      </table>
      ${signalsHtml}
    </div>
  `;
}

function renderAntiFragCard(content) {
  const d = parseAntiFrag(content);

  return `
    <div class="af-content">
      ${d.cycle ? `<div class="af-cycle">Cycle ${d.cycle}</div>` : ''}
      ${d.hypothesis ? `<div class="af-hypothesis">${d.hypothesis}</div>` : ''}
      ${d.status ? `<div class="af-status">${d.status}</div>` : ''}
      ${d.edges ? `<div class="af-edges">Edges: ${d.edges}</div>` : ''}
    </div>
  `;
}

const RENDERERS = {
  'market': renderMarketCard,
  'derivatives': renderDerivativesCard,
  'watchlist': renderWatchlistCard,
  'nest-seo': renderNestSeoCard,
  'infra': renderInfraCard,
  'enrichment': renderEnrichmentCard,
  'anti-fragile': renderAntiFragCard,
};

// --- Dashboard ---

async function renderDashboard() {
  const grid = document.getElementById('sensor-grid');
  grid.innerHTML = SENSORS.map(name => `
    <div class="sensor-card" data-sensor="${name}">
      <div class="sensor-header">
        <span class="sensor-name">${name}</span>
        <span class="sensor-badge badge-down" id="badge-${name}">…</span>
      </div>
      <div class="sensor-body" id="body-${name}"><div class="loading-text">laden…</div></div>
    </div>
  `).join('');

  grid.querySelectorAll('.sensor-card').forEach(card => {
    card.addEventListener('click', () => navigate(`doc/sensors/${card.dataset.sensor}.md`));
  });

  await Promise.allSettled(SENSORS.map(async name => {
    try {
      const content = await fetchFile(`sensors/${name}.md`);
      const meta = parseSensorMeta(content);
      const badge = document.getElementById(`badge-${name}`);
      const body = document.getElementById(`body-${name}`);

      if (meta.notDeployed) {
        badge.textContent = '–';
        badge.className = 'sensor-badge badge-pending';
        body.innerHTML = '<div class="card-waiting">Wacht op data</div>';
        return;
      }

      if (meta.hoursAgo !== null) {
        badge.textContent = `${meta.hoursAgo}h`;
        badge.className = `sensor-badge badge-${meta.status}`;
      } else {
        badge.textContent = 'ERR';
        badge.className = 'sensor-badge badge-down';
      }

      const renderer = RENDERERS[name];
      if (renderer) body.innerHTML = renderer(content, meta);
    } catch (e) {
      const badge = document.getElementById(`badge-${name}`);
      const body = document.getElementById(`body-${name}`);
      if (badge) { badge.textContent = 'ERR'; badge.className = 'sensor-badge badge-down'; }
      if (body) body.innerHTML = '<div class="card-waiting">Laad fout</div>';
    }
  }));
}

// --- Document view ---

async function renderDocument(path) {
  const bc = document.getElementById('breadcrumb');
  const parts = path.split('/');
  bc.innerHTML = '<a href="#dashboard">dashboard</a> / ' +
    parts.map((p, i) => {
      if (i < parts.length - 1) return `<span>${p}</span>`;
      return `<strong style="color:var(--text)">${p}</strong>`;
    }).join(' / ');

  const contentEl = document.getElementById('document-content');
  const metaEl = document.getElementById('document-meta');

  try {
    const content = await fetchFile(path);
    contentEl.innerHTML = marked.parse(content);

    contentEl.querySelectorAll('a[href]').forEach(a => {
      const href = a.getAttribute('href');
      if (href && !href.startsWith('http') && href.endsWith('.md')) {
        a.addEventListener('click', e => {
          e.preventDefault();
          const dir = path.substring(0, path.lastIndexOf('/') + 1);
          const resolved = href.startsWith('/') ? href.slice(1) : dir + href;
          navigate(`doc/${resolved}`);
        });
      }
    });

    const lines = content.split('\n').length;
    metaEl.textContent = `${lines} lines | ${path}`;
  } catch (e) {
    contentEl.innerHTML = `<p style="color:var(--red)">Failed to load ${path}</p>`;
    metaEl.textContent = '';
  }
}

// --- Graph view ---

async function renderGraph() {
  if (!tree) await fetchTree();

  const container = document.getElementById('graph-container');
  container.innerHTML = '';

  const width = container.clientWidth;
  const height = container.clientHeight || window.innerHeight - 60;

  const inLinks = {};
  const nodes = tree.map(f => {
    inLinks[f.path] = 0;
    return {
      id: f.path,
      name: f.path.split('/').pop().replace('.md', ''),
      group: f.path.includes('/') ? f.path.split('/')[0] : 'root'
    };
  });
  const nodeSet = new Set(nodes.map(n => n.id));

  const links = [];
  const seen = new Set();
  for (const [filePath, content] of Object.entries(cache)) {
    if (!nodeSet.has(filePath)) continue;
    const re = /\[([^\]]*)\]\(([^)]+\.md)\)/g;
    let m;
    while ((m = re.exec(content)) !== null) {
      let target = m[2].replace(/^\.\//, '');
      if (!target.includes('/')) {
        const dir = filePath.substring(0, filePath.lastIndexOf('/') + 1);
        target = dir + target;
      }
      if (nodeSet.has(target)) {
        const key = `${filePath}->${target}`;
        if (!seen.has(key)) {
          seen.add(key);
          links.push({ source: filePath, target });
          inLinks[target] = (inLinks[target] || 0) + 1;
        }
      }
    }
  }

  nodes.forEach(n => { n.radius = 5 + (inLinks[n.id] || 0) * 2; });

  const colors = {
    sensors: '#22c55e',
    prompts: '#eab308',
    operations: '#ef4444',
    'domain-knowledge': '#3b82f6',
    repos: '#8b5cf6',
    'api-references': '#06b6d4',
    bin: '#6b7280',
    root: '#9ca3af'
  };

  const svg = d3.select(container).append('svg')
    .attr('width', width)
    .attr('height', height);

  const tooltip = document.getElementById('tooltip');

  const sim = d3.forceSimulation(nodes)
    .force('link', d3.forceLink(links).id(d => d.id).distance(100))
    .force('charge', d3.forceManyBody().strength(-250))
    .force('center', d3.forceCenter(width / 2, height / 2))
    .force('collision', d3.forceCollide().radius(d => d.radius + 10));

  const link = svg.append('g').selectAll('line').data(links).join('line')
    .attr('class', 'link');

  const node = svg.append('g').selectAll('g').data(nodes).join('g')
    .attr('class', 'node')
    .call(d3.drag()
      .on('start', (e, d) => {
        if (!e.active) sim.alphaTarget(0.3).restart();
        d.fx = d.x; d.fy = d.y;
      })
      .on('drag', (e, d) => { d.fx = e.x; d.fy = e.y; })
      .on('end', (e, d) => {
        if (!e.active) sim.alphaTarget(0);
        d.fx = null; d.fy = null;
      })
    );

  node.append('circle')
    .attr('r', d => d.radius)
    .attr('fill', d => colors[d.group] || '#666');

  node.append('text')
    .attr('dx', d => d.radius + 4)
    .attr('dy', 4)
    .text(d => d.name);

  node.on('mouseover', (e, d) => {
    tooltip.style.display = 'block';
    tooltip.innerHTML = `<strong>${d.name}</strong><br><span style="color:#888">${d.id}</span>`;
    tooltip.style.left = (e.pageX + 12) + 'px';
    tooltip.style.top = (e.pageY - 12) + 'px';
  })
  .on('mousemove', e => {
    tooltip.style.left = (e.pageX + 12) + 'px';
    tooltip.style.top = (e.pageY - 12) + 'px';
  })
  .on('mouseout', () => { tooltip.style.display = 'none'; })
  .on('click', (e, d) => navigate(`doc/${d.id}`));

  sim.on('tick', () => {
    link
      .attr('x1', d => d.source.x).attr('y1', d => d.source.y)
      .attr('x2', d => d.target.x).attr('y2', d => d.target.y);
    node.attr('transform', d => `translate(${d.x},${d.y})`);
  });
}

// --- Router ---

function navigate(hash) {
  window.location.hash = hash;
}

function handleRoute() {
  const hash = window.location.hash.slice(1) || 'dashboard';

  document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
  document.querySelectorAll('.nav-links a').forEach(a => a.classList.remove('active'));

  if (hash === 'dashboard') {
    document.getElementById('dashboard-view').classList.add('active');
    document.querySelector('[data-view="dashboard"]').classList.add('active');
  } else if (hash === 'graph') {
    document.getElementById('graph-view').classList.add('active');
    document.querySelector('[data-view="graph"]').classList.add('active');
    renderGraph();
  } else if (hash.startsWith('doc/')) {
    document.getElementById('document-view').classList.add('active');
    renderDocument(hash.slice(4));
  }
}

document.querySelectorAll('.nav-links a').forEach(a => {
  a.addEventListener('click', e => {
    e.preventDefault();
    navigate(a.dataset.view);
  });
});

window.addEventListener('hashchange', handleRoute);

// --- Init ---

async function init() {
  try {
    await fetchTree();
    await renderDashboard();
    handleRoute();
  } catch (e) {
    document.getElementById('sensor-grid').innerHTML =
      '<p class="loading">Failed to connect to wiki API. Check GITHUB_PAT env var.</p>';
  }

  setInterval(async () => {
    cache = {};
    tree = null;
    try {
      await fetchTree();
      if (document.getElementById('dashboard-view').classList.contains('active')) {
        await renderDashboard();
      }
    } catch (e) { /* silent refresh failure */ }
  }, 300000);
}

init();
