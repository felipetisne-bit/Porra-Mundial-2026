const express = require('express');
const path = require('path');
const fs = require('fs');
const { recalcStandings, findExcelMatchForESPN, toResultFmt, calcGroupScore, namesMatch, calcTeamPred } = require('./scoring');
const PORRA = require('./data/porra.json');

const app = express();
const PORT = process.env.PORT || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'porra2026';
const FOOTBALL_API_KEY = process.env.FOOTBALL_API_KEY || '';
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || '';

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ─── Awards ────────────────────────────────────────────────────────────
const AWARDS_FILE = path.join(__dirname, 'data', 'awards.json');
let awardsState = {}, honorsState = {};
function loadAwards() {
  try { const s=JSON.parse(fs.readFileSync(AWARDS_FILE,'utf8')); awardsState=s.awards||{}; honorsState=s.honors||{}; } catch{}
}
function saveAwards() {
  try { fs.writeFileSync(AWARDS_FILE,JSON.stringify({awards:awardsState,honors:honorsState})); } catch(e){console.error(e.message);}
}
loadAwards();

// ─── Fetch helper ──────────────────────────────────────────────────────
async function fetchJSON(url, opts={}) {
  const fetch = (await import('node-fetch')).default;
  const headers = {'User-Agent':'Mozilla/5.0','Accept':'application/json',...(opts.headers||{})};
  const fetchOpts = {headers, signal:AbortSignal.timeout(opts.timeout||8000)};
  if(opts.method) fetchOpts.method = opts.method;
  if(opts.body) fetchOpts.body = opts.body;
  const res = await fetch(url, fetchOpts);
  if(!res.ok) throw new Error(`HTTP ${res.status} ${url.slice(0,60)}`);
  return res.json();
}

function getSantiagoDate(d) {
  try {
    const dt = d ? new Date(d) : new Date();
    const str = dt.toLocaleDateString('en-CA', {timeZone:'America/Santiago'});
    if (str && str.match(/^\d{4}-\d{2}-\d{2}$/)) return str;
  } catch(e) {}
  const ms = (d ? new Date(d) : new Date()).getTime() - 4 * 3600000;
  return new Date(ms).toISOString().slice(0,10);
}
function getTodayStr() { return getSantiagoDate(); }
function getTodayDates() {
  const today = getTodayStr();
  const ms = new Date().getTime() - 4*3600000 - 86400000;
  const yesterday = new Date(ms).toISOString().slice(0,10);
  return [today, yesterday];
}

// ─── Cache ─────────────────────────────────────────────────────────────
let wcCache   = { results:{}, matches:[], ts:0 };
let liveCache = { liveResults:{}, liveMatches:[], ts:0 };

// ─── Source 1: openfootball ────────────────────────────────────────────
async function refreshWC() {
  const now = Date.now();
  if(now - wcCache.ts < 120000) return wcCache;
  const results={}, matches=[];
  try {
    const data = await fetchJSON('https://raw.githubusercontent.com/openfootball/world-cup.json/master/2026/worldcup.json');
    for(const m of (data.matches||[])) {
      const hasScore = m.score?.ft?.length===2;
      const hScore = hasScore ? m.score.ft[0] : null;
      const aScore = hasScore ? m.score.ft[1] : null;
      const excelName = findExcelMatchForESPN(m.team1, m.team2, PORRA.group_score);
      if(excelName && hasScore) {
        results[excelName]={homeScore:hScore,awayScore:aScore,status:'FT',homeTeam:m.team1,awayTeam:m.team2};
      }
      matches.push({
        espnHome:m.team1, espnAway:m.team2,
        homeScore:hScore, awayScore:aScore,
        status:hasScore?'FT':'NS',
        date:m.date, time:m.time||'',
        group:m.group||m.round||'',
        excelName,
        resultFmt:hasScore?toResultFmt(hScore,aScore):null
      });
    }
    console.log(`[WC] ${matches.length} matches, ${Object.keys(results).length} with results`);
  } catch(e){ console.error('[WC]',e.message); }
  wcCache={results,matches,ts:now};
  return wcCache;
}

