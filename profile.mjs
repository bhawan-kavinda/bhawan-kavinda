#!/usr/bin/env node
// Generates profile SVGs and README.md from GitHub repository data.
// Private repositories are only ever counted or aggregated. Their names,
// descriptions and links are never written to any output file.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const API = 'https://api.github.com';

/* ---------- helpers ---------- */

export const esc = (s) =>
  String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
export const num = (n) => Number(n).toLocaleString('en-US');
const isSet = (v) => typeof v === 'string' && v.trim() !== '' && !v.startsWith('YOUR_');

const LANG_COLORS = {
  JavaScript: '#f1e05a', TypeScript: '#3178c6', Python: '#3572A5', HTML: '#e34c26', CSS: '#563d7c',
  Java: '#b07219', PHP: '#4F5D95', Shell: '#89e051', Kotlin: '#A97BFF', Dart: '#00B4AB', Go: '#00ADD8',
  'C++': '#f34b7d', C: '#555555', 'C#': '#178600', Ruby: '#701516', Rust: '#dea584', Vue: '#41b883',
  SCSS: '#c6538c', Swift: '#F05138',
};
const PALETTE = ['#3f74d6', '#ff8a1f', '#3DDC84', '#a78bfa', '#f472b6', '#22d3ee', '#facc15'];
const FONT = "'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif";

/* ---------- GitHub client ---------- */

export function makeClient(token) {
  const headers = {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'profile-generator',
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  return {
    async rest(p) {
      const res = await fetch(API + p, { headers });
      if (!res.ok) throw new Error(`GET ${p} failed: ${res.status}`);
      return res.json();
    },
    async gql(query, variables) {
      const res = await fetch(API + '/graphql', {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ query, variables }),
      });
      if (!res.ok) throw new Error(`GraphQL failed: ${res.status}`);
      const json = await res.json();
      if (json.errors) throw new Error(json.errors.map((e) => e.message).join('; '));
      return json.data;
    },
  };
}

export async function fetchRepos(api, login, hasPat) {
  const out = [];
  for (let page = 1; page <= 10; page++) {
    const p = hasPat
      ? `/user/repos?affiliation=owner&visibility=all&per_page=100&page=${page}`
      : `/users/${login}/repos?type=owner&per_page=100&page=${page}`;
    const batch = await api.rest(p);
    out.push(...batch);
    if (batch.length < 100) break;
  }
  return out.filter((r) => r.owner && r.owner.login.toLowerCase() === login.toLowerCase());
}

export async function fetchLanguages(api, repos, exclude = []) {
  const skip = new Set(exclude.map((s) => s.toLowerCase()));
  const totals = {};
  const queue = repos.filter((r) => !r.fork);
  const worker = async () => {
    while (queue.length) {
      const r = queue.shift();
      try {
        const langs = await api.rest(`/repos/${r.full_name}/languages`);
        for (const [k, v] of Object.entries(langs)) {
          if (!skip.has(k.toLowerCase())) totals[k] = (totals[k] || 0) + v;
        }
      } catch { /* skip repos that cannot be read */ }
    }
  };
  await Promise.all([worker(), worker(), worker(), worker(), worker()]);
  return totals;
}

const CONTRIB_QUERY = `query($login:String!){
  user(login:$login){
    contributionsCollection{
      totalCommitContributions
      totalPullRequestContributions
      totalIssueContributions
      contributionCalendar{ totalContributions weeks{ contributionDays{ date contributionCount } } }
    }
  }
}`;

export async function fetchContributions(api, login) {
  const data = await api.gql(CONTRIB_QUERY, { login });
  const c = data.user.contributionsCollection;
  const days = c.contributionCalendar.weeks
    .flatMap((w) => w.contributionDays)
    .map((d) => ({ date: d.date, count: d.contributionCount }))
    .sort((a, b) => a.date.localeCompare(b.date));
  return {
    total: c.contributionCalendar.totalContributions,
    commits: c.totalCommitContributions,
    prs: c.totalPullRequestContributions,
    issues: c.totalIssueContributions,
    days,
  };
}

/* ---------- data processing ---------- */

export function streaks(days) {
  let longest = 0, run = 0;
  for (const d of days) {
    if (d.count > 0) { run++; longest = Math.max(longest, run); } else run = 0;
  }
  let i = days.length - 1;
  if (i >= 0 && days[i].count === 0) i--; // today may not have activity yet
  let current = 0;
  while (i >= 0 && days[i].count > 0) { current++; i--; }
  return { current, longest };
}

