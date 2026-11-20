// Campaign map UI (SVG). Relies on globals from client.js: $, send.
let campSel = null, lastCamp = null;
const SIDE = [['#b3262a', 'Red'], ['#2a4f9b', 'Blue']];
const UNIT_NAME = { sword: 'Shortsword Infantry', spear: 'Spear Phalanx', archer: 'Archers', cav: 'Heavy Cavalry' };
const esc = s => String(s).replace(/[&<>"]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));

function renderCamp(m) {
  lastCamp = m;
  const me = m.you, orders = m.phase === 'orders' && !m.ready[me] && m.winner === null;
  const myArmyAt = p => m.armies.find(a => a.owner === me && a.prov === p);
  const armyAt = (p, o) => m.armies.find(a => a.owner === o && a.prov === p);
  const selArmy = campSel !== null ? myArmyAt(campSel) : null;
  const svg = [];

  for (const [a, b] of m.edges) {
    const A = m.provs[a], B = m.provs[b];
    svg.push(`<line x1="${A.x}" y1="${A.y}" x2="${B.x}" y2="${B.y}" stroke="#6b5a36" stroke-width="3"/>`);
  }
  // pending move arrows
  for (const [aid, to] of Object.entries(m.moves)) {
    const a = m.armies.find(x => x.id === +aid); if (!a) continue;
    const A = m.provs[a.prov], B = m.provs[to];
    svg.push(`<line x1="${A.x}" y1="${A.y}" x2="${B.x}" y2="${B.y}" stroke="${SIDE[me][0]}" stroke-width="6" stroke-dasharray="10 8" marker-end="url(#ah)"/>`);
  }
  m.provs.forEach((p, i) => {
    const o = m.owner[i], fill = o < 0 ? '#6e6a5c' : SIDE[o][0];
    const reachable = orders && selArmy && selArmy.prov !== i && m.edges.some(e => (e[0] === selArmy.prov && e[1] === i) || (e[1] === selArmy.prov && e[0] === i));
    const cap = m.capital.includes(i);
    svg.push(`<g class="prov" data-p="${i}">
      <circle cx="${p.x}" cy="${p.y}" r="${cap ? 34 : 28}" fill="${fill}" stroke="${campSel === i ? '#7dff7d' : reachable ? '#ffe27a' : '#1b1712'}" stroke-width="${campSel === i || reachable ? 5 : 3}"/>
      ${cap ? `<text x="${p.x}" y="${p.y + 8}" text-anchor="middle" font-size="26" fill="#ffe9a8">★</text>` : ''}
      <text x="${p.x}" y="${p.y + (cap ? 54 : 48)}" text-anchor="middle" font-size="14" fill="#e9dfc8">${esc(p.name)}</text></g>`);
    [0, 1].forEach(side => {
      const a = armyAt(i, side); if (!a) return;
      const bx = p.x + (side === 0 ? -34 : 6), by = p.y - 50;
      svg.push(`<g pointer-events="none"><rect x="${bx}" y="${by}" width="30" height="22" rx="3" fill="${SIDE[side][0]}" stroke="#ffe9a8" stroke-width="2"/>
        <text x="${bx + 15}" y="${by + 16}" text-anchor="middle" font-size="14" font-weight="bold" fill="#fff">${a.units.length}</text></g>`);
    });
  });
  $('map').innerHTML = `<defs><marker id="ah" markerWidth="8" markerHeight="8" refX="5" refY="4" orient="auto"><path d="M0,0 L8,4 L0,8z" fill="${SIDE[me][0]}"/></marker></defs>` + svg.join('');
  $('map').querySelectorAll('.prov').forEach(g => g.onclick = () => clickProv(+g.dataset.p));

  // side panel
  let h = `<h2>Turn ${m.turn}</h2><div>You command <b style="color:${SIDE[me][0]}">${SIDE[me][1]}</b> vs ${esc(m.opponent)}</div>
    <div>Gold: <b>${m.gold}</b> &middot; Units: ${m.units}/${m.maxUnits} &middot; Income: ${40 * m.owner.filter(o => o === me).length}/turn</div><hr>`;
  if (campSel === null) h += '<div style="color:#a9987a">Select one of your provinces to recruit or move its army. Then select a highlighted neighbour to march there.</div>';
  else {
    const p = m.provs[campSel], o = m.owner[campSel];
    h += `<h2>${esc(p.name)}</h2><div>${o < 0 ? 'Unclaimed' : 'Held by ' + SIDE[o][1]}</div>`;
    for (const side of [0, 1]) {
      const a = armyAt(campSel, side); if (!a) continue;
      h += `<div style="margin-top:8px"><b style="color:${SIDE[side][0]}">${SIDE[side][1]} army</b><br>` +
        a.units.map(u => `${UNIT_NAME[u.type]} (${u.men})`).join('<br>') + '</div>';
      if (side === me && m.moves[a.id] !== undefined) h += `<div style="margin-top:6px">Marching to <b>${esc(m.provs[m.moves[a.id]].name)}</b></div>` +
        (orders ? `<button id="cancelMove">Cancel march</button>` : '');
    }
    if (o === me && orders) {
      h += '<div style="margin-top:10px"><b>Recruit here</b></div>';
      for (const t of Object.keys(m.cost)) h += `<button data-r="${t}" ${m.gold < m.cost[t] || m.units >= m.maxUnits ? 'disabled' : ''}>${UNIT_NAME[t]} &mdash; ${m.cost[t]}g</button>`;
    }
  }
  h += '<hr>';
  if (m.winner !== null) h += `<div><b>${m.winner === me ? 'Campaign won!' : 'Campaign lost.'}</b></div>`;
  else if (m.phase === 'orders') h += m.ready[me] ? '<div>Orders sent. Waiting for opponent&hellip;</div>' : '<button id="endTurn" style="text-align:center;background:#2c6a2c">End turn</button>';
  else h += '<div>Armies are on the march&hellip;</div>';
  h += `<hr><div id="log">${m.log.map(l => `<div>${esc(l)}</div>`).join('')}</div>`;
  $('panel').innerHTML = h;
  $('panel').querySelectorAll('[data-r]').forEach(b => b.onclick = () => send({ t: 'recruit', prov: campSel, type: b.dataset.r }));
  if ($('endTurn')) $('endTurn').onclick = () => send({ t: 'endturn' });
  if ($('cancelMove') && selArmy) $('cancelMove').onclick = () => send({ t: 'cmove', army: selArmy.id, to: null });

  if (m.winner !== null) {
    $('endText').textContent = m.winner === me ? 'CAMPAIGN VICTORY' : 'CAMPAIGN DEFEAT';
    $('btnAgain').style.display = 'inline-block'; $('end').style.display = 'flex';
  }
}

function clickProv(i) {
  const m = lastCamp; if (!m) return;
  const orders = m.phase === 'orders' && !m.ready[m.you] && m.winner === null;
  const army = campSel !== null ? m.armies.find(a => a.owner === m.you && a.prov === campSel) : null;
  const adjacent = army && m.edges.some(e => (e[0] === army.prov && e[1] === i) || (e[1] === army.prov && e[0] === i));
  if (orders && army && adjacent) { send({ t: 'cmove', army: army.id, to: i }); return; }
  campSel = i; renderCamp(m);
}