// ─── Source 2: live scores ─────────────────────────────────────────────
async function refreshLive() {
  const now = Date.now();
  if(now - liveCache.ts < 30000) return liveCache;

  const liveResults={}, liveMatches=[];

  if(!FOOTBALL_API_KEY) {
    try {
      const data = await fetchJSON('https://site.api.espn.com/apis/site/v2/sports/soccer/fifa.world/scoreboard?limit=20');
      for(const event of (data.events||[])) {
        const comp=event.competitions?.[0]; if(!comp) continue;
        const home=comp.competitors?.find(c=>c.homeAway==='home');
        const away=comp.competitors?.find(c=>c.homeAway==='away');
        if(!home||!away) continue;
        const status=event.status?.type?.name||'';
        const isLive=status==='STATUS_IN_PROGRESS';
        const isFT=status==='STATUS_FINAL';
        if(!isLive&&!isFT) continue;
        const hScore=parseInt(home.score??0);
        const aScore=parseInt(away.score??0);
        const excelName=findExcelMatchForESPN(home.team?.displayName||'',away.team?.displayName||'',PORRA.group_score);
        if(excelName) {
          liveResults[excelName]={homeScore:hScore,awayScore:aScore,status:isLive?'LIVE':'FT',homeTeam:home.team?.displayName,awayTeam:away.team?.displayName};
          liveMatches.push({espnHome:home.team?.displayName,espnAway:away.team?.displayName,homeScore:hScore,awayScore:aScore,status:isLive?'LIVE':'FT',clock:isLive?event.status?.displayClock:null,date:getSantiagoDate(event.date),excelName});
        }
      }
    } catch(e){ console.error('[ESPN fallback]',e.message); }
  } else {
    try {
      const data = await fetchJSON('https://api.football-data.org/v4/competitions/2000/matches?status=LIVE,IN_PLAY,PAUSED', {
        headers:{'X-Auth-Token': FOOTBALL_API_KEY}
      });
      for(const match of (data.matches||[])) {
        const home = match.homeTeam?.name||match.homeTeam?.shortName||'';
        const away = match.awayTeam?.name||match.awayTeam?.shortName||'';
        const hScore = match.score?.fullTime?.home ?? match.score?.halfTime?.home ?? null;
        const aScore = match.score?.fullTime?.away ?? match.score?.halfTime?.away ?? null;
        const isLive = ['IN_PLAY','PAUSED','LIVE'].includes(match.status);
        const isFT = match.status === 'FINISHED';
        if(!isLive && !isFT) continue;
        const excelName = findExcelMatchForESPN(home, away, PORRA.group_score);
        if(excelName && hScore!=null) {
          liveResults[excelName]={homeScore:hScore,awayScore:aScore,status:isLive?'LIVE':'FT',homeTeam:home,awayTeam:away};
          liveMatches.push({espnHome:home,espnAway:away,homeScore:hScore,awayScore:aScore,status:isLive?'LIVE':'FT',date:getSantiagoDate(match.utcDate),excelName});
        }
      }
      // Segundo request: partidos de hoy para scores individuales (group_score)
      // SOLO se usa para calcular puntos por partido, nunca para standings de grupo
      const today = getTodayStr();
      const data2 = await fetchJSON(`https://api.football-data.org/v4/competitions/2000/matches?dateFrom=${today}&dateTo=${today}`, {
        headers:{'X-Auth-Token': FOOTBALL_API_KEY}
      });
      for(const match of (data2.matches||[])) {
        const home = match.homeTeam?.name||'';
        const away = match.awayTeam?.name||'';
        const hScore = match.score?.fullTime?.home;
        const aScore = match.score?.fullTime?.away;
        if(match.status !== 'FINISHED' || hScore==null) continue;
        const excelName = findExcelMatchForESPN(home, away, PORRA.group_score);
        if(excelName && !liveResults[excelName]) {
          liveResults[excelName]={homeScore:hScore,awayScore:aScore,status:'FT',homeTeam:home,awayTeam:away};
        }
      }
    } catch(e){ console.error('[football-data]',e.message); }
  }

  liveCache={liveResults,liveMatches,ts:now};
  return liveCache;
}

