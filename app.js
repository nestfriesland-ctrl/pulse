// PULSE — Wiki renderer + sensor dashboard
// Zero dependencies (d3 + marked from CDN)

const API = '/api/wiki';
let tree = null;
let cache = {};
const SENSORS = ['market', 'derivatives', 'infra', 'nest-seo', 'enrichment', 'anti-fragile'];

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

// --- Sensor parsing ---

function parseSensorMeta(content) {
  const meta = { lastUpdated: null, hoursAgo: null, status: 'unknown', preview: '' };

  const tsMatch = content.match(/last_updated:\s*(.+)/);
  if (tsMatch) {
    meta.lastUpdated = tsMatch[1].trim();
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

  const lines = content.split('\n')
    .filter(l => l.trim() && !l.startsWith('#') && !l.startsWith('>') && !l.startsWith('---'));
  meta.preview = lines.slice(0, 4).join('\n');

  return meta;
}

// --- Dashboard ---

async function renderDashboard() {
  const grid = document.getElementById('sensor-grid');
  grid.innerHTML = SENSORS.map(name => `
    <div class="sensor-card" data-sensor="${name}">
      <div class="sensor-header">
        <span class="sensor-name">${name}</span>
        <span class="sensor-badge badge-down" id="badge-${name}">...</span>
      </div>
      <div class="sensor-time" id="time-${name}">loading...</div>
      <div class="sensor-preview" id="preview-${name}"></div>
    </div>
  `).join('');

  // Click handlers
  grid.querySelectorAll('.sensor-card').forEach(card => {
    card.addEventListener('click', () => navigate(`doc/sensors/${card.dataset.sensor}.md`));
  });

  // Load sensor data in parallel
  await Promise.allSettled(SENSORS.map(async name => {
    try {
      const content = await fetchFile(`sensors/${name}.md`);
      const meta = parseSensorMeta(content);

      const badge = document.getElementById(`badge-${name}`);
      const time = document.getElementById(`time-${name}`);
      const preview = document.getElementById(`preview-${name}`);

      if (meta.hoursAgo !== null) {
        badge.textContent = `${meta.hoursAgo}h`;
        badge.className = `sensor-badge badge-${meta.status}`;
      } else {
        badge.textContent = 'TODO';
        badge.className = 'sensor-badge badge-down';
      }
      time.textContent = meta.lastUpdated || 'no data yet';
      preview.textContent = meta.preview || 'awaiting first sensor run';
    } catch (e) {
      document.getElementById(`badge-${name}`).textContent = 'ERR';
      document.getElementById(`badge-${name}`).className = 'sensor-badge badge-down';
      document.getElementById(`time-${name}`).textContent = 'failed to load';
    }
  }));
}

// --- Document view ---

async function renderDocument(path) {
  const bc = document.getElementById('breadcrumb');
  const parts = path.split('/');
  bc.innerHTML = '<a href="#dashboard">dashboard</a> / ' +
    parts.map((p, i) => {
      if (i < parts.length - 1) {
        return `<span>${p}</span>`;
      }
      return `<strong style="color:var(--text)">${p}</strong>`;
    }).join(' / ');

  const contentEl = document.getElementById('document-content');
  const metaEl = document.getElementById('document-meta');

  try {
    const content = await fetchFile(path);
    contentEl.innerHTML = marked.parse(content);

    // Intercept internal .md links
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

  // Build nodes
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

  // Parse links from cached content
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

// Nav links
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

  // Auto-refresh every 5 minutes
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
