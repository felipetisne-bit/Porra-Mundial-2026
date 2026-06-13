const express = require('express');
const path = require('path');
const fs = require('fs');
const { recalcStandings, findExcelMatchForESPN, toResultFmt, calcGroupScore, namesMatch } = require('./scoring');
const PORRA = require('./data/porra.json');

const app = express();
const PORT = process.env.PORT || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'porra2026';

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
  const res = await fetch(url, {
    headers:{'User-Agent':'Mozilla/5.0','Accept':'application/json',...(opts.headers||{})},
    signal:AbortSignal.timeout(opts.timeout||8000)
  });
  if(!res.ok) throw new Error(`HTTP ${res.status} ${url.slice(0,60)}`);
  return res.json();
}

// ─── Timezone helper ───────────────────────────────────────────────────
// FIX #1: Always use Santiago timezone for date comparisons
function getSantiagoDate(dateInput) {
  const d = dateInput ? new Date(dateInput) : new Date();
  return d.toLocaleDateString('en-CA', {timeZone:'America/Santiago'}); // returns YYYY-MM-DD
}

// ─── Cache ─────────────────────────────────────────────────────────────
let wcCache   = { results:{}, matches:[], ts:0 }; // openfootball — historical results
let liveCache = { liveMatches:[], ts:0 };         // ESPN — live scores only

// ─── Source 1: openfootball (historical + completed results) ───────────
const WC_JSON_URL = 'https://raw.githubusercontent.com/openfootball/world-cup.json/master/2026/worldcup.json';

async function refreshWC() {
  const now = Date.now();
  if(now - wcCache.ts < 60000) return wcCache;
  const results={}, matches=[];
  try {
    const data = await fetchJSON(WC_JSON_URL);
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
        date:m.date, time:(()=>{const t=m.time||'';
const match=t.match(/(d+):(d+)s*UTC([+-]d+)?/);
if(!match)return t;
const h=parseInt(match[1]),mn=parseInt(match[2]),offset=parseInt(match[3]||0);
const utcH=h-offset;
const clH=(utcH+3+24)%24;
return String(clH).padStart(2,'0')+':'+String(mn).padStart(2,'0')+' CL';
})(),
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

// ─── Source 2: ESPN (live scores only — FIX #2) ────────────────────────
async function refreshLive() {
  const now = Date.now();
  if(now - liveCache.ts < 30000) return liveCache; // refresh every 30s during live
  const liveMatches=[];
  const liveResults={};
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
      if(!isLive && !isFT) continue; // only care about live/just finished
      const hScore=parseInt(home.score??0);
      const aScore=parseInt(away.score??0);
      const excelName=findExcelMatchForESPN(home.team?.displayName||'', away.team?.displayName||'', PORRA.group_score);
      if(excelName) {
        liveResults[excelName]={homeScore:hScore,awayScore:aScore,
          status:isLive?'LIVE':'FT',
          homeTeam:home.team?.displayName||'',
          awayTeam:away.team?.displayName||''};
      }
      liveMatches.push({
        espnHome:home.team?.displayName||'?', espnAway:away.team?.displayName||'?',
        homeScore:hScore, awayScore:aScore,
        status:isLive?'LIVE':'FT',
        clock:isLive?event.status?.displayClock:null,
        date:getSantiagoDate(event.date),
        time:new Date(event.date).toLocaleTimeString('es-CL',{hour:'2-digit',minute:'2-digit',timeZone:'America/Santiago'}),
        excelName
      });
    }
    if(liveMatches.length) console.log(`[ESPN LIVE] ${liveMatches.length} live/recent matches`);
  } catch(e){ console.error('[ESPN live]',e.message); }
  liveCache={liveMatches,liveResults,ts:now};
  return liveCache;
}

// ─── Merged results: WC historical + ESPN live overlay ─────────────────
async function getResults() {
  const [wc, live] = await Promise.all([refreshWC(), refreshLive()]);
  // ESPN live results override WC historical for matches currently being played
  const merged = {...wc.results, ...live.liveResults};
  // Merge match list: WC base + live overlays
  const allMatches = wc.matches.map(m => {
    const liveM = live.liveMatches.find(l=>l.excelName===m.excelName);
    if(liveM) return {...m, ...liveM};
    return m;
  });
  return {results:merged, matches:allMatches, liveCount:live.liveMatches.filter(m=>m.status==='LIVE').length};
}