// ─── Group Standings Calculator ────────────────────────────────────────
function calcGroupStandings(matches) {
  const groups = {};
  for (const m of matches) {
    if (!m.group || !m.group.startsWith('Group')) continue;
    const t1 = m.team1 || m.espnHome;
    const t2 = m.team2 || m.espnAway;
    const g1raw = m.score?.ft?.[0] ?? m.homeScore;
    const g2raw = m.score?.ft?.[1] ?? m.awayScore;
    if (g1raw == null || g2raw == null || !t1 || !t2) continue;
    if (m.status === 'NS') continue;
    const g = m.group.replace('Group ','');
    if (!groups[g]) groups[g] = {};
    const [g1, g2] = [g1raw, g2raw];
    for (const t of [t1, t2]) {
      if (!groups[g][t]) groups[g][t] = {pts:0, gf:0, ga:0, gd:0, played:0};
    }
    groups[g][t1].played++; groups[g][t2].played++;
    groups[g][t1].gf += g1; groups[g][t1].ga += g2; groups[g][t1].gd += g1-g2;
    groups[g][t2].gf += g2; groups[g][t2].ga += g1; groups[g][t2].gd += g2-g1;
    if (g1 > g2) { groups[g][t1].pts += 3; }
    else if (g1 < g2) { groups[g][t2].pts += 3; }
    else { groups[g][t1].pts += 1; groups[g][t2].pts += 1; }
  }
  const sorted = {};
  for (const [g, teams] of Object.entries(groups)) {
    sorted[g] = Object.entries(teams)
      .sort((a,b) => b[1].pts-a[1].pts || b[1].gd-a[1].gd || b[1].gf-a[1].gf)
      .map(([name, stats]) => ({name, ...stats}));
  }
  return sorted;
}


// ─── Helper: grupos cerrados según partidos reales jugados ────────────
// Un grupo está cerrado cuando openfootball tiene sus 6 partidos con resultado
function getClosedGroups(matches) {
  const groupPlayed = {};
  for (const m of matches) {
    if (!m.group || !m.group.startsWith('Group')) continue;
    const g = m.group.replace('Group ', '');
    const hasScore = (m.score?.ft?.length === 2) ||
                     (m.homeScore != null && m.awayScore != null && m.status === 'FT');
    if (!groupPlayed[g]) groupPlayed[g] = 0;
    if (hasScore) groupPlayed[g]++;
  }
  const closedGroups = new Set();
  for (const [g, count] of Object.entries(groupPlayed)) {
    if (count >= 6) closedGroups.add(g);
  }
  return closedGroups;
}

// ─── FIX PRINCIPAL: getGroupPositionResults ────────────────────────────
// Recibe all12Done y closedGroups para control preciso
function getGroupPositionResults(matches, all12Done, closedGroups) {
  const standings = calcGroupStandings(matches);
  const results = {};

  for (const [g, teams] of Object.entries(standings)) {
    if (teams.length < 2) continue;
    // Solo publicar posiciones de grupos cerrados según fecha del porra.json
    if (!closedGroups.has(g)) continue;

    results[`1${g}`] = teams[0].name;
    results[`2${g}`] = teams[1].name;
    if (teams[2]) results[`3${g}`] = teams[2].name;
    if (teams[3]) results[`4${g}`] = teams[3].name;
  }

  // ─── FIX: Solo calcular mejores 3° cuando los 12 grupos estén cerrados ──
  // Antes esto se hacía siempre, dando puntos anticipados con grupos incompletos
  if (all12Done) {
    const groupsWithThird = Object.entries(standings)
      .filter(([g, teams]) => closedGroups.has(g) && teams[2]);

    const thirdPlaces = groupsWithThird
      .map(([g, teams]) => ({group:g, ...teams[2]}))
      .sort((a,b) => b.pts-a.pts || b.gd-a.gd || b.gf-a.gf);

    // Los 8 mejores terceros clasifican (32 equipos = 12×primero + 12×segundo + 8 mejores 3°)
    // Marcamos los 8 mejores como clasificados
    thirdPlaces.forEach((t, i) => {
      if (i < 8) results[`3${t.group}_CLASIFICA`] = t.name;
    });

    console.log(`[BEST3] Todos grupos cerrados. Mejores 3° clasificados: ${thirdPlaces.slice(0,8).map(t=>t.name).join(', ')}`);
  }
  // Si !all12Done: NO se publican _CLASIFICA, por lo que resolveKOCode no
  // podrá resolver ningún slot 3XXXX y devolverá null → 0 pts. CORRECTO.

  return results;
}

// ─── KO Match resolver ─────────────────────────────────────────────────
const W_TO_MATCH = {
  'W73':'2A-2B','W74':'1C-2F','W75':'1E-3ABCDF','W76':'1F-2C',
  'W77':'2E-2I','W78':'1I-3CDFGH','W79':'1A-3CEFHI','W80':'1L-3EHIJK',
  'W81':'1G-3AEHIJ','W82':'1D-3BEFIJ','W83':'1H-2J','W84':'2K-2L',
  'W85':'1B-3EFGIJ','W86':'2D-2G','W87':'1J-2H','W88':'1K-3DEIJL',
  'W89':'W73-W75','W90':'W74-W77','W91':'W76-W78','W92':'W79-W80',
  'W93':'W83-W84','W94':'W81-W82','W95':'W86-W88','W96':'W85-W87',
  'W97':'W89-W90','W98':'W91-W92','W99':'W93-W94','W100':'W95-W96',
  'W101':'W97-W98','W102':'W99-W100',
  'L101':'loser of W97-W98','L102':'loser of W99-W100'
};