export function repoStats(repos, hasPat) {
  const pub = repos.filter((r) => !r.private);
  const own = pub.filter((r) => !r.fork);
  return {
    publicCount: pub.length,
    privateCount: hasPat ? repos.filter((r) => r.private).length : null,
    stars: own.reduce((a, r) => a + r.stargazers_count, 0),
    forks: own.reduce((a, r) => a + r.forks_count, 0),
  };
}

export function pickFeatured(repos, cfg = {}, login = '', now = Date.now()) {
  const ex = new Set([...(cfg.exclude || []), login].map((s) => s.toLowerCase()));
  const pool = repos.filter((r) => !r.private && !r.fork && !r.archived && !ex.has(r.name.toLowerCase()));
  const pinned = (cfg.pin || [])
    .map((n) => pool.find((r) => r.name.toLowerCase() === n.toLowerCase()))
    .filter(Boolean);
  const score = (r) => {
    const days = (now - new Date(r.pushed_at).getTime()) / 864e5;
    return (
      r.stargazers_count * 4 + r.forks_count * 3 + 20 * Math.exp(-days / 90) +
      (r.description ? 6 : 0) + Math.min((r.topics || []).length, 5) * 0.6
    );
  };
  const rest = pool.filter((r) => !pinned.includes(r)).sort((a, b) => score(b) - score(a));
  return [...pinned, ...rest].slice(0, cfg.count || 4);
}

export function topTopics(repos, limit = 12) {
  const freq = {};
  for (const r of repos.filter((x) => !x.private && !x.fork)) {
    for (const t of r.topics || []) freq[t] = (freq[t] || 0) + 1;
  }
  return Object.entries(freq).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, limit).map((e) => e[0]);
}

export function languageShares(totals, top = 6) {
  const entries = Object.entries(totals).sort((a, b) => b[1] - a[1]);
  const sum = entries.reduce((a, e) => a + e[1], 0);
  if (!sum) return [];
  const shown = entries.slice(0, top).map(([name, bytes]) => ({ name, pct: (bytes / sum) * 100 }));
  const other = entries.slice(top).reduce((a, e) => a + e[1], 0);
  if (other) shown.push({ name: 'Other', pct: (other / sum) * 100 });
  return shown.map((s, i) => ({ ...s, color: LANG_COLORS[s.name] || (s.name === 'Other' ? '#6b7a99' : PALETTE[i % PALETTE.length]) }));
}

/* ---------- SVG builders ---------- */

const BG_DEFS = `<defs>
  <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#0f1115"/><stop offset="1" stop-color="#1a2233"/></linearGradient>
  <linearGradient id="ln" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#3f74d6"/><stop offset="0.5" stop-color="#ff8a1f"/><stop offset="1" stop-color="#3DDC84"/></linearGradient>
</defs>`;

export function headerSvg({ headline, name, roles }) {
  const n = roles.length;
  const D = 3, T = n * D, vis = 100 / n;
  const animated = n > 1;
  let seed = 7;
  const rnd = () => ((seed = (seed * 9301 + 49297) % 233280) / 233280);
  const stars = Array.from({ length: 16 }, (_, i) =>
    `<circle class="s" cx="${(300 + rnd() * 580).toFixed(0)}" cy="${(18 + rnd() * 224).toFixed(0)}" r="${(1 + rnd() * 1.4).toFixed(1)}" fill="#e6eeff" style="animation-delay:${(i * 0.37).toFixed(2)}s"/>`
  ).join('');
  const roleEls = roles.map((r, i) =>
    `<text class="r r${i}" x="240" y="186" font-size="22" fill="#9fb4d9" ${animated ? `style="animation-delay:${i * D}s"` : 'style="opacity:1"'}>${esc(r)}</text>`
  ).join('');
  const css = `<style>
  .s{animation:tw 3.2s ease-in-out infinite;opacity:.2}
  @keyframes tw{0%,100%{opacity:.15}50%{opacity:.9}}
  ${animated ? `.r{opacity:0;animation:cyc ${T}s infinite}
  @keyframes cyc{0%{opacity:0;transform:translateY(8px)}3%{opacity:1;transform:translateY(0)}${(vis - 3).toFixed(2)}%{opacity:1;transform:translateY(0)}${vis.toFixed(2)}%{opacity:0;transform:translateY(-8px)}100%{opacity:0}}
  @media (prefers-reduced-motion: reduce){.r,.s{animation:none}.r{opacity:0}.r0{opacity:1}.s{opacity:.4}}` : ''}
</style>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 900 260" width="900" height="260" role="img" aria-labelledby="t" font-family="${FONT}">
<title id="t">${esc(name)} - ${esc(headline)}</title>
${BG_DEFS}
${css}
<rect width="900" height="260" rx="20" fill="url(#bg)"/>
${stars}
<g fill="none" stroke="url(#ln)" stroke-width="5" stroke-linecap="round" stroke-linejoin="round">
  <path d="M92 95 L52 130 L92 165"/><path d="M148 95 L188 130 L148 165"/><path d="M132 87 L108 173"/>
</g>
<text x="242" y="84" font-size="14" font-weight="700" letter-spacing="3" fill="#ff8a1f">${esc(headline.toUpperCase())}</text>
<text x="240" y="140" font-size="48" font-weight="700" fill="#ffffff">${esc(name)}</text>
${roleEls}
<rect x="242" y="208" width="120" height="3" rx="1.5" fill="url(#ln)"/>
</svg>`;
}

