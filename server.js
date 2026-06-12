const express = require('express');
const path = require('path');
const fs = require('fs');

const { recalcStandings, findExcelMatchForESPN, toResultFmt } = require('./scoring');
const PORRA = require('./data/porra.json');

const app = express();
const PORT = process.env.PORT || 3000;
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ─── Persistent awards state (in-memory, can be updated via API) ───────
// In production save to a small JSON file or Railway env vars
const AWARDS_FILE = path.join(__dirname, 'data', 'awards.json');
let awardsState  = {};  // { 'Bota de Oro  (máximo goleador)': 'Mbappe', ... }
let honorsState  = {};  // { '🥇Campeón': 'España', ... }

function loadAwards() {
  try {
    const raw = fs.readFileSync(AWARDS_FILE, 'utf8');
    const saved = JSON.parse(raw);
    awardsState = saved.awards || {};
    honorsState = saved.honors || {};
  } catch { /* first run */ }
}
function saveAwards() {
  fs.writeFileSync(AWARDS_FILE, JSON.stringify({ awards: awardsState, honors: honorsState }));
}
loadAwards();

// ─── ESPN cache ─────────────────────────────────────────────────────────
let espnCache = { results: {}, matches: [], ts: 0 };

async function fetchESPN(url) {
  const fetch = (await import('node-fetch')).default;
  const res = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' },
    signal: AbortSignal.timeout(8000)
  });
  if (!res.ok) throw new Error(`ESPN ${res.status}`);
  return res.json();
}

async function refreshESPN() {
  const now = Date.now();
  if (now - espnCache.ts < 45000) return espnCache;

  const results = {};
  const todayMatches = [];

  try {
    const data = await fetchESPN(
      'https://site.api.espn.com/apis/site/v2/sports/soccer/fifa.world/scoreboard?limit=50'
    );

    for (const event of (data.events || [])) {
      const comp = event.competitions?.[0];
      if (!comp) continue;
      const home = comp.competitors?.find(c => c.homeAway === 'home');
      const away = comp.competitors?.find(c => c.homeAway === 'away');
      if (!home || !away) continue;

      const status = event.status?.type?.name || '';
      const isFT   = status === 'STATUS_FINAL';
      const isLive = status === 'STATUS_IN_PROGRESS';
      const isPend = !isFT && !isLive;

      const eventDate = new Date(event.date);
      const hScore = isPend ? null : parseInt(home.score ?? 0);
      const aScore = isPend ? null : parseInt(away.score ?? 0);

      const matchObj = {
        id: event.id,
        espnHome: home.team?.displayName || '?',
        espnAway: away.team?.displayName || '?',
        homeScore: hScore, awayScore: aScore,
        status: isFT ? 'FT' : isLive ? 'LIVE' : 'NS',
        clock: isLive ? event.status?.displayClock : null,
        date: eventDate.toISOString().split('T')[0],
        time: eventDate.toLocaleTimeString('es-CL', { hour:'2-digit', minute:'2-digit', timeZone:'America/Santiago' }),
        resultFmt: (!isPend && hScore != null) ? toResultFmt(hScore, aScore) : null,
      };

      // Map to Excel name (group stage matches)
      const excelName = findExcelMatchForESPN(
        matchObj.espnHome, matchObj.espnAway, PORRA.group_score
      );
      matchObj.excelName = excelName;

      if (excelName && !isPend) {
        results[excelName] = {
          homeScore: hScore, awayScore: aScore,
          status: matchObj.status,
          homeTeam: matchObj.espnHome,
          awayTeam: matchObj.espnAway
        };
      }

      todayMatches.push(matchObj);
    }
  } catch (e) {
    console.error('[ESPN error]', e.message);
  }

  espnCache = { results, matches: todayMatches, ts: now };
  return espnCache;
}

// ─── Routes ─────────────────────────────────────────────────────────────