function resolveKOCode(code, allResults, groupPos) {
  if (!code || code === '-') return null;
  // 1° o 2° o 3° o 4° de un grupo cerrado
  if (code.match(/^[1-4][A-L]$/)) return groupPos[code] || null;
  // Mejor 3° — solo resuelve si _CLASIFICA fue poblado (all12Done=true)
  if (code.match(/^3[A-L]{2,}$/)) {
    for (const g of code.slice(1).split('')) {
      if (groupPos[`3${g}_CLASIFICA`]) return groupPos[`3${g}_CLASIFICA`];
    }
    return null; // No resuelto hasta que cierren los 12 grupos
  }
  // Ganador de partido KO
  if (code.startsWith('W')) {
    const matchName = W_TO_MATCH[code];
    if (!matchName) return null;
    const match = allResults[matchName];
    if (!match || match.status !== 'FT') return null;
    return match.homeScore > match.awayScore ? match.homeTeam :
           match.awayScore > match.homeScore ? match.awayTeam : null;
  }
  // Perdedor de partido KO
  if (code.startsWith('L')) {
    const matchName = W_TO_MATCH[code.replace('L','W')];
    if (!matchName) return null;
    const match = allResults[matchName];
    if (!match || match.status !== 'FT') return null;
    return match.homeScore > match.awayScore ? match.awayTeam :
           match.awayScore > match.homeScore ? match.homeTeam : null;
  }
  return null;
}

// ─── Merged results ────────────────────────────────────────────────────
async function getResults() {
  const [wc, live] = await Promise.all([refreshWC(), refreshLive()]);
  const results = {...wc.results};
  // Mezclar liveResults de football-data/ESPN en results
  // SOLO para scores de partidos individuales (group_score)
  // Las posiciones de grupo y grupos cerrados usan SOLO wc.matches (openfootball)
  for(const [k,v] of Object.entries(live.liveResults)){
    if(v.status==='LIVE' || v.status==='FT') results[k]=v;
  }

  // Determinar grupos cerrados según fechas del porra.json (más preciso que contar partidos)
  const closedGroups = getClosedGroups(wc.matches);
  const completedGroupCount = closedGroups.size;
  const all12Done = completedGroupCount === 12;

  console.log(`[GROUPS] ${completedGroupCount}/12 grupos cerrados (${[...closedGroups].sort().join(',')}). Best3: ${all12Done}`);

  // Calcular posiciones — pasa closedGroups para control preciso por fecha
  const groupPosResults = getGroupPositionResults(wc.matches, all12Done, closedGroups);
  Object.assign(results, groupPosResults);

  // Resolver slots ko_team
  for (const m of PORRA.ko_team) {
    const code = m.result;
    if (!code || code === '-') continue;
    // resolveKOCode ya no puede resolver 3XXXX si all12Done=false
    // porque _CLASIFICA no fue poblado. La guarda aquí es redundante pero explícita.
    if (!all12Done && code.match(/^3[A-L]{2,}$/)) continue;
    const team = resolveKOCode(code, results, groupPosResults);
    if (team) results[m.name] = {team, status:'CLASSIFIED'};
  }

  const allMatches = wc.matches.map(m => {
    const liveM = live.liveMatches.find(l=>l.excelName===m.excelName);
    if(liveM) return {...m,...liveM};
    return m;
  });
  const liveCount = live.liveMatches.filter(m=>m.status==='LIVE').length;
  return {results, matches:allMatches, liveCount, completedGroupCount, all12Done};
}

// ─── Helpers ────────────────────────────────────────────────────────────
function getTodayMatches(allMatches) {
  const today = getTodayStr();
  const ms = new Date().getTime() - 4*3600000 - 86400000;
  const yesterday = new Date(ms).toISOString().slice(0,10);
  return allMatches.filter(m=>m.date===today || m.date===yesterday);
}

