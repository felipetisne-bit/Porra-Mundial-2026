// =====================================================================
// MOTOR DE PUNTUACIÓN COMPLETO — Porra Mundial 2026
// =====================================================================
// Tipos de predicción:
//
//  1. group_score  → "sign|H-A"   e.g. "1|2-0"
//     Puntos: signo × 3, signo+diff × 5, exacto × 9  (× bonus)
//
//  2. ko_score     → "TeamA-TeamB·sign|H-A"
//     Puntos:  equipos correctos (bonus equipo) + puntuación partido
//     En el Excel los bonos son distintos para este tipo
//
//  3. group_pos    → nombre del equipo  e.g. "México"
//     Puntos: max_pts si acertó exactamente, 0 si no
//
//  4. ko_team      → nombre del equipo  e.g. "W73" = ganador de 1/16 73
//     Puntos: max_pts si acertó, 0 si no
//
//  5. honor        → nombre del equipo  (campeón/subcampeón/3º)
//     Puntos: max_pts si acertó, 0 si no
//
//  6. player_award → nombre del jugador (Bota/Balón)
//     Puntos: max_pts si acertó (comparación fuzzy), 0 si no
// =====================================================================

/** Normaliza nombre para comparación fuzzy */
function norm(s) {
  if (!s) return '';
  return s.toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]/g, '');
}

/** Compara dos nombres de jugador/equipo con tolerancia */
function namesMatch(a, b) {
  if (!a || !b) return false;
  const na = norm(a), nb = norm(b);
  if (na === nb) return true;
  // One contains the other (handles "Mbappe" vs "Kylian Mbappe")
  if (na.length >= 4 && nb.includes(na)) return true;
  if (nb.length >= 4 && na.includes(nb)) return true;
  return false;
}

// ─── Group / KO score points ─────────────────────────────────────────
function calcScorePoints(prediction, result, bonus) {
  if (!prediction || prediction === '-' || !result || result === '-') return 0;

  const parse = str => {
    const parts = str.split('|');
    if (parts.length !== 2) return null;
    const goals = parts[1].split('-').map(Number);
    if (goals.length !== 2 || isNaN(goals[0]) || isNaN(goals[1])) return null;
    return { sign: parts[0], home: goals[0], away: goals[1], diff: goals[0] - goals[1] };
  };

  const p = parse(prediction), r = parse(result);
  if (!p || !r) return 0;
  if (p.sign !== r.sign) return 0;
  if (p.home === r.home && p.away === r.away) return 9 * bonus;
  if (p.diff === r.diff) return 5 * bonus;
  return 3 * bonus;
}

/** Convert homeScore/awayScore to "sign|H-A" */
function toResultFmt(home, away) {
  const sign = home > away ? '1' : home < away ? '2' : 'X';
  return `${sign}|${home}-${away}`;
}

// ─── Parse KO combined prediction ────────────────────────────────────
// "TeamA-TeamB·sign|H-A"  → { home, away, scoreStr }
function parseKOPred(pred) {
  if (!pred || !pred.includes('·')) return null;
  const [teams, score] = pred.split('·');
  const tParts = teams.split('-');
  if (tParts.length < 2) return null;
  const home = tParts[0].trim();
  const away = tParts.slice(1).join('-').trim();
  return { home, away, scoreStr: score };
}

// ─── Points calculators per type ─────────────────────────────────────

function calcGroupScore(pred, result, bonus) {
  return calcScorePoints(pred, result, bonus);
}

/**
 * KO score: player predicts which teams play AND the score
 * The "result" in the Excel will be "TeamA-TeamB·sign|H-A" once known
 * For now espnResults map provides homeScore/awayScore + the actual team names
 */
function calcKOScore(pred, espnResult, maxPts, bonus) {
  if (!espnResult || espnResult.status !== 'FT') return null; // pending
  const parsed = parseKOPred(pred);
  if (!parsed) return 0;

  const homeOk = namesMatch(parsed.home, espnResult.homeTeam);
  const awayOk = namesMatch(parsed.away, espnResult.awayTeam);

  let pts = 0;
  if (homeOk && awayOk) {
    // Teams correct → get score points
    const resultFmt = toResultFmt(espnResult.homeScore, espnResult.awayScore);
    pts = calcScorePoints(parsed.scoreStr, resultFmt, bonus);
  } else if (homeOk || awayOk) {
    // One team correct (possible partial credit based on Excel rules)
    // In this system partial = 0 for teams, only full match counts
    pts = 0;
  }
  return pts;
}