// Main data endpoint — standings + live matches
app.get('/api/live', async (req, res) => {
  try {
    const { results, matches } = await refreshESPN();

    const standings = recalcStandings(PORRA, results, awardsState, honorsState);
    const liveCount = matches.filter(m => m.status === 'LIVE').length;
    const avg = standings.length
      ? (standings.reduce((s, p) => s + p.total, 0) / standings.length).toFixed(1)
      : 0;

    // Build awards display for the UI
    const awardsDisplay = [
      ...PORRA.honors.map(h => ({
        label: h.name, pts: h.max_pts, type: 'team',
        result: honorsState[h.name] || null,
        predictions: buildAwardPredList(h, honorsState[h.name])
      })),
      ...PORRA.player_awards.map(a => ({
        label: a.name, pts: a.max_pts, type: 'player',
        result: awardsState[a.name.trim()] || null,
        predictions: buildAwardPredList(a, awardsState[a.name.trim()])
      }))
    ];

    res.json({
      ok: true,
      standings,
      todayMatches: matches,
      awardsDisplay,
      stats: {
        liveCount, leaderPts: standings[0]?.total || 0,
        leader: standings[0]?.name || '-',
        avgPts: avg, withZero: standings.filter(p => p.total === 0).length,
        total: standings.length
      },
      lastUpdated: new Date().toISOString()
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

function buildAwardPredList(award, actualResult) {
  const { namesMatch } = require('./scoring');
  return Object.entries(award.predictions).map(([name, pd]) => ({
    player: name, pred: pd.pred,
    correct: actualResult ? namesMatch(pd.pred, actualResult) : null
  }));
}

// Award state update (protected by a simple token in prod)
app.post('/api/admin/awards', express.json(), (req, res) => {
  const token = req.headers['x-admin-token'];
  if (process.env.ADMIN_TOKEN && token !== process.env.ADMIN_TOKEN) {
    return res.status(401).json({ ok: false, error: 'Unauthorized' });
  }
  const { awards, honors } = req.body;
  if (awards) Object.assign(awardsState, awards);
  if (honors) Object.assign(honorsState, honors);
  saveAwards();
  res.json({ ok: true, awardsState, honorsState });
});

app.get('/api/admin/awards', (req, res) => {
  res.json({
    awards: awardsState,
    honors: honorsState,
    awardNames: PORRA.player_awards.map(a => a.name.trim()),
    honorNames: PORRA.honors.map(h => h.name)
  });
});

// Player detail
app.get('/api/player/:name', async (req, res) => {
  try {
    const { results } = await refreshESPN();
    const standings = recalcStandings(PORRA, results, awardsState, honorsState);
    const name = decodeURIComponent(req.params.name);
    const player = standings.find(p => p.name.toLowerCase() === name.toLowerCase());
    if (!player) return res.status(404).json({ ok: false, error: 'Not found' });
    res.json({ ok: true, player });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// Match detail
app.get('/api/match/:name', async (req, res) => {
  try {
    const { results } = await refreshESPN();
    const name = decodeURIComponent(req.params.name);
    const match = [...PORRA.group_score, ...PORRA.ko_score]
      .find(m => m.name.toLowerCase() === name.toLowerCase());
    if (!match) return res.status(404).json({ ok: false, error: 'Match not found' });

    const espn = results[match.name];
    let result = match.result;
    if (espn?.status === 'FT' && espn.homeScore != null) {
      result = toResultFmt(espn.homeScore, espn.awayScore);
    }

    const { calcGroupScore } = require('./scoring');
    const preds = Object.entries(match.predictions).map(([pName, pd]) => ({
      name: pName, pred: pd.pred,
      pts: result && result !== '-' ? calcGroupScore(pd.pred, result, match.bonus) : null
    })).sort((a, b) => (b.pts || 0) - (a.pts || 0));

    res.json({ ok: true, match: match.name, date: match.date, bonus: match.bonus, result, preds });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

app.get('/health', (_, res) => res.json({ ok: true, uptime: process.uptime() }));
app.get('*', (_, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.listen(PORT, () => console.log(`🏆 Porra en vivo → http://localhost:${PORT}`));