function getJornadaMatches(dateStr, results) {
  const allScore = [...PORRA.group_score,...PORRA.ko_score];
  const dates = Array.isArray(dateStr) ? dateStr : [dateStr];
  return allScore.filter(m=>dates.includes(m.date)).map(m=>{
    const r=results[m.name];
    let result=m.result;
    if(r&&r.homeScore!=null) result=toResultFmt(r.homeScore,r.awayScore);
    const playerResults=Object.entries(m.predictions).map(([name,pd])=>({
      name,pred:pd.pred,
      pts:result&&result!=='-'?calcGroupScore(pd.pred,result,m.bonus):null
    }));
    return {...m,result,liveStatus:r?.status||'NS',playerResults};
  });
}

function buildJornadaSummary(jornadaMatches, fullStandings) {
  const todayPts={};
  for(const m of jornadaMatches)
    for(const pr of (m.playerResults||[]))
      if(pr.pts!=null) todayPts[pr.name]=(todayPts[pr.name]||0)+pr.pts;
  const table=fullStandings.map(p=>({
    pos:p.pos,name:p.name,total:p.total,
    todayPts:todayPts[p.name]||0,variation:todayPts[p.name]||0
  })).sort((a,b)=>b.todayPts-a.todayPts||b.total-a.total);
  let jp=1;
  for(let i=0;i<table.length;i++){
    if(i>0&&table[i].todayPts<table[i-1].todayPts) jp=i+1;
    table[i].jornadaPos=jp;
  }
  return table;
}

function buildPremiosFecha(jornadaMatches) {
  const allPreds=[];
  for(const m of jornadaMatches){
    if(!m.result||m.result==='-') continue;
    for(const pr of (m.playerResults||[]))
      allPreds.push({...pr,match:m.name,result:m.result,bonus:m.bonus,maxPts:m.max_pts});
  }
  if(!allPreds.length) return null;
  const byPlayer={};
  for(const pr of allPreds){
    if(!byPlayer[pr.name]) byPlayer[pr.name]={name:pr.name,pts:0,exactos:[],matches:[]};
    byPlayer[pr.name].pts+=pr.pts||0;
    byPlayer[pr.name].matches.push(pr);
    if(pr.pts===pr.maxPts&&pr.maxPts>0) byPlayer[pr.name].exactos.push(pr.match);
  }
  const players=Object.values(byPlayer);
  const maxPts=Math.max(...players.map(p=>p.pts));
  const minPts=Math.min(...players.map(p=>p.pts));
  const topPlayers=players.filter(p=>p.pts===maxPts);
  const bottomPlayers=players.filter(p=>p.pts===minPts&&minPts<maxPts*0.4);
  const exactPlayers=players.filter(p=>p.exactos.length>0);
  const smartPlayers=players.filter(p=>p.matches.some(m=>{
    const r=m.result?.split('|'),pred=m.pred?.split('|');
    if(!r||!pred||r[0]!==pred[0]) return false;
    const [rh,ra]=(r[1]||'').split('-').map(Number);
    const [ph,pa]=(pred[1]||'').split('-').map(Number);
    return (rh-ra===ph-pa)&&(rh!==ph);
  })).filter(p=>!topPlayers.includes(p));
  return {
    jugadoresFecha:{names:topPlayers.map(p=>p.name),pts:maxPts,desc:`${topPlayers.length} jugador(es) lideran con ${maxPts} pts`},
    reyBonus:{names:topPlayers.slice(0,1).map(p=>p.name),pts:maxPts,desc:'Máximo aprovechamiento'},
    francotiradores:{names:exactPlayers.map(p=>p.name),desc:`${exactPlayers.length} acertaron resultado exacto`},
    malaSuerte:{names:bottomPlayers.map(p=>p.name),pts:minPts,desc:bottomPlayers.length?`Solo ${minPts} pts`:''},
    jugadaInteligente:{names:smartPlayers.slice(0,5).map(p=>p.name),desc:'Diferencia correcta, no el exacto'},
    zonaPeligro:{names:players.filter(p=>p.pts===0).map(p=>p.name),desc:'Sin puntos en la jornada'}
  };
}