function calcTeamPred(pred, actualTeam, maxPts) {
  if (!actualTeam || actualTeam === '-' || actualTeam === 'PD') return null;
  return namesMatch(pred, actualTeam) ? maxPts : 0;
}

function calcPlayerAward(pred, actualPlayer, maxPts) {
  if (!actualPlayer || actualPlayer === '-' || actualPlayer.startsWith('Escribe')) return null;
  return namesMatch(pred, actualPlayer) ? maxPts : 0;
}

// ─── Master recalculator ─────────────────────────────────────────────
/**
 * Recalculates full standings.
 *
 * @param {Object} data         porra.json contents
 * @param {Object} espnResults  map matchName → {homeScore,awayScore,status,homeTeam,awayTeam}
 * @param {Object} awardsState  { 'Bota de Oro': 'Mbappe', 'Balón de Oro': 'Vitinha', ... }
 * @param {Object} honorState   { '🥇Campeón': 'España', ... }
 * @returns {Array} standings sorted by total desc
 */
function recalcStandings(data, espnResults = {}, awardsState = {}, honorState = {}) {
  const totals = {};
  const playerNames = data.players || [];

  for (const name of playerNames) {
    totals[name] = { name, total: 0, bySection: { grupos: 0, pos_grupos: 0, ko_partidos: 0, ko_equipos: 0, honor: 0, bota_balon: 0 } };
  }

  // ── 1. Group stage score matches ──────────────────────────────────
  for (const m of data.group_score) {
    const espn = espnResults[m.name];
    let result = m.result;
    if (espn && espn.status === 'FT' && espn.homeScore != null) {
      result = toResultFmt(espn.homeScore, espn.awayScore);
    }
    if (!result || result === '-') continue;

    for (const [pName, pd] of Object.entries(m.predictions)) {
      if (!totals[pName]) continue;
      const pts = calcGroupScore(pd.pred, result, m.bonus);
      totals[pName].total += pts;
      totals[pName].bySection.grupos += pts;
    }
  }

  // ── 2. Group position predictions ─────────────────────────────────
  // result like "1A" means 1st place in Group A
  // player predicts team name
  for (const m of data.group_pos) {
    // espnResults can provide actual group standings: espnResults['1º GRUPO A'] = { team: 'México' }
    const espn = espnResults[m.name];
    const actualTeam = (espn && espn.team) ? espn.team : (m.result !== '-' && !m.result.match(/^[1-4][A-L]$/) ? m.result : null);
    if (!actualTeam) continue;

    for (const [pName, pd] of Object.entries(m.predictions)) {
      if (!totals[pName]) continue;
      const pts = calcTeamPred(pd.pred, actualTeam, m.max_pts) || 0;
      totals[pName].total += pts;
      totals[pName].bySection.pos_grupos += pts;
    }
  }

  // ── 3. KO score matches ────────────────────────────────────────────
  for (const m of data.ko_score) {
    const espn = espnResults[m.name]; // keyed by code like "2A-2B"
    if (!espn || espn.status !== 'FT') continue;

    for (const [pName, pd] of Object.entries(m.predictions)) {
      if (!totals[pName]) continue;
      const pts = calcKOScore(pd.pred, espn, m.max_pts, m.bonus) || 0;
      totals[pName].total += pts;
      totals[pName].bySection.ko_partidos += pts;
    }
  }

  // ── 4. KO team classifiers ─────────────────────────────────────────
  for (const m of data.ko_team) {
    const espn = espnResults[m.name];
    const actualTeam = (espn && espn.team) ? espn.team : null;
    if (!actualTeam) continue;

    for (const [pName, pd] of Object.entries(m.predictions)) {
      if (!totals[pName]) continue;
      const pts = calcTeamPred(pd.pred, actualTeam, m.max_pts) || 0;
      totals[pName].total += pts;
      totals[pName].bySection.ko_equipos += pts;
    }
  }

  // ── 5. Honors (Campeón, Subcampeón, 3º) ───────────────────────────
  for (const m of data.honors) {
    const actualTeam = honorState[m.name] || (espnResults[m.name] && espnResults[m.name].team);
    if (!actualTeam) continue;

    for (const [pName, pd] of Object.entries(m.predictions)) {
      if (!totals[pName]) continue;
      const pts = calcTeamPred(pd.pred, actualTeam, m.max_pts) || 0;
      totals[pName].total += pts;
      totals[pName].bySection.honor += pts;
    }
  }

  // ── 6. Player awards (Bota / Balón) ───────────────────────────────
  for (const m of data.player_awards) {
    const actualPlayer = awardsState[m.name.trim()] || null;
    if (!actualPlayer) continue;

    for (const [pName, pd] of Object.entries(m.predictions)) {
      if (!totals[pName]) continue;
      const pts = calcPlayerAward(pd.pred, actualPlayer, m.max_pts) || 0;
      totals[pName].total += pts;
      totals[pName].bySection.bota_balon += pts;
    }
  }

  // ── Sort and assign positions ──────────────────────────────────────
  const sorted = Object.values(totals).sort((a, b) => b.total - a.total);
  let pos = 1;
  for (let i = 0; i < sorted.length; i++) {
    if (i > 0 && sorted[i].total < sorted[i - 1].total) pos = i + 1;
    sorted[i].pos = pos;
  }

  return sorted;
}

