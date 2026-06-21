const express = require('express');
const path = require('path');
const fs = require('fs');
const { recalcStandings, findExcelMatchForESPN, toResultFmt, calcGroupScore, namesMatch } = require('./scoring');
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

// FIX #3: Santiago timezone date (Chile = UTC-4 in winter Jun-Aug, UTC-3 in summer)
function getSantiagoDate(d) {
  // Try Intl first; fall back to explicit UTC-4 offset (Chilean winter)
  try {
    const dt = d ? new Date(d) : new Date();
    const str = dt.toLocaleDateString('en-CA', {timeZone:'America/Santiago'});
    if (str && str.match(/^\d{4}-\d{2}-\d{2}$/)) return str;
  } catch(e) {}
  // Fallback: explicit UTC-4 (CLT, Chilean winter)
  const ms = (d ? new Date(d) : new Date()).getTime() - 4 * 3600000;
  return new Date(ms).toISOString().slice(0,10);
}
function getTodayStr() { return getSantiagoDate(); }
// Returns [today, yesterday] in Santiago time to catch UTC-7 stadium games
function getTodayDates() {
  const today = getTodayStr();
  const ms = new Date().getTime() - 4*3600000 - 86400000;
  const yesterday = new Date(ms).toISOString().slice(0,10);
  return [today, yesterday];
}

// ─── Cache ─────────────────────────────────────────────────────────────
let wcCache   = { results:{}, matches:[], ts:0 };
let liveCache = { liveResults:{}, liveMatches:[], ts:0 };

// ─── Source 1: openfootball (historical results) ───────────────────────
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

// ─── Source 2: football-data.org (LIVE scores) ─────────────────────────
// FIX #2: Real live scores from football-data.org
async function refreshLive() {
  const now = Date.now();
  if(now - liveCache.ts < 30000) return liveCache; // every 30s

  const liveResults={}, liveMatches=[];

  if(!FOOTBALL_API_KEY) {
    // Fallback to ESPN if no football-data key
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
    // football-data.org API — World Cup 2026 competition ID = 2000
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
      // Also fetch today's finished matches
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
      if(Object.keys(liveResults).length) console.log(`[FD] Live/today: ${Object.keys(liveResults).length} matches`);
    } catch(e){ console.error('[football-data]',e.message); }
  }

  liveCache={liveResults,liveMatches,ts:now};
  return liveCache;
}

// ─── Merged results ────────────────────────────────────────────────────
async function getResults() {
  const [wc, live] = await Promise.all([refreshWC(), refreshLive()]);
  const results = {...wc.results};for(const [k,v] of Object.entries(live.liveResults)){if(v.status==='LIVE'||!results[k])results[k]=v;}
  const allMatches = wc.matches.map(m => {
    const liveM = live.liveMatches.find(l=>l.excelName===m.excelName);
    if(liveM) return {...m,...liveM};
    return m;
  });
  const liveCount = live.liveMatches.filter(m=>m.status==='LIVE').length;
  return {results, matches:allMatches, liveCount};
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
  if(!ANTHROPIC_API_KEY) return '⚠️ Configura ANTHROPIC_API_KEY en Railway Variables. Ve a railway.app → tu proyecto → Variables → New Variable → ANTHROPIC_API_KEY → tu clave de console.anthropic.com';
  try {
    const prompts = {
      impacto:`Eres el analista de una porra de fútbol entre amigos chilenos. Con estos datos genera un análisis de impacto en español informal y entretenido (máx 300 palabras). Incluye: qué partidos generaron más movimiento, grupos de puntos, caída del día, partido bonus más decisivo. Datos: ${JSON.stringify(context)}`,
      cronica:`Eres el cronista de una porra de fútbol entre amigos chilenos. Escribe una crónica narrativa, emotiva e informal en español (máx 350 palabras). Menciona nombres reales, drama, subidas y caídas. Datos: ${JSON.stringify(context)}`
    };
    const data = await fetchJSON('https://api.anthropic.com/v1/messages', {
      method:'POST',
      headers:{'x-api-key':ANTHROPIC_API_KEY,'anthropic-version':'2023-06-01','Content-Type':'application/json'},
      body:JSON.stringify({model:'claude-haiku-4-5-20251001',max_tokens:700,messages:[{role:'user',content:prompts[type]}]}),
      timeout:30000
    });
    return data.content?.[0]?.text || '';
  } catch(e){ return `Error IA: ${e.message}`; }
}

// ─── API Routes ────────────────────────────────────────────────────────
app.get('/api/live', async(req,res)=>{
  try {
    const {results,matches,liveCount}=await getResults();
    const standings=recalcStandings(PORRA,results,awardsState,honorsState);
    const avg=standings.length?(standings.reduce((s,p)=>s+p.total,0)/standings.length).toFixed(1):0;
    const todayMs=getTodayMatches(matches);
    const awardsDisplay=[
      ...PORRA.honors.map(h=>({label:h.name,pts:h.max_pts,type:'team',result:honorsState[h.name]||null,predictions:Object.entries(h.predictions).map(([n,p])=>({player:n,pred:p.pred,correct:honorsState[h.name]?namesMatch(p.pred,honorsState[h.name]):null}))})),
      ...PORRA.player_awards.map(a=>({label:a.name,pts:a.max_pts,type:'player',result:awardsState[a.name.trim()]||null,predictions:Object.entries(a.predictions).map(([n,p])=>({player:n,pred:p.pred,correct:awardsState[a.name.trim()]?namesMatch(p.pred,awardsState[a.name.trim()]):null}))}))
    ];
    res.json({ok:true,standings,todayMatches:todayMs,allMatches:matches,awardsDisplay,
      stats:{liveCount,leaderPts:standings[0]?.total||0,leader:standings[0]?.name||'-',avgPts:avg,withZero:standings.filter(p=>p.total===0).length,total:standings.length,playedCount:Object.keys(results).length},
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
    res.json({ok:true,date:primaryDate,jornadaMatches,summary,premios,availableDates:allDates,lastUpdated:new Date().toISOString()});
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
    const {results}=await getResults();
    const jornadaMatches=getJornadaMatches(dateStr,results);
    const pronosticos=jornadaMatches.map(m=>({
      match:m.name,date:m.date,bonus:m.bonus,maxPts:m.max_pts,
      result:m.result||'-',status:m.liveStatus||'NS',
      players:Object.entries(m.predictions).map(([name,pd])=>({name,pred:pd.pred,pts:m.result&&m.result!=='-'?calcGroupScore(pd.pred,m.result,m.bonus):null})).sort((a,b)=>(b.pts||0)-(a.pts||0))
    }));
    res.json({ok:true,date:dateStr,pronosticos});
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
  const {results,matches,liveCount}=await getResults();
  res.json({today:getTodayStr(),liveCount,footballApiKey:!!FOOTBALL_API_KEY,anthropicKey:!!ANTHROPIC_API_KEY,mappedResults:Object.keys(results).length,results,todayMatches:getTodayMatches(matches)});
});

app.get('/health',(_, res)=>res.json({ok:true,uptime:process.uptime()}));
app.get('*',(_, res)=>res.sendFile(path.join(__dirname,'public','index.html')));
app.listen(PORT,()=>console.log(`🏆 Porra en vivo → http://localhost:${PORT}`));