async function generateGPTAnalysis(type, context) {
  if(!ANTHROPIC_API_KEY) return '⚠️ Configura ANTHROPIC_API_KEY en Railway Variables.';
  try {
    const prompts = {
      impacto:`Eres el analista de una porra de fútbol entre amigos chilenos. Con estos datos genera un análisis de impacto en español informal y entretenido (máx 300 palabras). Incluye: qué partidos generaron más movimiento, grupos de puntos, caída del día, partido bonus más decisivo. Datos: ${JSON.stringify(context)}`,
      cronica:`Eres el cronista de una porra de fútbol entre amigos chilenos. Escribe una crónica narrativa en español (máx 600 palabras) con el espíritu de Osvaldo Soriano y Eduardo Galeano: mezcla fútbol con nostalgia, humor porteño y pequeñas piezas literarias sobre el alma del juego. Como Soriano, teje lo cotidiano con lo épico, los nombres propios con la melancolía de lo que pudo ser. Como Galeano, convierte cada gol en una historia humana, cada pronóstico fallido en una metáfora de la vida. Habla de los participantes por su nombre, con afecto y picardía chilena. No pierdas el hilo de la porra: menciona puntajes, subidas, caídas y el drama real de la jornada. Datos: ${JSON.stringify(context)}`
    };
    const data = await fetchJSON('https://api.anthropic.com/v1/messages', {
      method:'POST',
      headers:{'x-api-key':ANTHROPIC_API_KEY,'anthropic-version':'2023-06-01','Content-Type':'application/json'},
      body:JSON.stringify({model:'claude-haiku-4-5-20251001',max_tokens:1100,messages:[{role:'user',content:prompts[type]}]}),
      timeout:30000
    });
    return data.content?.[0]?.text || '';
  } catch(e){ return `Error IA: ${e.message}`; }
}

// ─── API Routes ────────────────────────────────────────────────────────
app.get('/api/live', async(req,res)=>{
  try {
    const {results,matches,liveCount,completedGroupCount,all12Done}=await getResults();
    const standings=recalcStandings(PORRA,results,awardsState,honorsState);
    const avg=standings.length?(standings.reduce((s,p)=>s+p.total,0)/standings.length).toFixed(1):0;
    const todayMs=getTodayMatches(matches);
    const awardsDisplay=[
      ...PORRA.honors.map(h=>({label:h.name,pts:h.max_pts,type:'team',result:honorsState[h.name]||null,predictions:Object.entries(h.predictions).map(([n,p])=>({player:n,pred:p.pred,correct:honorsState[h.name]?namesMatch(p.pred,honorsState[h.name]):null}))})),
      ...PORRA.player_awards.map(a=>({label:a.name,pts:a.max_pts,type:'player',result:awardsState[a.name.trim()]||null,predictions:Object.entries(a.predictions).map(([n,p])=>({player:n,pred:p.pred,correct:awardsState[a.name.trim()]?namesMatch(p.pred,awardsState[a.name.trim()]):null}))}))
    ];
    res.json({ok:true,standings,todayMatches:todayMs,allMatches:matches,awardsDisplay,
      stats:{liveCount,leaderPts:standings[0]?.total||0,leader:standings[0]?.name||'-',avgPts:avg,
             withZero:standings.filter(p=>p.total===0).length,total:standings.length,
             playedCount:Object.keys(results).length,
             completedGroups:completedGroupCount,  // nuevo: grupos cerrados
             best3Resolved:all12Done},             // nuevo: si ya se resolvieron los 3°
      lastUpdated:new Date().toISOString()});
  } catch(e){console.error(e);res.status(500).json({ok:false,error:e.message});}
});

