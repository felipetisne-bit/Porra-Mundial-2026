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
    // actualTeam: from auto-resolved ko_team result, ESPN FT result, or direct team field
    let actualTeam = (espn && espn.team) ? espn.team : null;
    if (!actualTeam && espn && espn.status === 'FT') {
      actualTeam = espn.homeScore > espn.awayScore ? espn.homeTeam : espn.awayTeam;
    }
    if (!actualTeam && espn && espn.status === 'CLASSIFIED') {
      actualTeam = espn.team;
    }
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