export function statsSvg(tiles, updated) {
  const cols = 4, tw = 204, th = 92, gap = 16, x0 = 18, y0 = 78;
  const rows = Math.ceil(tiles.length / cols);
  const H = y0 + rows * th + (rows - 1) * gap + 40;
  const cells = tiles.map((t, i) => {
    const x = x0 + (i % cols) * (tw + gap), y = y0 + Math.floor(i / cols) * (th + gap);
    return `<g>
  <rect x="${x}" y="${y}" width="${tw}" height="${th}" rx="14" fill="#151b28" stroke="${t.color}" stroke-opacity="0.5"/>
  <rect x="${x + 16}" y="${y}" width="36" height="4" rx="2" fill="${t.color}"/>
  <text x="${x + 18}" y="${y + 52}" font-size="30" font-weight="700" fill="#ffffff">${esc(t.value)}</text>
  <text x="${x + 18}" y="${y + 74}" font-size="13" fill="#9fb4d9">${esc(t.label)}</text>
</g>`;
  }).join('\n');
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 900 ${H}" width="900" height="${H}" role="img" aria-labelledby="t" font-family="${FONT}">
<title id="t">Repository and contribution statistics</title>
${BG_DEFS}
<rect width="900" height="${H}" rx="20" fill="url(#bg)"/>
<text x="24" y="44" font-size="20" font-weight="700" fill="#ffffff">Activity</text>
<text x="24" y="64" font-size="12.5" fill="#9fb4d9">Contributions cover the last 12 months. Private repositories are counted only.</text>
<rect x="${900 - 24 - 120}" y="34" width="120" height="3" rx="1.5" fill="url(#ln)"/>
${cells}
<text x="24" y="${H - 16}" font-size="11.5" fill="#6b7a99">Updated ${esc(updated)} UTC</text>
</svg>`;
}

export function languagesSvg(shares) {
  const W = 900, barX = 24, barW = W - 48;
  const rows = Math.ceil(shares.length / 3);
  const H = shares.length ? 112 + rows * 30 + 20 : 120;
  let bar = '', legend = '';
  if (shares.length) {
    let x = barX;
    shares.forEach((s, i) => {
      const w = Math.max(2, (s.pct / 100) * barW);
      const first = i === 0, last = i === shares.length - 1;
      bar += `<rect x="${x.toFixed(1)}" y="72" width="${w.toFixed(1)}" height="14" fill="${s.color}" rx="${first || last ? 7 : 0}"/>`;
      x += w;
      const lx = barX + (i % 3) * 288, ly = 118 + Math.floor(i / 3) * 30;
      legend += `<circle cx="${lx + 6}" cy="${ly - 4}" r="6" fill="${s.color}"/>
<text x="${lx + 20}" y="${ly}" font-size="14" fill="#e6eeff">${esc(s.name)}</text>
<text x="${lx + 250}" y="${ly}" font-size="14" fill="#9fb4d9" text-anchor="end">${s.pct.toFixed(1)}%</text>`;
    });
  } else {
    legend = `<text x="24" y="90" font-size="14" fill="#9fb4d9">No language data yet.</text>`;
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-labelledby="t" font-family="${FONT}">
<title id="t">Most used languages</title>
${BG_DEFS}
<rect width="${W}" height="${H}" rx="20" fill="url(#bg)"/>
<text x="24" y="44" font-size="20" font-weight="700" fill="#ffffff">Most used languages</text>
<text x="24" y="62" font-size="12.5" fill="#9fb4d9">Share of code across owned repositories, forks excluded.</text>
${bar}
${legend}
</svg>`;
}

/* ---------- README rendering ---------- */