app.get('/api/jornada', async(req,res)=>{
  try {
    const dateStr=req.query.date||getTodayDates();
    const primaryDate=Array.isArray(dateStr)?dateStr[0]:dateStr;
    const {results}=await getResults();
    const standings=recalcStandings(PORRA,results,awardsState,honorsState);
    const jornadaMatches=getJornadaMatches(dateStr,results);
    const summary=buildJornadaSummary(jornadaMatches,standings);
    const premios=buildPremiosFecha(jornadaMatches);
    const allDates=[...new Set([...PORRA.group_score,...PORRA.ko_score].map(m=>m.date).filter(Boolean))].sort();

    // ── Puntos de posición de grupos y clasificados para la jornada ──
    const dates=Array.isArray(dateStr)?dateStr:[dateStr];

    // group_pos: posiciones de grupo que cierran en estas fechas
    const groupPosPts={};
    for(const m of PORRA.group_pos.filter(m=>dates.includes(m.date))){
      const actualTeam=results[m.result]||null;
      if(!actualTeam) continue;
      for(const [pName,pd] of Object.entries(m.predictions)){
        const pts=(namesMatch(pd.pred,actualTeam)?m.max_pts:0);
        groupPosPts[pName]=(groupPosPts[pName]||0)+pts;
      }
    }

    // ko_team: clasificados cuyo grupo cierra en estas fechas
    // Agrupa todos los clasificados resueltos de la ronda Dieciseisavofinalista
    const classified16=new Set();
    for(const m of PORRA.ko_team.filter(m=>m.name.startsWith('Dieciseisavofinalista'))){
      const espn=results[m.name];
      if(espn&&espn.status==='CLASSIFIED'&&espn.team) classified16.add(espn.team);
    }
    // Solo contar los que clasificaron por grupos que cerraron HOY
    const groupsClosingToday=new Set();
    for(const m of PORRA.group_pos.filter(m=>dates.includes(m.date))){
      const match=m.result.match(/^[1-4]([A-L])$/);
      if(match) groupsClosingToday.add(match[1]);
    }
    const classified16Today=new Set();
    for(const m of PORRA.ko_team.filter(m=>m.name.startsWith('Dieciseisavofinalista'))){
      const espn=results[m.name];
      if(!espn||espn.status!=='CLASSIFIED'||!espn.team) continue;
      // El código del slot (ej: "1A","2B") indica de qué grupo viene
      const code=m.result;
      if(code.match(/^[12][A-L]$/)){
        const g=code[1];
        if(groupsClosingToday.has(g)) classified16Today.add(espn.team);
      }
    }
    const ko16Pts={};
    const { norm:normFn } = require('./scoring');
    // Necesitamos calcTeamPred — lo importamos
    const { calcTeamPred:ctp } = (() => {
      try { return require('./scoring'); } catch(e){ return {}; }
    })();
    if(classified16Today.size>0 && ctp){
      const tracked={};
      for(const m of PORRA.ko_team.filter(m=>m.name.startsWith('Dieciseisavofinalista'))){
        for(const [pName,pd] of Object.entries(m.predictions)){
          if(!tracked[pName]) tracked[pName]=new Set();
          let hit=false;
          for(const actual of classified16Today){
            if((ctp(pd.pred,actual,2)||0)>0){hit=true;break;}
          }
          if(!hit) continue;
          const key='16_'+(pd.pred||'').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/[^a-z0-9]/g,'');
          if(tracked[pName].has(key)) continue;
          tracked[pName].add(key);
          ko16Pts[pName]=(ko16Pts[pName]||0)+2;
        }
      }
    }

    // Enriquecer summary con pts de pos_grupos y ko_16 de hoy
    // todayPts y variation = partidos + posgrupo + 16avos
    const summaryEnriched=summary.map(p=>{
      const matchPts=p.todayPts||0;
      const gpp=groupPosPts[p.name]||0;
      const k16=ko16Pts[p.name]||0;
      const totalHoy=matchPts+gpp+k16;
      return {...p, matchPts, groupPosPts:gpp, ko16Pts:k16, todayPts:totalHoy, variation:totalHoy};
    });

    res.json({ok:true,date:primaryDate,jornadaMatches,summary:summaryEnriched,premios,availableDates:allDates,lastUpdated:new Date().toISOString()});
  } catch(e){res.status(500).json({ok:false,error:e.message});}
});

app.get('/api/analysis/:type', async(req,res)=>{
  const auth=req.headers['x-admin-token'];
  if(auth!==Buffer.from(ADMIN_PASSWORD).toString('base64')) return res.status(401).json({ok:false,error:'No autorizado'});
  try {
    const {type}=req.params;
    if(!['impacto','cronica'].includes(type)) return res.status(400).json({ok:false});
    const dateStr=req.query.date||getTodayDates();
    const {results}=await getResults();
    const standings=recalcStandings(PORRA,results,awardsState,honorsState);
    const jornadaMatches=getJornadaMatches(dateStr,results);
    const summary=buildJornadaSummary(jornadaMatches,standings);
    const premios=buildPremiosFecha(jornadaMatches);
    const context={date:dateStr,matches:jornadaMatches.map(m=>({name:m.name,result:m.result,bonus:m.bonus})),top5:standings.slice(0,5).map(p=>({name:p.name,total:p.total})),summary:summary.slice(0,10),premios};
    const text=await generateGPTAnalysis(type,context);
    res.json({ok:true,text,date:dateStr});
  } catch(e){res.status(500).json({ok:false,error:e.message});}
});

