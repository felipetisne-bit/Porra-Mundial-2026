const express = require('express');
const path = require('path');
const fs = require('fs');
const { recalcStandings, findExcelMatchForESPN, toResultFmt, calcGroupScore, calcKOScore, norm, namesMatch, calcTeamPred, getSlotRoundByPts } = require('./scoring');

// Diccionario ESP→EN para uso en server.js
const ESP_TO_EN_SERVER = {
  'alemania':'germany','arabiaasaudita':'saudiarabia','argelia':'algeria',
  'argentina':'argentina','australia':'australia','austria':'austria',
  'bosniaherzegovina':'bosniaherzegovina','brasil':'brazil',
  'belgica':'belgium','caboverde':'capeverde','canada':'canada',
  'catar':'qatar','colombia':'colombia','coreadelsur':'southkorea',
  'costademarfil':'ivorycoast','croacia':'croatia','curazao':'curacao',
  'ecuador':'ecuador','egipto':'egypt','escocia':'scotland',
  'espana':'spain','estadosunidos':'usa','francia':'france',
  'ghana':'ghana','haiti':'haiti','inglaterra':'england',
  'irak':'iraq','iran':'iran','japon':'japan','jordania':'jordan',
  'marruecos':'morocco','mexico':'mexico','noruega':'norway',
  'nuevazelanda':'newzealand','panama':'panama','paraguay':'paraguay',
  'paisesbajos':'netherlands','portugal':'portugal','rdcongo':'drcongo',
  'republicacheca':'czechrepublic','senegal':'senegal','sudafrica':'southafrica',
  'suecia':'sweden','suiza':'switzerland','turquia':'turkey',
  'tunez':'tunisia','uruguay':'uruguay','uzbekistan':'uzbekistan',
};

const PORRA = require('./data/porra.json');