export function renderFeatured(list) {
  if (!list.length) return '<sub>No public projects yet.</sub>';
  const cell = (r) => {
    const meta = [r.language, r.stargazers_count ? `${r.stargazers_count} star${r.stargazers_count === 1 ? '' : 's'}` : null].filter(Boolean).map(esc).join(' &middot; ');
    return `  <td width="50%" valign="top">
    <a href="${r.html_url}"><b>${esc(r.name)}</b></a><br/>
    <sub>${esc(r.description || 'No description yet.')}</sub><br/>
    <sub>${meta}</sub>
  </td>`;
  };
  const rows = [];
  for (let i = 0; i < list.length; i += 2) {
    rows.push(`<tr>\n${cell(list[i])}\n${list[i + 1] ? cell(list[i + 1]) : '  <td width="50%"></td>'}\n</tr>`);
  }
  return `<table>\n${rows.join('\n')}\n</table>`;
}

export function renderTemplate(tpl, vars, links) {
  let out = tpl.replace(/<!--IF:(\w+)-->([\s\S]*?)<!--\/IF:\1-->/g, (_, key, body) => (isSet(links[key]) ? body : ''));
  out = out.replace(/\{\{(\w+)\}\}/g, (m, k) => (k in vars ? vars[k] : (isSet(links[k]) ? links[k] : m)));
  return out.replace(/\n[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n');
}

/* ---------- main ---------- */

export async function main() {
  const root = process.cwd();
  const cfg = JSON.parse(fs.readFileSync(path.join(root, 'profile.config.json'), 'utf8'));
  const tpl = fs.readFileSync(path.join(root, 'README.template.md'), 'utf8');
  const login = process.env.GITHUB_REPOSITORY_OWNER || cfg.username;
  const pat = process.env.PROFILE_TOKEN || '';
  const hasPat = Boolean(pat);
  const api = makeClient(pat || process.env.GITHUB_TOKEN || '');

  const repos = await fetchRepos(api, login, hasPat);
  const rs = repoStats(repos, hasPat);
  const langTotals = await fetchLanguages(api, repos, cfg.languages?.exclude);
  const shares = languageShares(langTotals, cfg.languages?.top || 6);

  let contrib = null;
  try { contrib = await fetchContributions(api, login); }
  catch (e) { console.warn('Contribution data unavailable:', e.message); }
  const st = contrib ? streaks(contrib.days) : null;

  const updated = new Date().toISOString().slice(0, 16).replace('T', ' ');
  const dash = 'n/a';
  const tiles = [
    { label: 'Public repositories', value: num(rs.publicCount), color: '#3f74d6' },
    { label: 'Private repositories', value: rs.privateCount === null ? dash : num(rs.privateCount), color: '#a78bfa' },
    { label: 'Stars earned', value: num(rs.stars), color: '#facc15' },
    { label: 'Forks of my repos', value: num(rs.forks), color: '#22d3ee' },
    { label: 'Contributions', value: contrib ? num(contrib.total) : dash, color: '#3DDC84' },
    { label: 'Pull requests', value: contrib ? num(contrib.prs) : dash, color: '#ff8a1f' },
    { label: 'Issues opened', value: contrib ? num(contrib.issues) : dash, color: '#f472b6' },
    { label: 'Current / longest streak', value: st ? `${st.current} / ${st.longest}` : dash, color: '#3DDC84' },
  ];

  const outDir = path.join(root, 'assets', 'generated');
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'header.svg'), headerSvg({ headline: cfg.headline, name: cfg.name || login, roles: cfg.roles?.length ? cfg.roles : ['Developer'] }));
  fs.writeFileSync(path.join(outDir, 'stats.svg'), statsSvg(tiles, updated));
  fs.writeFileSync(path.join(outDir, 'languages.svg'), languagesSvg(shares));

  const topLangs = shares.filter((s) => s.name !== 'Other').slice(0, 3).map((s) => s.name);
  const total = rs.publicCount + (rs.privateCount || 0);
  const autoLine = `**${total}** repositories (**${rs.publicCount}** public${rs.privateCount === null ? '' : `, **${rs.privateCount}** private`}).` +
    (topLangs.length ? ` Most used: ${topLangs.join(', ')}.` : '');
  const topics = topTopics(repos);
  const vars = {
    username: login,
    name: cfg.name || login,
    headline: cfg.headline,
    bio: cfg.bio === 'auto' ? (topLangs.length ? `Building with ${topLangs.join(', ')}.` : '') : cfg.bio,
    overview: (cfg.overview || []).map((l) => `- ${l}`).join('\n'),
    auto_line: autoLine,
    topics: topics.length ? topics.map((t) => `\`${t}\``).join(' ') : '',
    featured: renderFeatured(pickFeatured(repos, cfg.featured, login)),
    updated,
  };
  fs.writeFileSync(path.join(root, 'README.md'), renderTemplate(tpl, vars, cfg.links || {}));
  console.log(`Done: ${rs.publicCount} public, ${rs.privateCount ?? 'n/a'} private, ${shares.length} languages.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