app.get('/api/pronosticos', async(req,res)=>{
  try {
    const dateStr=req.query.date||getTodayDates();
    const primaryDate=Array.isArray(dateStr)?dateStr[0]:dateStr;
    const {results}=await getResults();
    const jornadaMatches=getJornadaMatches(dateStr,results);
    const pronosticos=jornadaMatches.map(m=>({
      match:m.name,date:m.date,bonus:m.bonus,maxPts:m.max_pts,
      match_type:m.match_type||'group_score',
      result:m.result||'-',status:m.liveStatus||'NS',
      players:Object.entries(m.predictions).map(([name,pd])=>({name,pred:pd.pred,pts:m.result&&m.result!=='-'?calcGroupScore(pd.pred,m.result,m.bonus):null})).sort((a,b)=>(b.pts||0)-(a.pts||0))
    }));
    const dates=Array.isArray(dateStr)?dateStr:[dateStr];
    const groupPosByDate=PORRA.group_pos.filter(m=>dates.includes(m.date));
    const groupPosPronosticos=groupPosByDate.map(m=>{
      const actualTeam=results[m.result]||null;
      return {
        match:m.name,date:m.date,bonus:m.bonus,maxPts:m.max_pts,
        match_type:'group_pos',
        result:actualTeam||'-',status:actualTeam?'FT':'NS',
        players:Object.entries(m.predictions).map(([name,pd])=>({
          name,pred:pd.pred,
          pts:actualTeam?(namesMatch(pd.pred,actualTeam)?m.max_pts:0):null
        })).sort((a,b)=>(b.pts||0)-(a.pts||0))
      };
    });
    res.json({ok:true,date:primaryDate,pronosticos:[...pronosticos,...groupPosPronosticos]});
  } catch(e){res.status(500).json({ok:false,error:e.message});}
});

app.post('/api/admin/login',(req,res)=>{
  const {password}=req.body;
  if(password===ADMIN_PASSWORD) res.json({ok:true,token:Buffer.from(password).toString('base64')});
  else res.status(401).json({ok:false,error:'Contraseña incorrecta'});
});

app.post('/api/admin/awards',(req,res)=>{
  const auth=req.headers['x-admin-token'];
  if(auth!==Buffer.from(ADMIN_PASSWORD).toString('base64')) return res.status(401).json({ok:false,error:'No autorizado'});
  const{awards,honors}=req.body;
  if(awards) Object.assign(awardsState,awards);
  if(honors) Object.assign(honorsState,honors);
  saveAwards();
  res.json({ok:true});
});

app.get('/api/admin/awards',(req,res)=>{
  res.json({awards:awardsState,honors:honorsState,awardNames:PORRA.player_awards.map(a=>a.name.trim()),honorNames:PORRA.honors.map(h=>h.name)});
});

app.get('/api/match/:name',async(req,res)=>{
  try {
    const {results}=await getResults();
    const name=decodeURIComponent(req.params.name);
    const match=[...PORRA.group_score,...PORRA.ko_score].find(m=>m.name.toLowerCase()===name.toLowerCase());
    if(!match) return res.status(404).json({ok:false,error:'Not found'});
    const r=results[match.name];
    let result=match.result;
    if(r?.homeScore!=null) result=toResultFmt(r.homeScore,r.awayScore);
    const preds=Object.entries(match.predictions).map(([pName,pd])=>({name:pName,pred:pd.pred,pts:result&&result!=='-'?calcGroupScore(pd.pred,result,match.bonus):null})).sort((a,b)=>(b.pts||0)-(a.pts||0));
    res.json({ok:true,match:match.name,date:match.date,bonus:match.bonus,result,preds});
  } catch(e){res.status(500).json({ok:false,error:e.message});}
});

app.get('/api/debug',async(req,res)=>{
  const {results,matches,liveCount,completedGroupCount,all12Done}=await getResults();
  res.json({today:getTodayStr(),liveCount,footballApiKey:!!FOOTBALL_API_KEY,anthropicKey:!!ANTHROPIC_API_KEY,
    mappedResults:Object.keys(results).length,results,
    completedGroups:completedGroupCount,best3Resolved:all12Done,
    ko_team_resolved:Object.keys(results).filter(k=>k.startsWith('Dieciseisavofinalista')),
    todayMatches:getTodayMatches(matches)});
});

app.get('/health',(_, res)=>res.json({ok:true,uptime:process.uptime()}));
app.get('*',(_, res)=>res.sendFile(path.join(__dirname,'public','index.html')));
app.listen(PORT,()=>console.log(`🏆 Porra en vivo → http://localhost:${PORT}`));