// ─── Contador de visitas ────────────────────────────────────────────────
const visitCounter = { today: 0, total: 0, date: '' };
function trackVisit() {
  const today = getTodayStr();
  if (visitCounter.date !== today) { visitCounter.date = today; visitCounter.today = 0; }
  visitCounter.today++;
  visitCounter.total++;
}

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
    
    // Indexar qué equipos aparecen en cada ronda KO posterior
    // Si un equipo aparece en Round of 16, ganó su Round of 32 (aunque fuera por penales)
    const teamInRound = {}; // team -> set of rounds they appear in
    const koRounds = ['Round of 16','Quarter-final','Semi-final','Final','Match for third place'];
    for(const m of (data.matches||[])) {
      if(!koRounds.includes(m.round)) continue;
      if(m.team1) { if(!teamInRound[m.team1]) teamInRound[m.team1]=new Set(); teamInRound[m.team1].add(m.round); }
      if(m.team2) { if(!teamInRound[m.team2]) teamInRound[m.team2]=new Set(); teamInRound[m.team2].add(m.round); }
    }
    console.log('[WC] Equipos en rondas KO:', Object.entries(teamInRound).map(([t,r])=>`${t}(${[...r].join(',')})`).join(' '));

    for(const m of (data.matches||[])) {
      // Para partidos KO usar el resultado de 120 min (et) si existe (hubo alargue)
      // Si no hubo alargue, et no existe y se usa ft (90 min = resultado final)
      const isKORoundForScore = m.round && !m.group;
      const useET = isKORoundForScore && m.score?.et?.length===2;
      const hasScore = useET ? true : (m.score?.ft?.length===2);
      const hScore = useET ? m.score.et[0] : (hasScore ? m.score.ft[0] : null);
      const aScore = useET ? m.score.et[1] : (hasScore ? m.score.ft[1] : null);
      const allPorraMatches = [...PORRA.group_score, ...PORRA.ko_score];
      const excelName = findExcelMatchForESPN(m.team1, m.team2, allPorraMatches);
      if(hasScore) {
        const key = `${m.team1}-${m.team2}`;
        const isKORound = m.round && !m.group;
        // Si hay empate en partido KO, determinar ganador por penales
        let winner = null, loser = null;
        if(isKORound && hasScore && hScore===aScore) {
          // PRIORIDAD 1: openfootball score.p = [home_pens, away_pens]
          if(m.score?.p && m.score.p.length===2){
            const [pH, pA] = m.score.p;
            if(pH > pA) { winner=m.team1; loser=m.team2; }
            else if(pA > pH) { winner=m.team2; loser=m.team1; }
            if(winner) console.log(`[WC] Penales (openfootball): ${winner} ${Math.max(pH,pA)}-${Math.min(pH,pA)} ${loser}`);
          }
          // PRIORIDAD 2: equipo aparece en ronda siguiente
          if(!winner){
            const t1InNext = teamInRound[m.team1] && [...teamInRound[m.team1]].some(r=>koRounds.indexOf(r)>koRounds.indexOf(m.round));
            const t2InNext = teamInRound[m.team2] && [...teamInRound[m.team2]].some(r=>koRounds.indexOf(r)>koRounds.indexOf(m.round));
            if(t1InNext) { winner=m.team1; loser=m.team2; }
            else if(t2InNext) { winner=m.team2; loser=m.team1; }
          }
          // PRIORIDAD 3: override manual
          if(!winner){
            if(PENALTY_WINNERS[key]) { winner=PENALTY_WINNERS[key]; loser=winner===m.team1?m.team2:m.team1; }
            else if(PENALTY_WINNERS[`${m.team2}-${m.team1}`]) { winner=PENALTY_WINNERS[`${m.team2}-${m.team1}`]; loser=winner===m.team1?m.team2:m.team1; }
          }
          if(winner) console.log(`[WC] Penalty winner: ${winner} (beat ${loser})`);
        }
        const resultObj = {homeScore:hScore,awayScore:aScore,status:'FT',homeTeam:m.team1,awayTeam:m.team2,isKO:isKORound,penaltyWinner:winner,round:m.round||null};
        results[key]=resultObj;
        if(excelName) results[excelName]=resultObj;
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
    // Guardar TODOS los partidos KO (con y sin resultado) para que getJornadaMatches
    // pueda mostrar los partidos del día aunque aún no hayan comenzado
    global._wcMatchesByTeam = matches.filter(m=>!m.group.startsWith('Group')).map(m=>({
      homeTeam:m.espnHome, awayTeam:m.espnAway, date:m.date,
      homeScore:m.homeScore, awayScore:m.awayScore, status:m.status,
      round:m.group  // group field tiene el round para partidos KO (Round of 16, etc.)
    }));
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
        const allPorraM=[...PORRA.group_score,...PORRA.ko_score];
        const excelName=findExcelMatchForESPN(home.team?.displayName||'',away.team?.displayName||'',allPorraM);
        const hn=home.team?.displayName||'', an=away.team?.displayName||'';
        const koKey=`${hn}-${an}`;
        const isKOLive=!excelName && (isLive||isFT);
        if(excelName||isKOLive) {
          const obj={homeScore:hScore,awayScore:aScore,status:isLive?'LIVE':'FT',homeTeam:hn,awayTeam:an,isKO:isKOLive};
          if(excelName) liveResults[excelName]=obj;
          if(isKOLive) liveResults[koKey]=obj;
          liveMatches.push({espnHome:hn,espnAway:an,homeScore:hScore,awayScore:aScore,status:isLive?'LIVE':'FT',clock:isLive?event.status?.displayClock:null,date:getSantiagoDate(event.date),excelName,group:isKOLive?'Round of 32':''});
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
        // IMPORTANTE: usar regularTime (90 min) para el marcador de puntaje
        // fullTime puede incluir tiempo extra; penales NUNCA deben sumarse al marcador
        const hScore = match.score?.regularTime?.home ?? match.score?.fullTime?.home;
        const aScore = match.score?.regularTime?.away ?? match.score?.fullTime?.away;
        if(match.status !== 'FINISHED' || hScore==null) continue;
        // Detectar ganador por penales (football-data.org SÍ registra esto)
        // score.winner: HOME_TEAM | AWAY_TEAM | DRAW
        // score.duration: PENALTY_SHOOTOUT indica que hubo penales
        let penWinner = null;
        if(match.score?.duration === 'PENALTY_SHOOTOUT' && match.score?.winner){
          if(match.score.winner === 'HOME_TEAM') penWinner = home;
          else if(match.score.winner === 'AWAY_TEAM') penWinner = away;
          if(penWinner) console.log(`[FOOTBALL-DATA] Penalty winner: ${penWinner} (${home} vs ${away}) score=${hScore}-${aScore}`);
        }
        const excelName = findExcelMatchForESPN(home, away, [...PORRA.group_score, ...PORRA.ko_score]);
        const isKORound = !match.competition || match.stage !== 'GROUP_STAGE';
        const resultObj = {homeScore:hScore,awayScore:aScore,status:'FT',homeTeam:home,awayTeam:away,penaltyWinner:penWinner,isKO:isKORound};
        const key = `${home}-${away}`;
        if(!liveResults[key]) liveResults[key] = resultObj;
        if(excelName && !liveResults[excelName]) {
          liveResults[excelName] = resultObj;
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
// ─── Override manual para resultados de penales ────────────────────────
// Cuando un partido termina en empate y se decide por penales,
// agregar aquí el ganador manualmente.
// Formato: 'Team1-Team2': 'Ganador'  (nombres en inglés como en openfootball)
const PENALTY_WINNERS = {
  'Germany-Paraguay': 'Paraguay',  // 29 jun 2026 - ganó Paraguay por penales
};

const W_TO_MATCH = {
  // 16avos - mapeados según numeración del Excel
  'W73':'2A-2B',       // #73 Sudáfrica vs Canadá
  'W74':'1E-3ABCDF',   // #74 Alemania vs Paraguay
  'W75':'1F-2C',       // #75 Países Bajos vs Marruecos
  'W76':'1C-2F',       // #76 Brasil vs Japón
  'W77':'2E-2I',       // #77 Costa de Marfil vs Noruega
  'W78':'1I-3CDFGH',   // #78 Francia vs Suecia
  'W79':'1A-3CEFHI',   // #79 México vs Ecuador
  'W80':'1L-3EHIJK',   // #80 Inglaterra vs RD Congo
  'W81':'1D-3BEFIJ',   // #81 Estados Unidos vs Bosnia
  'W82':'1G-3AEHIJ',   // #82 Bélgica vs Senegal
  'W83':'1H-2J',       // #83 España vs Austria
  'W84':'2K-2L',       // #84 Portugal vs Croacia
  'W85':'1B-3EFGIJ',   // #85 Suiza vs Argelia
  'W86':'2D-2G',       // #86 Australia vs Egipto
  'W87':'1J-2H',       // #87 Argentina vs Cabo Verde
  'W88':'1K-3DEIJL',   // #88 Colombia vs Ghana
  // Octavos
  'W89':'W74-W78',     // #89 Paraguay vs Francia
  'W90':'W73-W75',     // #90 Canadá vs Marruecos
  'W91':'W76-W77',     // #91 Brasil vs Noruega
  'W92':'W79-W80',     // #92 México vs Inglaterra
  'W93':'W84-W83',     // #93 Portugal vs España
  'W94':'W81-W82',     // #94 Estados Unidos vs Bélgica
  'W95':'W87-W86',     // #95 Argentina vs Egipto (Australia)
  'W96':'W85-W88',     // #96 Suiza vs Colombia
  // Cuartos
  'W97':'W90-W89',     // #97 Francia vs Marruecos (09-jul)
  'W98':'W93-W94',     // #98 W93 vs W94 (10-jul)
  'W99':'W91-W92',     // #99 Noruega vs W92 (11-jul)
  'W100':'W95-W96',   // #100 W95 vs W96 (11-jul)
  // Semis
  'W101':'W97-W98',
  'W102':'W99-W100',
  'L101':'loser of W101','L102':'loser of W102'
};

function resolveKOCode(code, allResults, groupPos) {
  if (!code || code === '-') return null;
  // 1° o 2° o 3° o 4° de un grupo cerrado
  if (code.match(/^[1-4][A-L]$/)) return groupPos[code] || null;
  // Mejor 3° — tabla de asignación oficial FIFA para Mundial 2026
  // Grupos B,D,E,F,I,J,K,L clasificaron sus terceros
  if (code.match(/^3[A-L]{2,}$/)) {
    const BEST3_ASSIGNMENT = {
      '3ABCDF': '3D', // Paraguay
      '3CDFGH': '3F', // Sweden
      '3CEFHI': '3E', // Ecuador
      '3EHIJK': '3K', // DR Congo
      '3AEHIJ': '3I', // Senegal
      '3BEFIJ': '3B', // Bosnia & Herzegovina
      '3EFGIJ': '3J', // Algeria
      '3DEIJL': '3L', // Ghana
    };
    const assigned = BEST3_ASSIGNMENT[code];
    if (assigned && groupPos[assigned]) return groupPos[assigned];
    return null;
  }
  // Ganador de partido KO
  if (code.startsWith('W')) {
    const matchName = W_TO_MATCH[code];
    if (!matchName) return null;
    // Buscar resultado: primero por nombre del slot, luego por equipos resueltos
    let match = allResults[matchName];
    if (!match) {
      // Resolver los dos lados del partido a equipos reales y buscar
      const parts = matchName.split('-');
      const t1 = resolveKOCode(parts[0], allResults, groupPos);
      const t2 = resolveKOCode(parts.slice(1).join('-'), allResults, groupPos);
      if (t1 && t2) {
        // Buscar en allResults el partido con esos equipos
        for (const [k, v] of Object.entries(allResults)) {
          if (!v || !v.homeTeam || !v.awayTeam) continue;
          const nh = norm(v.homeTeam), na = norm(v.awayTeam);
          if ((nh===norm(t1)&&na===norm(t2))||(nh===norm(t2)&&na===norm(t1))) {
            match = v; break;
          }
        }
      }
    }
    if (!match || match.status !== 'FT') return null;
    if (match.homeScore > match.awayScore) return match.homeTeam;
    if (match.awayScore > match.homeScore) return match.awayTeam;
    // Empate → usar penaltyWinner detectado automáticamente, o PENALTY_WINNERS manual
    if (match.penaltyWinner) return match.penaltyWinner;
    const penKey1 = `${match.homeTeam}-${match.awayTeam}`;
    const penKey2 = `${match.awayTeam}-${match.homeTeam}`;
    return PENALTY_WINNERS[penKey1] || PENALTY_WINNERS[penKey2] || null;
  }
  // Perdedor de partido KO
  if (code.startsWith('L')) {
    const matchName = W_TO_MATCH[code.replace('L','W')];
    if (!matchName) return null;
    let match = allResults[matchName];
    if (!match) {
      const parts = matchName.split('-');
      const t1 = resolveKOCode(parts[0], allResults, groupPos);
      const t2 = resolveKOCode(parts.slice(1).join('-'), allResults, groupPos);
      if (t1 && t2) {
        for (const [k, v] of Object.entries(allResults)) {
          if (!v || !v.homeTeam || !v.awayTeam) continue;
          const nh = norm(v.homeTeam), na = norm(v.awayTeam);
          if ((nh===norm(t1)&&na===norm(t2))||(nh===norm(t2)&&na===norm(t1))) {
            match = v; break;
          }
        }
      }
    }
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
  // PRIORIDAD: si openfootball (wc.results) ya tiene este resultado, NO sobrescribir
  // openfootball es más confiable para el marcador de 90 min en partidos KO
  for(const [k,v] of Object.entries(live.liveResults)){
    if(v.status!=='LIVE' && v.status!=='FT') continue;
    if(results[k] && results[k].status==='FT' && results[k].isKO){
      // Ya tenemos este resultado de openfootball — solo copiar penaltyWinner si falta
      if(v.penaltyWinner && !results[k].penaltyWinner){
        results[k] = {...results[k], penaltyWinner: v.penaltyWinner};
      }
      continue;
    }
    results[k]=v;
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

function resolveSlotToTeam(code, results) {
  // Resolver cualquier código de slot a nombre de equipo
  if (!code) return null;
  // Código simple de grupo: 1A, 2B, 3C, 4D
  if (code.match(/^[1-4][A-L]$/)) {
    const r = results[code];
    return typeof r === 'string' ? r : (r && r.team ? r.team : null);
  }
  // Mejor 3°: 3ABCDF etc.
  if (code.match(/^3[A-L]{2,}$/)) {
    const BEST3 = {
      '3ABCDF':'3D','3CDFGH':'3F','3CEFHI':'3E','3EHIJK':'3K',
      '3AEHIJ':'3I','3BEFIJ':'3B','3EFGIJ':'3J','3DEIJL':'3L',
    };
    const assigned = BEST3[code];
    if (assigned) {
      const r = results[assigned];
      return typeof r === 'string' ? r : (r && r.team ? r.team : null);
    }
  }
  // Ganador de partido KO: W73, W74...
  if (code.startsWith('W') && W_TO_MATCH[code]) {
    // Primero buscar en results si ya está resuelto como Octavofinalista CLASSIFIED
    const r = results[code];
    if (r && r.team) return r.team;
    // Si no, resolver buscando el ganador del partido correspondiente
    // Buscar en resultados KO qué equipo ganó ese partido
    const matchSlot = W_TO_MATCH[code];
    if (matchSlot) {
      const matchResult = findKOResult(matchSlot, results);
      if (matchResult && matchResult.status === 'FT') {
        if (matchResult.penaltyWinner) return matchResult.penaltyWinner;
        if (matchResult.homeScore > matchResult.awayScore) return matchResult.homeTeam;
        if (matchResult.awayScore > matchResult.homeScore) return matchResult.awayTeam;
      }
    }
    return null;
  }
  return null;
}

function findKOResult(matchName, results) {
  // Para partidos KO, el nombre es "2A-2B", "1E-3ABCDF", "W73-W75" etc.
  const parts = matchName.split('-');
  if (parts.length < 2) return null;
  // Resolver cada parte a equipo real
  const code1 = parts[0];
  const code2 = parts.slice(1).join('-');
  const t1 = resolveSlotToTeam(code1, results);
  const t2 = resolveSlotToTeam(code2, results);
  if (!t1 || !t2) return null;
  // Buscar en results el partido con esos equipos
  for (const [k, v] of Object.entries(results)) {
    if (!v || !v.homeTeam || !v.awayTeam) continue;
    const nh = norm(v.homeTeam), na = norm(v.awayTeam);
    if ((nh===norm(t1)&&na===norm(t2))||(nh===norm(t2)&&na===norm(t1))) return v;
  }
  return null;
}

function getJornadaMatches(dateStr, results) {
  const dates = Array.isArray(dateStr) ? dateStr : [dateStr];
  
  // Partidos de grupo: filtrar por fecha del slot
  const groupMatches = PORRA.group_score.filter(m=>dates.includes(m.date));
  
  // Partidos KO: usar los partidos REALES de openfootball para esa fecha
  // y crear entradas virtuales para cada uno
  const koMatchesByDate = [];
  const seenKOPairs = new Set();
  
  for(const wcMatch of (global._wcMatchesByTeam||[])){
    if(!dates.includes(wcMatch.date)) continue;
    const key = [wcMatch.homeTeam, wcMatch.awayTeam].sort().join('-');
    if(seenKOPairs.has(key)) continue;
    seenKOPairs.add(key);
    
    // Buscar el slot del porra.json que mejor representa este partido
    // Buscar en results si hay un partido con estos equipos
    const wcKey1 = `${wcMatch.homeTeam}-${wcMatch.awayTeam}`;
    const wcKey2 = `${wcMatch.awayTeam}-${wcMatch.homeTeam}`;
    const wcResult = results[wcKey1] || results[wcKey2];

    // Calcular la ronda/max_pts real ANTES de buscar el slot, para que la
    // búsqueda solo acepte casilleros de la ronda correcta. Antes esto se
    // calculaba después, y si la primera búsqueda encontraba un casillero de
    // OTRA ronda (p.ej. un jugador que escribió el mismo par de equipos en un
    // casillero de Cuartos en vez de Semis), el código se quedaba con ese
    // resultado equivocado y nunca llegaba a buscar el casillero correcto.
    const realRoundEarly = wcMatch.round || null;
    const correctMaxPtsEarly = realRoundEarly === 'Round of 16' ? 20 :
                         realRoundEarly === 'Quarter-final' ? 31 :
                         realRoundEarly === 'Semi-final' ? 48 :
                         realRoundEarly === 'Match for third place' ? 62 :
                         realRoundEarly === 'Final' ? 84 :
                         realRoundEarly === 'Round of 32' ? 14 : 20;

    // Encontrar el slot del porra.json buscando predicciones que matcheen con estos equipos
    let bestSlot = null;
    for(const m of PORRA.ko_score){
      if(m.max_pts !== correctMaxPtsEarly) continue; // solo casilleros de la ronda correcta
      // Verificar si alguna predicción de este slot tiene estos equipos
      let hasMatch = false;
      for(const pd of Object.values(m.predictions)){
        const pred = pd.pred||'';
        if(!pred||!pred.includes('·')) continue;
        const teams = pred.split('·')[0].split('-',1)[0];
        // Revisar si este slot fue diseñado para este partido via resolución de equipos
        const r = findKOResult(m.name, results);
        if(r){
          if((norm(r.homeTeam)===norm(wcMatch.homeTeam)&&norm(r.awayTeam)===norm(wcMatch.awayTeam))||
             (norm(r.homeTeam)===norm(wcMatch.awayTeam)&&norm(r.awayTeam)===norm(wcMatch.homeTeam))){
            hasMatch = true;
          }
        }
        break; // solo necesitamos revisar una pred para saber si el slot resuelve
      }
      if(hasMatch){ bestSlot = m; break; }
    }
    // Buscar por predicciones que tengan estos equipos
    if(!bestSlot){
      const nt1=norm(wcMatch.homeTeam), nt2=norm(wcMatch.awayTeam);
      for(const m of PORRA.ko_score){
        if(m.max_pts !== correctMaxPtsEarly) continue; // solo casilleros de la ronda correcta
        let found=false;
        for(const pd of Object.values(m.predictions)){
          const pred=pd.pred||'';
          if(!pred.includes('·')) continue;
          const teamsStr=pred.split('·')[0];
          const pt1raw=teamsStr.split('-')[0].trim();
          const rest=teamsStr.split('-').slice(1).join('-').trim();
          const pt1=norm(ESP_TO_EN_SERVER[norm(pt1raw)]||norm(pt1raw));
          const pt2=norm(ESP_TO_EN_SERVER[norm(rest)]||norm(rest));
          if((pt1===nt1&&pt2===nt2)||(pt1===nt2&&pt2===nt1)){
            found=true; break;
          }
        }
        if(found){bestSlot=m;break;}
      }
    }
    
    // Usar slot encontrado o crear uno virtual
    const slotToUse = bestSlot || {
      name: `${wcMatch.homeTeam}-${wcMatch.awayTeam}`,
      date: wcMatch.date,
      max_pts: 20, bonus: 1,
      match_type: 'ko_score',
      predictions: {}
    };
    // Pasar datos del partido real para display correcto
    // SIEMPRE forzar nombre real del partido de openfootball
    // realRound/correctMaxPts ya se calcularon arriba (antes de buscar el slot)
    // para que la búsqueda solo aceptara casilleros de la ronda correcta.
    const realRound = realRoundEarly;
    const correctMaxPts = correctMaxPtsEarly;
    // Como bestSlot ya viene filtrado por ronda correcta (o es null), esto
    // prácticamente siempre será true — pero se deja como salvaguarda.
    const slotIsCorrectRound = !bestSlot || (bestSlot.max_pts === correctMaxPts);
    const koSlot = {
      ...(slotIsCorrectRound ? slotToUse : {}),
      name: `${wcMatch.homeTeam} vs ${wcMatch.awayTeam}`,
      match_type: 'ko_score',
      max_pts: correctMaxPts,
      bonus: slotIsCorrectRound ? (slotToUse.bonus || 1) : 1,
      predictions: slotIsCorrectRound ? (slotToUse.predictions || {}) : {},
      _realHomeTeam: wcMatch.homeTeam,
      _realAwayTeam: wcMatch.awayTeam,
      _realDate: wcMatch.date,
      _realRound: realRound,
      _realScore: wcMatch.homeScore!=null ? {homeScore:wcMatch.homeScore,awayScore:wcMatch.awayScore,status:wcMatch.status,round:realRound} : null
    };
    koMatchesByDate.push(koSlot);
  }
  
  return [...groupMatches, ...koMatchesByDate].map(m=>{
    // isKO: true para slots de ko_score (incluyendo virtuales)
    const isKO = m.match_type === 'ko_score';
    let r = null;
    if (!isKO) {
      r = results[m.name]; // grupo: buscar por nombre del slot
    } else {
      // Para KO, usar resultado real si viene del partido de openfootball
      if (m._realScore) r = {...m._realScore, homeTeam:m._realHomeTeam, awayTeam:m._realAwayTeam, isKO:true};
      // Si no, buscar por equipos en results
      if (!r) r = findKOResult(m.name, results);
      // Último intento: buscar por nombre real del partido
      if (!r && m._realHomeTeam) {
        const key = `${m._realHomeTeam}-${m._realAwayTeam}`;
        r = results[key];
      }
    }
    let result = m.result;
    if (r && r.homeScore != null) result = toResultFmt(r.homeScore, r.awayScore);
    // Nombre legible para KO
    let displayName = m.name;
    if (isKO && r && r.homeTeam && r.awayTeam) {
      displayName = `${r.homeTeam} vs ${r.awayTeam}`;
    } else if (isKO) {
      // Usar nombres reales si vienen del partido real de openfootball
      if (m._realHomeTeam && m._realAwayTeam) {
        displayName = `${m._realHomeTeam} vs ${m._realAwayTeam}`;
      } else {
        const parts = m.name.split('-');
        const n1 = resolveSlotToTeam(parts[0], results) || parts[0];
        const n2 = resolveSlotToTeam(parts.slice(1).join('-'), results) || parts.slice(1).join('-');
        displayName = `${n1} vs ${n2}`;
      }
    }
    const playerResults=Object.entries(m.predictions).map(([name,pd])=>({
      name,pred:pd.pred,
      pts:isKO
        ?(r?calcKOScore(pd.pred,r,m.max_pts,m.bonus)||0:null)
        :(result&&result!=='-'?calcGroupScore(pd.pred,result,m.bonus):null)
    })).map(pr=>{
      // Para partidos KO: validar que la predicción sea del slot de la ronda correcta
      // Si el slot original (slotToUse) tiene max_pts diferente al partido real, 
      // la predicción es de otra ronda → 0 pts
      if(isKO && pr.pts && m._slotOrigMaxPts && m._slotOrigMaxPts !== m.max_pts){
        return {...pr, pts:0};
      }
      return pr;
    });
    const realStatus = m._realScore?.status || r?.status || 'NS';
    return {...m,name:displayName||m.name,slotName:m.name,result,liveStatus:realStatus,espnResult:r,playerResults};
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

// Calcula, para un conjunto de fechas, los puntos por CLASIFICACIÓN de ronda
// (posición de grupo, 16avos, octavos, cuartos, semis, final, 3er/4to puesto)
// que corresponden a cada jugador ESE día. Es la única fuente de verdad para esto:
// tanto /api/jornada como /api/analysis/:type (crónica) deben usar esta misma función,
// para no volver a desincronizarse (bug ya ocurrido: la crónica no incluía Cuartos+).
function computeClassificationBonusToday(dateStr, results) {
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

  // Octavofinalistas: solo equipos que ganaron partidos de 16avos EN ESTA FECHA
  const r16TodaySlots = new Set(
    PORRA.ko_score.filter(m=>dates.includes(m.date)).map(m=>m.name)
  );
  const classified8Today=new Set();
  for(const m of PORRA.ko_team.filter(m=>m.name.startsWith('Octavofinalista'))){
    const espn=results[m.name];
    if(!espn||espn.status!=='CLASSIFIED'||!espn.team) continue;
    const w = m.result;
    if(W_TO_MATCH && W_TO_MATCH[w]){
      const slot16 = W_TO_MATCH[w];
      if(r16TodaySlots.has(slot16)){
        classified8Today.add(espn.team);
      }
    }
  }
  const ko8Pts={};
  if(classified8Today.size>0){
    const tracked8={};
    for(const m of PORRA.ko_team.filter(m=>m.name.startsWith('Octavofinalista'))){
      for(const [pName,pd] of Object.entries(m.predictions)){
        if(!tracked8[pName]) tracked8[pName]=new Set();
        let hit=false;
        for(const actual of classified8Today){
          if((calcTeamPred(pd.pred,actual,m.max_pts)||0)>0){hit=true;break;}
        }
        if(!hit) continue;
        const key='8_'+(pd.pred||'').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/[^a-z0-9]/g,'');
        if(tracked8[pName].has(key)) continue;
        tracked8[pName].add(key);
        ko8Pts[pName]=(ko8Pts[pName]||0)+m.max_pts;
      }
    }
  }

  // Cuartofinalistas: ganadores de partidos de Octavos de hoy
  const classified4Today=new Set();
  for(const wm of (global._wcMatchesByTeam||[])){
    if(!dates.includes(wm.date)) continue;
    if(wm.round!=='Round of 16') continue;
    if(wm.homeScore==null) continue;
    let winner=null;
    if(wm.homeScore>wm.awayScore) winner=wm.homeTeam;
    else if(wm.awayScore>wm.homeScore) winner=wm.awayTeam;
    else if(wm.penaltyWinner) winner=wm.penaltyWinner;
    if(winner) classified4Today.add(winner);
  }
  const ko4Pts={};
  if(classified4Today.size>0){
    const tracked4={};
    for(const m of PORRA.ko_team.filter(m=>m.name.startsWith('Cuartofinalista'))){
      for(const [pName,pd] of Object.entries(m.predictions)){
        if(!tracked4[pName]) tracked4[pName]=new Set();
        let hit=false;
        for(const actual of classified4Today){
          if((calcTeamPred(pd.pred,actual,m.max_pts)||0)>0){hit=true;break;}
        }
        if(!hit) continue;
        const key='4_'+(pd.pred||'').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g,'').replace(/[^a-z0-9]/g,'');
        if(tracked4[pName].has(key)) continue;
        tracked4[pName].add(key);
        ko4Pts[pName]=(ko4Pts[pName]||0)+m.max_pts;
      }
    }
  }

  // Semifinalistas: ganadores de Cuartos de hoy
  const classified2Today=new Set();
  for(const wm of (global._wcMatchesByTeam||[])){
    if(!dates.includes(wm.date)) continue;
    if(wm.round!=='Quarter-final') continue;
    if(wm.homeScore==null) continue;
    let winner=null;
    if(wm.homeScore>wm.awayScore) winner=wm.homeTeam;
    else if(wm.awayScore>wm.homeScore) winner=wm.awayTeam;
    else if(wm.penaltyWinner) winner=wm.penaltyWinner;
    if(winner) classified2Today.add(winner);
  }
  const ko2Pts={};
  if(classified2Today.size>0){
    const tracked2={};
    for(const m of PORRA.ko_team.filter(m=>m.name.startsWith('Semifinalista'))){
      for(const [pName,pd] of Object.entries(m.predictions)){
        if(!tracked2[pName]) tracked2[pName]=new Set();
        let hit=false;
        for(const actual of classified2Today){
          if((calcTeamPred(pd.pred,actual,m.max_pts)||0)>0){hit=true;break;}
        }
        if(!hit) continue;
        const key='2_'+(pd.pred||'').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g,'').replace(/[^a-z0-9]/g,'');
        if(tracked2[pName].has(key)) continue;
        tracked2[pName].add(key);
        ko2Pts[pName]=(ko2Pts[pName]||0)+m.max_pts;
      }
    }
  }

  // Finalistas: ganadores de Semis de hoy
  const classifiedFinalToday=new Set();
  for(const wm of (global._wcMatchesByTeam||[])){
    if(!dates.includes(wm.date)) continue;
    if(wm.round!=='Semi-final') continue;
    if(wm.homeScore==null) continue;
    let winner=null;
    if(wm.homeScore>wm.awayScore) winner=wm.homeTeam;
    else if(wm.awayScore>wm.homeScore) winner=wm.awayTeam;
    else if(wm.penaltyWinner) winner=wm.penaltyWinner;
    if(winner) classifiedFinalToday.add(winner);
  }
  const koFinalPts={};
  if(classifiedFinalToday.size>0){
    const trackedF={};
    for(const m of PORRA.ko_team.filter(m=>m.name.startsWith('Finalista'))){
      for(const [pName,pd] of Object.entries(m.predictions)){
        if(!trackedF[pName]) trackedF[pName]=new Set();
        let hit=false;
        for(const actual of classifiedFinalToday){
          if((calcTeamPred(pd.pred,actual,m.max_pts)||0)>0){hit=true;break;}
        }
        if(!hit) continue;
        const key='f_'+(pd.pred||'').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g,'').replace(/[^a-z0-9]/g,'');
        if(trackedF[pName].has(key)) continue;
        trackedF[pName].add(key);
        koFinalPts[pName]=(koFinalPts[pName]||0)+m.max_pts;
      }
    }
  }

  // 3er/4to puesto: equipos que perdieron Semis y juegan el partido de consolación
  const classified3Today=new Set();
  for(const m of PORRA.ko_team.filter(m=>m.name.startsWith('3º y 4º'))){
    const espn=results[m.name];
    if(!espn||espn.status!=='CLASSIFIED'||!espn.team) continue;
    classified3Today.add(espn.team);
  }
  const ko3Pts={};
  if(classified3Today.size>0){
    const tracked3={};
    for(const m of PORRA.ko_team.filter(m=>m.name.startsWith('3º y 4º')||m.name.startsWith('3-4'))){
      for(const [pName,pd] of Object.entries(m.predictions)){
        if(!tracked3[pName]) tracked3[pName]=new Set();
        let hit=false;
        for(const actual of classified3Today){
          if((calcTeamPred(pd.pred,actual,m.max_pts)||0)>0){hit=true;break;}
        }
        if(!hit) continue;
        const key='3_'+(pd.pred||'').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g,'').replace(/[^a-z0-9]/g,'');
        if(tracked3[pName].has(key)) continue;
        tracked3[pName].add(key);
        ko3Pts[pName]=(ko3Pts[pName]||0)+m.max_pts;
      }
    }
  }

  // 16avos clasificados en estas fechas
  const groupsClosingToday=new Set();
  for(const m of PORRA.group_pos.filter(m=>dates.includes(m.date))){
    const match=m.result.match(/^[1-4]([A-L])$/);
    if(match) groupsClosingToday.add(match[1]);
  }
  const classified16Today=new Set();
  for(const m of PORRA.ko_team.filter(m=>m.name.startsWith('Dieciseisavofinalista'))){
    const espn=results[m.name];
    if(!espn||espn.status!=='CLASSIFIED'||!espn.team) continue;
    const code=m.result;
    if(code.match(/^[12][A-L]$/)){
      const g=code[1];
      if(groupsClosingToday.has(g)) classified16Today.add(espn.team);
    }
  }
  const ko16Pts={};
  if(classified16Today.size>0){
    const tracked={};
    for(const m of PORRA.ko_team.filter(m=>m.name.startsWith('Dieciseisavofinalista'))){
      for(const [pName,pd] of Object.entries(m.predictions)){
        if(!tracked[pName]) tracked[pName]=new Set();
        let hit=false;
        for(const actual of classified16Today){
          if((calcTeamPred(pd.pred,actual,2)||0)>0){hit=true;break;}
        }
        if(!hit) continue;
        const key='16_'+(pd.pred||'').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/[^a-z0-9]/g,'');
        if(tracked[pName].has(key)) continue;
        tracked[pName].add(key);
        ko16Pts[pName]=(ko16Pts[pName]||0)+2;
      }
    }
  }

  return {groupPosPts, ko16Pts, ko8Pts, ko4Pts, ko2Pts, koFinalPts, ko3Pts};
}

function buildPremiosFecha(jornadaMatches, trueTotalsMap = null) {
  const allPreds=[];
  for(const m of jornadaMatches){
    if(!m.result||m.result==='-') continue;
    for(const pr of (m.playerResults||[]))
      allPreds.push({...pr,match:m.name,result:m.result,bonus:m.bonus,maxPts:m.max_pts});
  }
  const byPlayer={};
  for(const pr of allPreds){
    if(!byPlayer[pr.name]) byPlayer[pr.name]={name:pr.name,pts:0,exactos:[],matches:[]};
    byPlayer[pr.name].pts+=pr.pts||0;
    byPlayer[pr.name].matches.push(pr);
    if(pr.pts===pr.maxPts&&pr.maxPts>0) byPlayer[pr.name].exactos.push(pr.match);
  }
  // Si viene el mapa de puntos TOTALES del día (partidos + clasificados por grupo/ronda),
  // lo usamos para las categorías de puntaje agregado (líder, mala suerte, zona de peligro)
  // en vez de solo los puntos de partidos con marcador exacto/diferencia/signo.
  // Así un jugador que solo sumó por equipos clasificados ese día no aparece con "0 puntos".
  if (trueTotalsMap) {
    for (const name of Object.keys(trueTotalsMap)) {
      if (!byPlayer[name]) byPlayer[name] = {name, pts:0, exactos:[], matches:[]};
    }
  }
  if(!Object.keys(byPlayer).length) return null;
  const totalPtsFor = (name) => trueTotalsMap ? (trueTotalsMap[name]||0) : (byPlayer[name]?.pts||0);
  const players=Object.values(byPlayer);
  const maxPts=Math.max(...players.map(p=>totalPtsFor(p.name)));
  const minPts=Math.min(...players.map(p=>totalPtsFor(p.name)));
  const topPlayers=players.filter(p=>totalPtsFor(p.name)===maxPts);
  const bottomPlayers=players.filter(p=>totalPtsFor(p.name)===minPts&&minPts<maxPts*0.4);
  const exactPlayers=players.filter(p=>p.exactos.length>0);
  const smartPlayers=players.filter(p=>p.matches.some(m=>{
    const r=m.result?.split('|'),pred=m.pred?.split('|');
    if(!r||!pred||r[0]!==pred[0]) return false;
    const [rh,ra]=(r[1]||'').split('-').map(Number);
    const [ph,pa]=(pred[1]||'').split('-').map(Number);
    return (rh-ra===ph-pa)&&(rh!==ph);
  })).filter(p=>!topPlayers.includes(p));
  return {
    jugadoresFecha:{names:topPlayers.map(p=>p.name),pts:maxPts,desc:`${topPlayers.length} jugador(es) lideran con ${maxPts} pts (partidos + clasificados)`},
    reyBonus:{names:topPlayers.slice(0,1).map(p=>p.name),pts:maxPts,desc:'Máximo aprovechamiento'},
    francotiradores:{names:exactPlayers.map(p=>p.name),desc:`${exactPlayers.length} acertaron resultado exacto`},
    malaSuerte:{names:bottomPlayers.map(p=>p.name),pts:minPts,desc:bottomPlayers.length?`Solo ${minPts} pts en total (partidos + clasificados)`:''},
    jugadaInteligente:{names:smartPlayers.slice(0,5).map(p=>p.name),desc:'Diferencia correcta, no el exacto'},
    zonaPeligro:{names:players.filter(p=>totalPtsFor(p.name)===0).map(p=>p.name),desc:'Sin puntos en la jornada (ni por partidos ni por clasificados)'}
  };
}

async function generateGPTAnalysis(type, context) {
  if(!ANTHROPIC_API_KEY) return '⚠️ Configura ANTHROPIC_API_KEY en Railway Variables.';
  try {
    const prompts = {
      impacto:`Eres el analista de una porra de fútbol entre amigos chilenos. Con estos datos genera un análisis de impacto en español informal y entretenido (máx 300 palabras). Incluye: qué partidos generaron más movimiento, grupos de puntos, caída del día, partido bonus más decisivo. IMPORTANTE: USA SOLO los resultados que aparecen en los datos. Si un partido dice "Pendiente", NO inventes resultado. Solo menciona resultados con status "FT".

Datos: ${JSON.stringify(context)}`,
      cronica:`Eres el cronista oficial de la porra del Mundial. Tu trabajo es escribir la novela diaria de esta competencia entre 50 participantes. Los partidos son solo el escenario. La historia real ocurre entre ellos.

REGLA ABSOLUTA: SOLO usa resultados del campo "partidos". NUNCA inventes marcadores. Si un partido no tiene resultado confirmado, no lo menciones como finalizado.

SOBRE PUNTOS: "ptsHoy" (en rankingJornada) y los puntajes de "premios" ya son el TOTAL del día: puntos por partidos con marcador MÁS puntos por equipos que clasificaron de ronda ese día. Un jugador puede sumar puntos hoy sin haber acertado ningún marcador, solo porque un equipo que puso avanzó de ronda. NUNCA digas que alguien "no sumó puntos" o tuvo "0 puntos" salvo que su ptsHoy sea exactamente 0. No confundas "no acertó ningún resultado exacto" con "no sumó puntos".

ADN DEL ESTILO (voz propia, no imitar literalmente):
- 40% Fontanarrosa: humor inteligente, ironía, picardía, comparaciones inesperadas
- 30% Soriano: personajes, historias pequeñas que parecen enormes, humanidad, nostalgia
- 20% Sacheri: amistad, emoción, cotidianidad, el detalle memorable
- 10% Galeano: SOLO para apertura o cierre, una metáfora potente, máximo un párrafo

TONO: Como tres amigos comentando la fecha después de un asado. Nunca solemne. Nunca grandilocuente. Elegante pero entretenido. El lector debe sonreír constantemente.

LOS PERSONAJES: Los 50 participantes NO son nombres, son personajes con identidad. Asígnales roles según su desempeño (el estratega, el cazador de sorpresas, el eterno escolta, el puntero nervioso, el kamikaze, el sobreviviente, el que apuesta con el corazón). Hazlos evolucionar.

RUNNING GAGS: Crea bromas recurrentes basadas en patrones ("Otra vez acertó el resultado imposible y falló el más fácil", "Ya nadie entiende cómo sigue puntero"). Mientras más continuidad, mejor.

ESTRUCTURA:
1. TÍTULO: Nombre de capítulo de novela. Nunca repetir estructuras.
2. APERTURA (máx 2 párrafos): Con humor. Reflexión breve. Sin resultados aún.
3. HISTORIA DE LA JORNADA: Narrar cómo cambió el campeonato. Usa rankingJornada (campo ptsHoy) para quién brilló HOY. Los resultados son el escenario.
4. PROTAGONISTAS (3 a 6): No necesariamente los de más puntos. Los de mejor historia hoy.
5. PREMIOS DEL DÍA: Categorías distintas cada día con emojis. Inventar siempre nuevas.
6. CÓMO QUEDA EL CAMPEONATO: Interpretar rankingGeneral, no leerlo. Quién presiona, quién resiste, quién amenaza, quién sueña.
7. CIERRE MEMORABLE: Frase que parezca final de capítulo. Con expectativa. Nunca "hasta mañana".

PROHIBIDO: Escribir como noticia o informe. Hacer listas de resultados. Repetir metáforas. Abusar de "destino", "almas", "epopeya", "batalla", "héroes".

OBJETIVO: Que todos busquen su nombre, se rían, discutan la crónica tanto como los partidos y esperen la de mañana.

Entre 900 y 1.100 palabras. Ritmo. Sin párrafos eternos.

Datos: ${JSON.stringify(context)}`
    };
    const data = await fetchJSON('https://api.anthropic.com/v1/messages', {
      method:'POST',
      headers:{'x-api-key':ANTHROPIC_API_KEY,'anthropic-version':'2023-06-01','Content-Type':'application/json'},
      body:JSON.stringify({model:'claude-haiku-4-5-20251001',max_tokens:2000,messages:[{role:'user',content:prompts[type]}]}),
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
    // Incluir también fechas de partidos KO reales de openfootball
    const wcKODates = (global._wcMatchesByTeam||[]).map(m=>m.date).filter(Boolean);
    const allDates=[...new Set([
      ...[...PORRA.group_score,...PORRA.ko_score].map(m=>m.date).filter(Boolean),
      ...wcKODates
    ])].sort();

    // Puntos por clasificación de ronda (grupo, 16avos, octavos, cuartos, semis, final, 3ro/4to)
    // usando la MISMA función que la crónica, para que ambas vistas coincidan siempre.
    const dates=Array.isArray(dateStr)?dateStr:[dateStr];
    const {groupPosPts, ko16Pts, ko8Pts, ko4Pts, ko2Pts, koFinalPts, ko3Pts} = computeClassificationBonusToday(dateStr, results);

    // Enriquecer summary con pts de pos_grupos y ko_16 de hoy
    // todayPts y variation = partidos + posgrupo + 16avos
    const summaryEnriched=summary.map(p=>{
      const matchPts=p.todayPts||0;
      const gpp=groupPosPts[p.name]||0;
      const k16=ko16Pts[p.name]||0;
      const k8=ko8Pts[p.name]||0;
      const k4=ko4Pts[p.name]||0;
      const k2=ko2Pts[p.name]||0;
      const kF=koFinalPts[p.name]||0;
      const k3=ko3Pts[p.name]||0;
      const totalHoy=matchPts+gpp+k16+k8+k4+k2+kF+k3;
      return {...p, matchPts, groupPosPts:gpp, ko16Pts:k16, ko8Pts:k8, ko4Pts:k4, ko2Pts:k2, koFinalPts:kF, ko3Pts:k3, todayPts:totalHoy, variation:totalHoy};
    }).sort((a,b)=>b.todayPts-a.todayPts||b.total-a.total).map((p,i,arr)=>{
      // Recalcular jornadaPos con el nuevo orden
      let jp=1;
      for(let x=0;x<i;x++) if(arr[x].todayPts>p.todayPts) jp=x+2;
      return {...p, jornadaPos:jp};
    });
    // Premios/badges de la jornada calculados con el total REAL del día
    // (partidos + clasificados por grupo/ronda), no solo puntos de partidos con marcador,
    // para que "Zona de Peligro" no marque a alguien que sí sumó por equipos clasificados.
    const trueTotalsMap={};
    for(const p of summaryEnriched) trueTotalsMap[p.name]=p.todayPts||0;
    const premios=buildPremiosFecha(jornadaMatches, trueTotalsMap);

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
    // Puntos por clasificación de ronda (misma función que usa /api/jornada,
    // incluye grupo, 16avos, octavos, cuartos, semis, final y 3ro/4to puesto).
    const {groupPosPts:groupPosPtsCron, ko16Pts:ko16PtsCron, ko8Pts:ko8PtsCron, ko4Pts:ko4PtsCron, ko2Pts:ko2PtsCron, koFinalPts:koFinalPtsCron, ko3Pts:ko3PtsCron} = computeClassificationBonusToday(dateStr, results);
    const summaryEnrichedCron=summary.map(p=>{
      const matchPts=p.todayPts||0;
      const gpp=groupPosPtsCron[p.name]||0;
      const k16=ko16PtsCron[p.name]||0;
      const k8=ko8PtsCron[p.name]||0;
      const k4=ko4PtsCron[p.name]||0;
      const k2=ko2PtsCron[p.name]||0;
      const kF=koFinalPtsCron[p.name]||0;
      const k3=ko3PtsCron[p.name]||0;
      const totalHoy=matchPts+gpp+k16+k8+k4+k2+kF+k3;
      return {...p,todayPts:totalHoy};
    }).sort((a,b)=>b.todayPts-a.todayPts||b.total-a.total);
    // Premios/badges calculados con el total REAL del día (partidos + clasificados),
    // igual que en /api/jornada, para que la crónica no diga "0 puntos" a quien sí sumó
    // por equipos clasificados.
    const trueTotalsMapCron={};
    for(const p of summaryEnrichedCron) trueTotalsMapCron[p.name]=p.todayPts||0;
    const premios=buildPremiosFecha(jornadaMatches, trueTotalsMapCron);
    // Formatear resultados de forma clara para evitar alucinaciones de la IA
    const matchesForCron = jornadaMatches.map(m=>{
      let resultStr = 'No jugado aún';
      if(m.liveStatus === 'FT' && m.espnResult){
        const r = m.espnResult;
        resultStr = `${r.homeTeam} ${r.homeScore} - ${r.awayScore} ${r.awayTeam} (Final)`;
      } else if(m.liveStatus === 'LIVE' && m.espnResult){
        const r = m.espnResult;
        resultStr = `${r.homeTeam} ${r.homeScore} - ${r.awayScore} ${r.awayTeam} (En vivo)`;
      } else if(m.liveStatus === 'FT' && m.result && m.result !== '-'){
        resultStr = `Resultado: ${m.result} (Final)`;
      }
      return { name:m.name, resultado:resultStr, status:m.liveStatus||'NS' };
    });
    const context={
      date:dateStr,
      IMPORTANTE:'USA SOLO los resultados del campo "partidos". NUNCA inventes marcadores.',
      partidos:matchesForCron,
      rankingGeneral:standings.slice(0,5).map((p,i)=>({pos:i+1,name:p.name,total:p.total})),
      rankingJornada:summaryEnrichedCron.slice(0,10).map((p,i)=>({pos:i+1,name:p.name,ptsHoy:p.todayPts,totalGeneral:p.total})),
      premios
    };
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
    const pronosticos=jornadaMatches.map(m=>{
      const isKO = m.match_type === 'ko_score';
      // Para KO: usar _realScore (del partido real de openfootball) o espnResult
      const espnResult = isKO ? (m._realScore ? {...m._realScore, homeTeam:m._realHomeTeam, awayTeam:m._realAwayTeam} : m.espnResult) : null;
      const resultFmt = isKO && espnResult && espnResult.homeScore!=null
        ? toResultFmt(espnResult.homeScore, espnResult.awayScore)
        : (m.result||'-');
      // Para KO: filtrar solo jugadores que predijeron exactamente esos equipos
      // Usar _realHomeTeam/_realAwayTeam para obtener los equipos reales
      const koTeam1 = m._realHomeTeam || (espnResult && espnResult.homeTeam) || null;
      const koTeam2 = m._realAwayTeam || (espnResult && espnResult.awayTeam) || null;
      let players;
      if(isKO && koTeam1 && koTeam2){
        const nt1=norm(koTeam1), nt2=norm(koTeam2);
        // Usar SOLO las predicciones del koSlot (m.predictions)
        // que ya tiene predictions:{} si el slot es de ronda incorrecta
        const allKOPreds = {};
        for(const [pname,pd] of Object.entries(m.predictions||{})){
          if(!pd.pred||!pd.pred.includes('·')) continue;
          const teams=pd.pred.split('·')[0];
          const parts=teams.split('-');
          if(parts.length<2) continue;
          const pt1=norm(ESP_TO_EN_SERVER[norm(parts[0].trim())]||norm(parts[0].trim()));
          const pt2=norm(ESP_TO_EN_SERVER[norm(parts.slice(1).join('-').trim())]||norm(parts.slice(1).join('-').trim()));
          if((pt1===nt1&&pt2===nt2)||(pt1===nt2&&pt2===nt1)){
            if(!allKOPreds[pname]) allKOPreds[pname]={pred:pd.pred,maxPts:m.max_pts,bonus:m.bonus||1};
          }
        }
        players=Object.entries(allKOPreds).map(([name,p])=>({
          name,pred:p.pred,
          pts:calcKOScore(p.pred,espnResult,p.maxPts,p.bonus)||0
        })).sort((a,b)=>(b.pts||0)-(a.pts||0));
      } else if(isKO && koTeam1 && koTeam2){
        // Partido KO pendiente: usar SOLO m.predictions (ya filtrado por ronda)
        const snt1 = norm(koTeam1);
        const snt2 = norm(koTeam2);
        const allKOPredsPending = {};
        for(const [pname,pd] of Object.entries(m.predictions||{})){
          if(!pd.pred||!pd.pred.includes('·')) continue;
          const teams=pd.pred.split('·')[0];
          const parts=teams.split('-');
          if(parts.length<2) continue;
          const pt1=norm(ESP_TO_EN_SERVER[norm(parts[0].trim())]||norm(parts[0].trim()));
          const pt2=norm(ESP_TO_EN_SERVER[norm(parts.slice(1).join('-').trim())]||norm(parts.slice(1).join('-').trim()));
          if(snt1&&snt2){
            if((pt1===snt1&&pt2===snt2)||(pt1===snt2&&pt2===snt1)){
              if(!allKOPredsPending[pname]) allKOPredsPending[pname]=pd.pred;
            }
          }
        }
        players=Object.entries(allKOPredsPending).map(([name,pred])=>({
          name,pred,pts:null
        }));
      } else {
        players=Object.entries(m.predictions).map(([name,pd])=>({
          name,pred:pd.pred,
          pts:m.result&&m.result!=='-'?calcGroupScore(pd.pred,m.result,m.bonus):null
        })).sort((a,b)=>(b.pts||0)-(a.pts||0));
      }
      // Para KO: calcular quiénes tienen cada equipo en octavos (cualquier slot)
      let team1Players = [], team2Players = [], nextRound = 'Octavofinalista';
      if(isKO){
        // Obtener equipos del partido — desde espnResult o desde displayName
        let team1, team2;
        if(espnResult && espnResult.homeTeam){
          team1 = espnResult.homeTeam;
          team2 = espnResult.awayTeam;
        } else {
          // displayName es "Brazil vs Japan" o "Germany vs Paraguay"
          const vsParts = m.name.split(' vs ');
          if(vsParts.length === 2){
            team1 = vsParts[0].trim();
            team2 = vsParts[1].trim();
          }
        }
        // Determinar la ronda KO siguiente según el partido actual
        // Usar max_pts del partido para determinar la siguiente fase
        // max_pts=20 → Octavos → siguiente=Cuartos
        // max_pts=31 → Cuartos → siguiente=Semis
        // max_pts=48 → Semis → siguiente=Final
        // max_pts=14 → 16avos → siguiente=Octavos
        const matchMaxPts = m.max_pts || 14;
        nextRound = matchMaxPts <= 14 ? 'Octavofinalista' :
                    matchMaxPts <= 20 ? 'Cuartofinalista' :
                    matchMaxPts <= 31 ? 'Semifinalista' :
                    matchMaxPts <= 48 ? 'Finalista' : 'Octavofinalista';
        const nextSlots = PORRA.ko_team.filter(m=>m.name.startsWith(nextRound));
        console.log(`[TEAM_PLAYERS] team1=${team1} team2=${team2} nextSlots=${nextSlots.length}`);
        if(team1){
          const seen = new Set();
          for(const slot of nextSlots){
            for(const [pname,pd] of Object.entries(slot.predictions)){
              if(seen.has(pname)) continue;
              if((calcTeamPred(pd.pred,team1,slot.max_pts)||0)>0){
                seen.add(pname);
                team1Players.push(pname);
              }
            }
          }
          console.log(`[TEAM_PLAYERS] ${team1}: ${team1Players.length} jugadores`);
        }
        if(team2){
          const seen = new Set();
          for(const slot of nextSlots){
            for(const [pname,pd] of Object.entries(slot.predictions)){
              if(seen.has(pname)) continue;
              if((calcTeamPred(pd.pred,team2,slot.max_pts)||0)>0){
                seen.add(pname);
                team2Players.push(pname);
              }
            }
          }
          console.log(`[TEAM_PLAYERS] ${team2}: ${team2Players.length} jugadores`);
        }
      }
      return {
        match:m.name,date:m.date,bonus:m.bonus,maxPts:m.max_pts,
        match_type:m.match_type||'group_score',
        result:isKO && espnResult
          ? `${espnResult.homeTeam} ${espnResult.homeScore}-${espnResult.awayScore} ${espnResult.awayTeam}`
          : (m.result||'-'),
        status:m.liveStatus||'NS',
        players,
        nextRoundLabel: isKO ? (
                        nextRound === 'Octavofinalista' ? 'Octavos' :
                        nextRound === 'Cuartofinalista' ? 'Cuartos' :
                        nextRound === 'Semifinalista' ? 'Semis' : 'Final'
                        ) : null,
        team1Players, team2Players
      };
    });
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
app.get('/api/visits',(req,res)=>res.json({ok:true,today:visitCounter.today,total:visitCounter.total,date:visitCounter.date}));
app.get('*',(req, res)=>{
  if(!req.path.startsWith('/api')) trackVisit();
  res.sendFile(path.join(__dirname,'public','index.html'));
});
app.listen(PORT,()=>console.log(`🏆 Porra en vivo → http://localhost:${PORT}`));