// ─── ESPN team name normalizer ────────────────────────────────────────
const ESP_TO_EN = {
  'méxico':'mexico','corea del sur':'south korea','república checa':'czech republic',
  'canadá':'canada','bosnia y herzegovina':'bosnia & herzegovina','catar':'qatar',
  'suiza':'switzerland','brasil':'brazil','marruecos':'morocco','haití':'haiti',
  'escocia':'scotland','estados unidos':'usa','australia':'australia','turquía':'turkey',
  'alemania':'germany','curazao':'curaçao','costa de marfil':"côte d'ivoire",
  'países bajos':'netherlands','japón':'japan','túnez':'tunisia','bélgica':'belgium',
  'egipto':'egypt','irán':'iran','nueva zelanda':'new zealand','españa':'spain',
  'cabo verde':'cape verde','arabia saudita':'saudi arabia','uruguay':'uruguay',
  'francia':'france','senegal':'senegal','irak':'iraq','noruega':'norway',
  'argentina':'argentina','argelia':'algeria','austria':'austria','jordania':'jordan',
  'portugal':'portugal','rd congo':'dr congo','uzbekistán':'uzbekistan',
  'colombia':'colombia','inglaterra':'england','croacia':'croatia',
  'ghana':'ghana','panamá':'panama','sudáfrica':'south africa','suecia':'sweden',
  'paraguay':'paraguay','ecuador':'ecuador',
};

function matchESPNTeam(espnName, excelName) {
  const en = norm(espnName), ex = norm(excelName);
  if (en === ex || en.includes(ex) || ex.includes(en)) return true;
  const translated = norm(ESP_TO_EN[excelName.toLowerCase()] || '');
  if (translated && (en === translated || en.includes(translated))) return true;
  return false;
}

function findExcelMatchForESPN(homeESPN, awayESPN, matchList) {
  for (const m of matchList) {
    const parts = m.name.split('-');
    if (parts.length < 2) continue;
    const mHome = parts[0].trim();
    const mAway = parts.slice(1).join('-').trim();
    if (matchESPNTeam(homeESPN, mHome) && matchESPNTeam(awayESPN, mAway)) return m.name;
  }
  return null;
}

module.exports = {
  calcScorePoints, calcGroupScore, calcKOScore,
  calcTeamPred, calcPlayerAward,
  toResultFmt, parseKOPred, norm, namesMatch,
  recalcStandings, findExcelMatchForESPN, matchESPNTeam
};
