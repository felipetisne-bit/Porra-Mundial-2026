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
    .replace(/\s+y\s+/g, '')   // "Bosnia y Herzegovina" → "bosniaherzegovina"
    .replace(/\s*&\s*/g, '')   // "Bosnia & Herzegovina" → "bosniaherzegovina"
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]/g, '');
}

/** Compara dos nombres de jugador/equipo con tolerancia */
function namesMatch(a, b) {
  if (!a || !b) return false;
  const na = norm(a), nb = norm(b);
  if (na === nb) return true;
  // Usar ESP_TO_EN que está definido más abajo en el archivo
  const ta = ESP_TO_EN[na] || na;
  const tb = ESP_TO_EN[nb] || nb;
  if (ta === tb) return true;
  if (ta === nb || na === tb) return true;
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
// Tabla de puntos por ronda según Excel ADMIN
// Determinado por maxPts del slot en porra.json
function getKOPtsTable(maxPts) {
  // 16avos: max=14 → signo=5, diff=8(5+3), exacto=14(5+3+6)
  if (maxPts <= 14)  return { sign: 5,  diff: 8,  exact: 14 };
  // Octavos: max=20 → signo=7, diff=11(7+4), exacto=20(7+4+9)
  if (maxPts <= 20)  return { sign: 7,  diff: 11, exact: 20 };
  // Cuartos: max=31 → signo=11, diff=17(11+6), exacto=31(11+6+14)
  if (maxPts <= 31)  return { sign: 11, diff: 17, exact: 31 };
  // Semis: max=48 → signo=17, diff=26(17+9), exacto=48(17+9+22)
  if (maxPts <= 48)  return { sign: 17, diff: 26, exact: 48 };
  // 3°y4°: max=62 → signo=22, diff=34(22+12), exacto=62(22+12+28)
  if (maxPts <= 62)  return { sign: 22, diff: 34, exact: 62 };
  // Final: max=84 → signo=30, diff=46(30+16), exacto=84(30+16+38)
  return { sign: 30, diff: 46, exact: 84 };
}

function calcKOScore(pred, espnResult, maxPts, bonus) {
  if (!espnResult || espnResult.status !== 'FT') return null; // pending
  const parsed = parseKOPred(pred);
  if (!parsed) return 0;

  const homeOk = namesMatch(parsed.home, espnResult.homeTeam);
  const awayOk = namesMatch(parsed.away, espnResult.awayTeam);
  const homeOkInv = namesMatch(parsed.home, espnResult.awayTeam);
  const awayOkInv = namesMatch(parsed.away, espnResult.homeTeam);

  const tbl = getKOPtsTable(maxPts);

  const scoreResult = (scoreStr, realHome, realAway) => {
    const parts = scoreStr ? scoreStr.split('|') : [];
    if (parts.length < 2) return 0;
    const sign = parts[0];
    const goals = parts[1].split('-').map(Number);
    if (goals.length !== 2) return 0;
    const realSign = realHome > realAway ? '1' : realHome < realAway ? '2' : 'X';
    if (sign !== realSign) return 0;
    // bonus multiplica los pts base de la tabla
    if (goals[0] === realHome && goals[1] === realAway) return tbl.exact * bonus;
    if ((goals[0]-goals[1]) === (realHome-realAway)) return tbl.diff * bonus;
    return tbl.sign * bonus;
  };

  let pts = 0;
  if (homeOk && awayOk) {
    pts = scoreResult(parsed.scoreStr, espnResult.homeScore, espnResult.awayScore);
  } else if (homeOkInv && awayOkInv) {
    pts = scoreResult(parsed.scoreStr, espnResult.awayScore, espnResult.homeScore);
  }
  return pts;
}

function calcTeamPred(pred, actualTeam, maxPts) {
  if (!actualTeam || actualTeam === '-' || actualTeam === 'PD') return null;
  // Translate Spanish prediction to English before comparing
  const predNorm = norm(pred || '');
  const translatedPred = ESP_TO_EN[predNorm] || predNorm;
  const actualNorm = norm(actualTeam);
  const translatedActual = ESP_TO_EN[actualNorm] || actualNorm;
  // Compare both directions: pred→EN vs actual, and pred vs actual→EN
  if (namesMatch(translatedPred, actualNorm)) return maxPts;
  if (namesMatch(predNorm, translatedActual)) return maxPts;
  if (namesMatch(translatedPred, translatedActual)) return maxPts;
  if (namesMatch(pred, actualTeam)) return maxPts;
  return 0;
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
    // Use live score for provisional points (LIVE matches)
    if (espn && (espn.status === 'FT' || espn.status === 'LIVE') && espn.homeScore != null) {
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
  // result like "1A" means 1st place in Group A — resolved automatically from standings
  for (const m of data.group_pos) {
    // espnResults now includes auto-calculated group standings keyed by "1A", "2A", etc.
    const code = m.result; // e.g. "1A", "2B", "3C", "4D"
    const actualTeam = espnResults[code] || null;
    if (!actualTeam) continue;

    for (const [pName, pd] of Object.entries(m.predictions)) {
      if (!totals[pName]) continue;
      const pts = calcTeamPred(pd.pred, actualTeam, m.max_pts) || 0;
      totals[pName].total += pts;
      totals[pName].bySection.pos_grupos += pts;
    }
  }

  // ── 3. KO score matches ────────────────────────────────────────────
  // Lógica: da igual en qué slot esté el partido — si la predicción del jugador
  // coincide con UN partido real que se jugó (mismos equipos, cualquier orden),
  // se puntúa. Cada predicción exacta solo cuenta una vez por jugador.

  // Construir índice de partidos reales KO por equipos (para búsqueda rápida)
  const realKOMatches = {}; // key: "teamA_teamB" (normalizado, orden alfabético)
  for (const [key, espn] of Object.entries(espnResults)) {
    if (!espn || espn.status !== 'FT') continue;
    if (!espn.homeTeam || !espn.awayTeam) continue;
    // Solo incluir partidos KO reales (marcados con isKO:true en server.js)
    // Esto evita que resultados de grupos contaminen el scoring de KO
    if (!espn.isKO) continue;
    const nt1 = norm(espn.homeTeam), nt2 = norm(espn.awayTeam);
    const sorted = [nt1, nt2].sort().join('_');
    realKOMatches[sorted] = { espn, key };
  }

  // También agregar partidos KO de openfootball (wc.matches sin group)
  // Estos vienen en wcMatches pasados como parámetro
  // Por ahora usar espnResults que ya los incluye si están en football-data

  const koScoreTracked = {}; // evitar doble puntaje por jugador si tiene misma pred en dos slots
  for (const m of data.ko_score) {
    for (const [pName, pd] of Object.entries(m.predictions)) {
      if (!totals[pName]) continue;
      const pred = pd.pred || '';
      if (!pred || !pred.includes('·')) continue;

      // Extraer equipos de la predicción
      const predTeams = pred.split('·')[0];
      const parts = predTeams.split('-');
      if (parts.length < 2) continue;
      const predT1 = norm(parts[0].trim());
      const predT2 = norm(parts.slice(1).join('-').trim());
      const translatedT1 = ESP_TO_EN[predT1] || predT1;
      const translatedT2 = ESP_TO_EN[predT2] || predT2;
      const predSorted = [translatedT1, translatedT2].sort().join('_');

      // Buscar si ese partido se jugó en la realidad
      const realMatch = realKOMatches[predSorted];
      if (!realMatch) continue;

      // Evitar doble puntaje: misma predicción de equipos, mismo jugador
      if (!koScoreTracked[pName]) koScoreTracked[pName] = new Set();
      if (koScoreTracked[pName].has(predSorted)) continue;
      koScoreTracked[pName].add(predSorted);

      const pts = calcKOScore(pred, realMatch.espn, m.max_pts, m.bonus) || 0;
      totals[pName].total += pts;
      totals[pName].bySection.ko_partidos += pts;
    }
  }

  // ── 4. KO team classifiers ─────────────────────────────────────────
  // Lógica Excel: si el equipo que predijiste clasificó a esa ronda
  // (en CUALQUIER slot), ganas los puntos. No importa el slot exacto.
  // Solo se cuenta una vez por equipo por ronda por jugador.

  // Primero construir el set de clasificados por ronda
  const classifiedByRound = {};
  for (const m of data.ko_team) {
    const espn = espnResults[m.name];
    let actualTeam = (espn && espn.team) ? espn.team : null;
    if (!actualTeam && espn && espn.status === 'FT') {
      actualTeam = espn.homeScore > espn.awayScore ? espn.homeTeam : espn.awayTeam;
    }
    if (!actualTeam && espn && espn.status === 'CLASSIFIED') {
      actualTeam = espn.team;
    }
    if (!actualTeam) continue;
    const round = m.name.replace(/-[0-9]+$/, '');
    if (!classifiedByRound[round]) classifiedByRound[round] = new Set();
    classifiedByRound[round].add(actualTeam);
  }

  // Ahora puntuar: por cada predicción, ver si el equipo clasificó en esa ronda
  for (const m of data.ko_team) {
    const round = m.name.replace(/-[0-9]+$/, '');
    const classified = classifiedByRound[round];
    if (!classified || classified.size === 0) continue;

    for (const [pName, pd] of Object.entries(m.predictions)) {
      if (!totals[pName]) continue;
      // Buscar si el equipo predicho está entre los clasificados de esta ronda
      let hit = false;
      for (const actualTeam of classified) {
        if (calcTeamPred(pd.pred, actualTeam, m.max_pts) > 0) { hit = true; break; }
      }
      if (!hit) continue;
      // Solo contar una vez por equipo predicho por ronda por jugador
      if (!totals[pName]._tracked) totals[pName]._tracked = new Set();
      const predNorm = norm(pd.pred||'');
      const trackKey = `${round}_${ESP_TO_EN[predNorm]||predNorm}`;
      if (totals[pName]._tracked.has(trackKey)) continue;
      totals[pName]._tracked.add(trackKey);
      totals[pName].total += m.max_pts;
      totals[pName].bySection.ko_equipos += m.max_pts;
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
// Maps normalized Spanish team names → normalized English ESPN names
const ESP_TO_EN = {
  'mexico':'mexico', 'coreadelsur':'southkorea', 'republicacheca':'czechrepublic',
  'canada':'canada', 'bosniayherzegovina':'bosniaherzegovina',
  'catar':'qatar', 'suiza':'switzerland', 'brasil':'brazil', 'marruecos':'morocco',
  'haiti':'haiti', 'escocia':'scotland', 'estadosunidos':'usa','usa':'usa','unitedstates':'usa','unitedstatesofamerica':'usa',
  'australia':'australia', 'turquia':'turkey', 'alemania':'germany',
  'curazao':'curacao', 'curacao':'curacao', 'costademarfil':'ivorycoast',
  'paisesbajos':'netherlands', 'japon':'japan', 'tunez':'tunisia', 'belgica':'belgium',
  'egipto':'egypt', 'iran':'iran', 'nuevazelanda':'newzealand', 'espana':'spain',
  'caboverde':'capeverde', 'arabiasaudita':'saudiarabia', 'uruguay':'uruguay',
  'francia':'france', 'senegal':'senegal', 'irak':'iraq', 'noruega':'norway',
  'argentina':'argentina', 'argelia':'algeria', 'austria':'austria', 'jordania':'jordan',
  'portugal':'portugal', 'rdcongo':'drcongo', 'uzbekistan':'uzbekistan',
  'colombia':'colombia', 'inglaterra':'england', 'croacia':'croatia',
  'ghana':'ghana', 'panama':'panama', 'sudafrica':'southafrica', 'suecia':'sweden',
  'paraguay':'paraguay', 'ecuador':'ecuador',
};

// Also maps English ESPN names → Spanish Excel names (for reverse lookup)
const EN_TO_ESP_MATCH = {
  'southafrica': 'Sudáfrica', 'southkorea': 'Corea del Sur',
  'czechrepublic': 'República Checa', 'unitedstates': 'Estados Unidos',
  'bosniaherzegovina': 'Bosnia y Herzegovina',
  'ivorycoast': 'Costa de Marfil', 'netherlands': 'Países Bajos',
  'newzealand': 'Nueva Zelanda', 'capeverde': 'Cabo Verde',
  'saudiarabia': 'Arabia Saudita', 'drcongo': 'RD Congo',
};

function matchESPNTeam(espnName, excelName) {
  const en = norm(espnName), ex = norm(excelName);
  if (en === ex || en.includes(ex) || ex.includes(en)) return true;
  // Try direct Spanish→English translation
  const translated = norm(ESP_TO_EN[excelName.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'')] || '');
  if (translated && (en === translated || en.includes(translated) || translated.includes(en))) return true;
  // Try each word of the ESPN name against the translated name
  const enWords = en.split('').filter(c => c !== ' ');
  const exWords = ex.split('').filter(c => c !== ' ');
  // Partial: if first 5+ chars match
  if (en.length >= 4 && ex.length >= 4) {
    if (en.slice(0,5) === ex.slice(0,5)) return true;
    if (translated.length >= 4 && en.slice(0,5) === translated.slice(0,5)) return true;
  }
  return false;
}

function findExcelMatchForESPN(homeESPN, awayESPN, matchList) {
  const hEn = norm(homeESPN);
  const aEn = norm(awayESPN);

  for (const m of matchList) {
    const parts = m.name.split('-');
    if (parts.length < 2) continue;
    const mHome = parts[0].trim();
    const mAway = parts.slice(1).join('-').trim();
    const mHomeN = norm(mHome);
    const mAwayN = norm(mAway);

    // Get English translation of Spanish name
    const mHomeTr = ESP_TO_EN[mHomeN] || mHomeN;
    const mAwayTr = ESP_TO_EN[mAwayN] || mAwayN;

    const homeOk = hEn === mHomeN || hEn === mHomeTr ||
                   hEn.includes(mHomeTr) || mHomeTr.includes(hEn) ||
                   hEn.includes(mHomeN) || mHomeN.includes(hEn);
    const awayOk = aEn === mAwayN || aEn === mAwayTr ||
                   aEn.includes(mAwayTr) || mAwayTr.includes(aEn) ||
                   aEn.includes(mAwayN) || mAwayN.includes(aEn);

    if (homeOk && awayOk) return m.name;
  }
  return null;
}

module.exports = {
  calcScorePoints, calcGroupScore, calcKOScore,
  calcTeamPred, calcPlayerAward,
  toResultFmt, parseKOPred, norm, namesMatch,
  recalcStandings, findExcelMatchForESPN, matchESPNTeam
};