// ─── Helpers ────────────────────────────────────────────────────────────
function getTodayStr() {
  // FIX #1: Use Santiago timezone
  return getSantiagoDate();
}

function getTodayMatches(allMatches) {
  const today = getTodayStr();
  return allMatches.filter(m => m.date === today);
}

function getJornadaMatches(dateStr, results) {
  const allScore = [...PORRA.group_score, ...PORRA.ko_score];
  return allScore.filter(m=>m.date===dateStr).map(m=>{
    const r=results[m.name];
    let result=m.result;
    if(r && r.homeScore!=null) result=toResultFmt(r.homeScore,r.awayScore);
    const playerResults=Object.entries(m.predictions).map(([name,pd])=>({
      name, pred:pd.pred,
      pts:result&&result!=='-'?calcGroupScore(pd.pred,result,m.bonus):null
    }));
    return {...m, result, liveStatus:r?.status||'NS', playerResults};
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

// ─── FIX #3: ChatGPT instead of Claude ────────────────────────────────
async function generateGPTAnalysis(type, context) {
  const apiKey = process.env.OPENAI_API_KEY;
  if(!apiKey) return 'Configura OPENAI_API_KEY en Railway Variables para activar esta función.';
  try {
    const prompts = {
      impacto:`Eres el analista de una porra de fútbol entre amigos chilenos. Con estos datos genera un análisis de impacto en español informal y entretenido (máx 300 palabras). Incluye: qué partidos generaron más movimiento, grupos de puntos, caída del día, partido bonus más decisivo. Datos: ${JSON.stringify(context)}`,
      cronica:`Eres el cronista de una porra de fútbol entre amigos chilenos. Escribe una crónica narrativa, emotiva e informal en español (máx 350 palabras). Menciona nombres reales, drama, subidas y caídas. Datos: ${JSON.stringify(context)}`
    };
    const data = await fetchJSON('https://api.openai.com/v1/chat/completions', {
      headers:{'Authorization':`Bearer ${apiKey}`,'Content-Type':'application/json'},
      body: JSON.stringify({
        model:'gpt-4o-mini',
        max_tokens:600,
        messages:[{role:'user',content:prompts[type]}]
      }),
      method:'POST'
    });
    return data.choices?.[0]?.message?.content || '';
  } catch(e){ return `Error GPT: ${e.message}`; }
}

// ─── fetchJSON needs to support POST ──────────────────────────────────
// Override to handle POST requests
const originalFetchJSON = fetchJSON;

// ─── API Routes ────────────────────────────────────────────────────────
app.get('/api/live', async(req,res)=>{
  try {
    const {results,matches,liveCount}=await getResults();
    const standings=recalcStandings(PORRA,results,awardsState,honorsState);
    const avg=standings.length?(standings.reduce((s,p)=>s+p.total,0)/standings.length).toFixed(1):0;
    const todayMs=getTodayMatches(matches);
    const awardsDisplay=[
      ...PORRA.honors.map(h=>({label:h.name,pts:h.max_pts,type:'team',result:honorsState[h.name]||null,
        predictions:Object.entries(h.predictions).map(([n,p])=>({player:n,pred:p.pred,correct:honorsState[h.name]?namesMatch(p.pred,honorsState[h.name]):null}))})),
      ...PORRA.player_awards.map(a=>({label:a.name,pts:a.max_pts,type:'player',result:awardsState[a.name.trim()]||null,
        predictions:Object.entries(a.predictions).map(([n,p])=>({player:n,pred:p.pred,correct:awardsState[a.name.trim()]?namesMatch(p.pred,awardsState[a.name.trim()]):null}))}))
    ];
    res.json({ok:true,standings,todayMatches:todayMs,allMatches:matches,awardsDisplay,
      stats:{liveCount,leaderPts:standings[0]?.total||0,leader:standings[0]?.name||'-',
        avgPts:avg,withZero:standings.filter(p=>p.total===0).length,total:standings.length,
        playedCount:Object.keys(results).length},
      lastUpdated:new Date().toISOString()});
  } catch(e){console.error(e);res.status(500).json({ok:false,error:e.message});}
});

app.get('/api/jornada', async(req,res)=>{
  try {
    const dateStr=req.query.date||(()=>{const d=new Date();return d.toLocaleDateString("en-CA",{timeZone:"America/Santiago"});})();
    const {results}=await getResults();
    const standings=recalcStandings(PORRA,results,awardsState,honorsState);
    const jornadaMatches=getJornadaMatches(dateStr,results);
    const summary=buildJornadaSummary(jornadaMatches,standings);
    const premios=buildPremiosFecha(jornadaMatches);
    const allDates=[...new Set([...PORRA.group_score,...PORRA.ko_score].map(m=>m.date).filter(Boolean))].sort();
    res.json({ok:true,date:dateStr,jornadaMatches,summary,premios,availableDates:allDates,lastUpdated:new Date().toISOString()});
  } catch(e){res.status(500).json({ok:false,error:e.message});}
});

app.get('/api/analysis/:type', async(req,res)=>{
  try {
    const {type}=req.params;
    if(!['impacto','cronica'].includes(type)) return res.status(400).json({ok:false});
    const dateStr=req.query.date||getTodayStr();
    const {results}=await getResults();
    const standings=recalcStandings(PORRA,results,awardsState,honorsState);
    const jornadaMatches=getJornadaMatches(dateStr,results);
    const summary=buildJornadaSummary(jornadaMatches,standings);
    const premios=buildPremiosFecha(jornadaMatches);
    const context={date:dateStr,matches:jornadaMatches.map(m=>({name:m.name,result:m.result,bonus:m.bonus})),
      top5:standings.slice(0,5).map(p=>({name:p.name,total:p.total})),summary:summary.slice(0,10),premios};
    const text=await generateGPTAnalysis(type,context);
    res.json({ok:true,text,date:dateStr});
  } catch(e){res.status(500).json({ok:false,error:e.message});}
});

app.get('/api/pronosticos', async(req,res)=>{
  try {
    const dateStr=req.query.date||getTodayStr();
    const {results}=await getResults();
    const jornadaMatches=getJornadaMatches(dateStr,results);
    const pronosticos=jornadaMatches.map(m=>({
      match:m.name,date:m.date,bonus:m.bonus,maxPts:m.max_pts,
      result:m.result||'-',status:m.liveStatus||'NS',
      players:Object.entries(m.predictions).map(([name,pd])=>({
        name,pred:pd.pred,
        pts:m.result&&m.result!=='-'?calcGroupScore(pd.pred,m.result,m.bonus):null
      })).sort((a,b)=>(b.pts||0)-(a.pts||0))
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
  res.json({awards:awardsState,honors:honorsState,
    awardNames:PORRA.player_awards.map(a=>a.name.trim()),
    honorNames:PORRA.honors.map(h=>h.name)});
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
    const preds=Object.entries(match.predictions).map(([pName,pd])=>({
      name:pName,pred:pd.pred,
      pts:result&&result!=='-'?calcGroupScore(pd.pred,result,match.bonus):null
    })).sort((a,b)=>(b.pts||0)-(a.pts||0));
    res.json({ok:true,match:match.name,date:match.date,bonus:match.bonus,result,preds});
  } catch(e){res.status(500).json({ok:false,error:e.message});}
});

app.get('/api/debug',async(req,res)=>{
  const {results,matches,liveCount}=await getResults();
  res.json({today:getTodayStr(),liveCount,mappedResults:Object.keys(results).length,results,
    todayMatches:getTodayMatches(matches)});
});

app.get('/health',(_, res)=>res.json({ok:true,uptime:process.uptime()}));
app.get('*',(_, res)=>res.sendFile(path.join(__dirname,'public','index.html')));
app.listen(PORT,()=>console.log(`🏆 Porra en vivo → http://localhost:${PORT}`));
