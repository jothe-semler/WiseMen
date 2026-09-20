/* ==========================================================================
   Wise Men Sports Betting: frontend.
   Ren JavaScript, ingen build. Al data læses fra Apps Script som JSON og
   alle beregninger sker her i browseren ud fra rådata.
   ========================================================================== */
(function () {
  'use strict';

  /* ------------------------------------------------------------------------
     Konstanter og ordbog
     ------------------------------------------------------------------------ */
  const STAKE = 20;                 // kr. pr. bet
  const ODDS = 2;                   // fast odds
  const NET_WIN = STAKE * (ODDS - 1); // +20 netto ved sejr, -20 ved nederlag
  const DEFAULT_FINAL_WEEK = 6;
  const DEFAULT_KICKOFF = '2026-10-18T15:30:00+02:00';
  const TOKEN_KEY = 'wisemen.adminToken';
  const TZ = 'Europe/Copenhagen';

  const COPY = {
    loading: 'Bogen åbnes.',
    error: 'Bogen kunne ikke åbnes. Prøv igen.',
    noPicks: 'Ingen har endnu vovet et bet.',
    emptyWeek: 'Kapitlet er endnu ikke skrevet.',
    saved: 'Indført i bogen.',
    open: 'Åbent',
    win: 'Sejr',
    loss: 'Nederlag',
    hit: 'Ramte',
    miss: 'Ramte forbi',
    final: 'Finalen',
    settlement: 'Afregningen',
    countdown: 'Dage til Wembley'
  };

  const CONFIG = window.WISE_CONFIG || {};
  const API_URL = String(CONFIG.API_URL || '').trim();
  const reduceMotion = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);

  const app = document.getElementById('app');
  const toastEl = document.getElementById('toast');
  const updatedEl = document.getElementById('updated-at');

  const state = {
    data: null,
    model: null,
    error: null,
    adminWeek: null,
    busy: false
  };

  let countdownTimer = null;
  let toastTimer = null;
  let observer = null;

  /* ------------------------------------------------------------------------
     Små hjælpere
     ------------------------------------------------------------------------ */
  function esc(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function cap(text) {
    return text ? text.charAt(0).toUpperCase() + text.slice(1) : '';
  }

  function num(value, fallback) {
    const n = Number(value);
    return Number.isFinite(n) ? n : (fallback == null ? 0 : fallback);
  }

  function str(value) {
    return value == null ? '' : String(value).trim();
  }

  const NUMBER_WORDS = ['nul', 'én', 'to', 'tre', 'fire', 'fem', 'seks', 'syv', 'otte', 'ni', 'ti'];
  function numberWord(n) {
    return n >= 0 && n <= 10 ? NUMBER_WORDS[n] : String(n);
  }

  function fmtMoney(n) {
    if (n > 0) return '+' + n + ' kr.';
    if (n < 0) return '-' + Math.abs(n) + ' kr.';
    return '0 kr.';
  }

  function fmtPct(stats) {
    if (stats.accuracy === null) return 'Afventer';
    return Math.round(stats.accuracy * 100) + ' %';
  }

  function streakText(stats) {
    if (!stats.streak) return 'Ingen afgjorte bets endnu';
    const { kind, count } = stats.streak;
    if (kind === 'won') return count + ' ' + (count === 1 ? 'sejr' : 'sejre') + ' i træk';
    return count + ' nederlag i træk';
  }

  function beerBetsText(n) {
    return n + ' ' + (n === 1 ? 'bet' : 'bets');
  }

  function picksText(n) {
    return n + ' ' + (n === 1 ? 'pick' : 'picks');
  }

  function betsWord(n) {
    return n === 1 ? 'bet' : 'bets';
  }

  function dateParts(iso) {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return null;
    const parts = new Intl.DateTimeFormat('da-DK', {
      weekday: 'long', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit', timeZone: TZ
    }).formatToParts(d);
    const get = (type) => (parts.find((p) => p.type === type) || {}).value || '';
    return { weekday: get('weekday'), day: get('day'), month: get('month'), hour: get('hour'), minute: get('minute') };
  }

  function fmtDateTime(iso) {
    const p = dateParts(iso);
    if (!p) return '';
    return p.weekday + ' den ' + p.day + '. ' + p.month + ' kl. ' + p.hour + '.' + p.minute;
  }

  function fmtClock(date) {
    const parts = new Intl.DateTimeFormat('da-DK', { hour: '2-digit', minute: '2-digit', timeZone: TZ }).formatToParts(date);
    const get = (type) => (parts.find((p) => p.type === type) || {}).value || '';
    return get('hour') + '.' + get('minute');
  }

  function shortTeam(name) {
    const words = str(name).split(/\s+/);
    return words[words.length - 1] || name;
  }

  function displayName(player) {
    return str(player.nickname) || str(player.name);
  }

  function paragraphsHtml(text) {
    return str(text)
      .split(/\n\s*\n/)
      .map((p) => p.trim())
      .filter(Boolean)
      .map((p) => '<p>' + esc(p).replace(/\n/g, '<br>') + '</p>')
      .join('');
  }

  function focusSides(game) {
    const has = (team, needle) => str(team).toLowerCase().includes(needle);
    const isJax = (t) => has(t, 'jaguars') || has(t, 'jacksonville');
    const isHou = (t) => has(t, 'texans') || has(t, 'houston');
    if (game.focusTeam === 'BOTH') return { away: true, home: true };
    if (game.focusTeam === 'HOU') return { away: isHou(game.awayTeam), home: isHou(game.homeTeam) };
    return { away: isJax(game.awayTeam), home: isJax(game.homeTeam) };
  }

  function teamModifier(focusTeam) {
    if (focusTeam === 'BOTH') return 'both';
    if (focusTeam === 'HOU') return 'hou';
    return 'jax';
  }

  // Bettets hold: bettets eget felt, ellers kampens. Uden kamp: begge hold.
  function betTeam(m, bet) {
    if (bet.team) return bet.team;
    const game = m.gamesById[bet.gameId];
    return game ? game.focusTeam : 'BOTH';
  }

  function betGameLine(m, bet) {
    const game = m.gamesById[bet.gameId];
    if (game) return shortTeam(game.awayTeam) + ' hos ' + shortTeam(game.homeTeam);
    return betTeam(m, bet) === 'BOTH' ? 'Jaguars og Texans' : 'Ingen enkelt kamp';
  }

  function isoToLocalInput(iso) {
    // ISO med tidszone til "2026-09-13T19:00" i browserens tidszone, til datetime-local.
    const d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    const pad = (n) => String(n).padStart(2, '0');
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + 'T' + pad(d.getHours()) + ':' + pad(d.getMinutes());
  }

  /* ------------------------------------------------------------------------
     API
     ------------------------------------------------------------------------ */
  function normalize(raw) {
    const list = (key) => Array.isArray(raw[key]) ? raw[key] : [];
    const settings = raw.settings && typeof raw.settings === 'object' ? raw.settings : {};
    return {
      generatedAt: raw.generatedAt || null,
      settings: {
        welcomeText: str(settings.welcomeText),
        londonKickoff: str(settings.londonKickoff) || DEFAULT_KICKOFF,
        finalWeek: num(settings.finalWeek, DEFAULT_FINAL_WEEK) || DEFAULT_FINAL_WEEK
      },
      players: list('players').map((p) => ({
        id: str(p.id), name: str(p.name), nickname: str(p.nickname), sortOrder: num(p.sortOrder, 0)
      })).filter((p) => p.id),
      weeks: list('weeks').map((w) => ({
        weekNo: num(w.weekNo, 0), title: str(w.title), narrative: str(w.narrative)
      })).filter((w) => w.weekNo > 0),
      games: list('games').map((g) => ({
        id: str(g.id), weekNo: num(g.weekNo, 0), awayTeam: str(g.awayTeam), homeTeam: str(g.homeTeam),
        kickoff: str(g.kickoff), focusTeam: str(g.focusTeam).toUpperCase() || 'JAX', resultText: str(g.resultText)
      })).filter((g) => g.id),
      bets: list('bets').map((b) => ({
        id: str(b.id), weekNo: num(b.weekNo, 0), gameId: str(b.gameId), number: num(b.number, 0),
        title: str(b.title), optionA: str(b.optionA), optionB: str(b.optionB), outcome: str(b.outcome).toUpperCase(),
        team: str(b.team).toUpperCase()
      })).filter((b) => b.id),
      picks: list('picks').map((p) => ({
        id: str(p.id), betId: str(p.betId), playerId: str(p.playerId), side: str(p.side).toUpperCase()
      })).filter((p) => p.betId && p.playerId),
      wildBets: list('wildBets').map((w) => ({
        weekNo: num(w.weekNo, 0), title: str(w.title), description: str(w.description), outcome: str(w.outcome).toLowerCase()
      })).filter((w) => w.weekNo > 0),
      wildPicks: list('wildPicks').map((w) => ({
        weekNo: num(w.weekNo, 0), playerId: str(w.playerId)
      })).filter((w) => w.weekNo > 0 && w.playerId)
    };
  }

  async function fetchData() {
    if (!API_URL) {
      const err = new Error('Bogen er ikke forbundet.');
      err.code = 'NO_API';
      throw err;
    }
    const url = API_URL + (API_URL.includes('?') ? '&' : '?') + 't=' + Date.now();
    const res = await fetch(url, { method: 'GET', redirect: 'follow' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const json = await res.json();
    if (json && json.ok === false) throw new Error(json.error || 'Ukendt fejl');
    return normalize(json);
  }

  async function postAction(action, payload) {
    const token = sessionStorage.getItem(TOKEN_KEY) || '';
    const res = await fetch(API_URL, {
      method: 'POST',
      redirect: 'follow',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ token: token, action: action, payload: payload || {} })
    });
    let json = null;
    try { json = await res.json(); } catch (e) { json = null; }
    if (!json || json.ok !== true) {
      const err = new Error((json && json.error) || 'Skrivningen mislykkedes. Prøv igen.');
      err.status = json && json.status;
      throw err;
    }
    return json.result;
  }

  async function load() {
    state.error = null;
    state.data = await fetchData();
    state.model = buildModel(state.data);
    if (state.adminWeek == null) state.adminWeek = state.model.currentWeekNo;
    updatedEl.textContent = 'Bogen læst kl. ' + fmtClock(new Date()) + '.';
  }

  /* ------------------------------------------------------------------------
     Model: alt beregnes her ud fra rådata
     ------------------------------------------------------------------------ */
  function groupBy(list, key) {
    const out = {};
    list.forEach((item) => {
      const k = item[key];
      (out[k] = out[k] || []).push(item);
    });
    return out;
  }

  function buildModel(data) {
    const finalWeek = data.settings.finalWeek;
    const kickoff = data.settings.londonKickoff;

    const players = data.players.slice().sort((a, b) =>
      (a.sortOrder - b.sortOrder) || a.name.localeCompare(b.name, 'da'));
    const playersById = {};
    players.forEach((p) => { playersById[p.id] = p; });

    const weeks = data.weeks.slice().sort((a, b) => a.weekNo - b.weekNo);
    const weeksByNo = {};
    weeks.forEach((w) => { weeksByNo[w.weekNo] = w; });

    const games = data.games.slice().sort((a, b) =>
      (a.weekNo - b.weekNo) || a.kickoff.localeCompare(b.kickoff) || a.id.localeCompare(b.id));
    const gamesById = {};
    games.forEach((g) => { gamesById[g.id] = g; });

    const bets = data.bets.slice().sort((a, b) =>
      (a.weekNo - b.weekNo) || (a.number - b.number) || a.id.localeCompare(b.id));
    const betsById = {};
    bets.forEach((b) => { betsById[b.id] = b; });

    const picks = data.picks
      .filter((p) => betsById[p.betId] && playersById[p.playerId] && (p.side === 'A' || p.side === 'B'))
      .map((p) => {
        const bet = betsById[p.betId];
        const result = !bet.outcome ? 'open' : (bet.outcome === p.side ? 'won' : 'lost');
        return { id: p.id, betId: p.betId, playerId: p.playerId, side: p.side, bet: bet, result: result };
      });
    const picksByBet = groupBy(picks, 'betId');
    const picksByPlayer = groupBy(picks, 'playerId');

    const wildByWeek = {};
    data.wildBets.forEach((w) => { wildByWeek[w.weekNo] = w; });
    const wildPicksByWeek = groupBy(data.wildPicks.filter((w) => playersById[w.playerId]), 'weekNo');

    const sortPicks = (a, b) =>
      (a.bet.weekNo - b.bet.weekNo) || (a.bet.number - b.bet.number) || a.bet.id.localeCompare(b.bet.id);

    const stats = {};
    players.forEach((p) => {
      const mine = (picksByPlayer[p.id] || []).slice().sort(sortPicks);
      const won = mine.filter((x) => x.result === 'won').length;
      const lost = mine.filter((x) => x.result === 'lost').length;
      const open = mine.filter((x) => x.result === 'open').length;
      const settled = mine.filter((x) => x.result !== 'open');
      let streak = null;
      if (settled.length) {
        const last = settled[settled.length - 1].result;
        let count = 0;
        for (let i = settled.length - 1; i >= 0 && settled[i].result === last; i -= 1) count += 1;
        streak = { kind: last, count: count };
      }
      const beer = { owed: 0, won: 0 };
      Object.keys(wildByWeek).forEach((weekNo) => {
        const wild = wildByWeek[weekNo];
        const participants = wildPicksByWeek[weekNo] || [];
        if (!participants.some((x) => x.playerId === p.id)) return;
        if (wild.outcome === 'hit') beer.won += 1;
        else if (wild.outcome === 'miss') beer.owed += 1;
      });
      stats[p.id] = {
        player: p,
        won: won,
        lost: lost,
        open: open,
        total: mine.length,
        formue: (won - lost) * NET_WIN,
        accuracy: (won + lost) ? won / (won + lost) : null,
        streak: streak,
        beer: beer,
        picks: mine
      };
    });

    let houseRounds = 0;
    Object.keys(wildByWeek).forEach((weekNo) => {
      const wild = wildByWeek[weekNo];
      const participants = wildPicksByWeek[weekNo] || [];
      if (wild.outcome === 'hit' && participants.length > 0) houseRounds += 1;
    });
    const house = {
      formue: -players.reduce((sum, p) => sum + stats[p.id].formue, 0),
      rounds: houseRounds
    };

    const leaderboard = players.map((p) => stats[p.id]).sort((a, b) =>
      (b.formue - a.formue) ||
      ((b.accuracy === null ? -1 : b.accuracy) - (a.accuracy === null ? -1 : a.accuracy)) ||
      (a.total - b.total) ||
      a.player.name.localeCompare(b.player.name, 'da'));

    const currentWeekNo = weeks.length ? Math.max.apply(null, weeks.map((w) => w.weekNo)) : 1;
    const maxWeekNo = Math.max(finalWeek, currentWeekNo);

    const finalBets = bets.filter((b) => b.weekNo === finalWeek);
    const finalWild = wildByWeek[finalWeek];
    const settlementReady = !!weeksByNo[finalWeek] && finalBets.length > 0 &&
      finalBets.every((b) => b.outcome) && (!finalWild || !!finalWild.outcome);

    return {
      settings: data.settings,
      finalWeek: finalWeek,
      kickoff: kickoff,
      players: players,
      playersById: playersById,
      weeks: weeks,
      weeksByNo: weeksByNo,
      games: games,
      gamesById: gamesById,
      bets: bets,
      betsById: betsById,
      picks: picks,
      picksByBet: picksByBet,
      picksByPlayer: picksByPlayer,
      wildByWeek: wildByWeek,
      wildPicksByWeek: wildPicksByWeek,
      stats: stats,
      house: house,
      leaderboard: leaderboard,
      currentWeekNo: currentWeekNo,
      maxWeekNo: maxWeekNo,
      settlementReady: settlementReady
    };
  }

  function weekInfo(m, weekNo) {
    const week = m.weeksByNo[weekNo] || null;
    const isFinal = weekNo === m.finalWeek;
    return {
      weekNo: weekNo,
      week: week,
      isFinal: isFinal,
      title: week ? week.title : (isFinal ? COPY.final : 'Uge ' + weekNo),
      games: m.games.filter((g) => g.weekNo === weekNo),
      bets: m.bets.filter((b) => b.weekNo === weekNo),
      wild: m.wildByWeek[weekNo] || null,
      participants: (m.wildPicksByWeek[weekNo] || []).map((x) => m.playersById[x.playerId]).filter(Boolean)
    };
  }

  function weekStatusText(info) {
    const total = info.bets.length;
    const settled = info.bets.filter((b) => b.outcome).length;
    const open = total - settled;
    if (!total) return 'Ingen bets i bogen endnu.';
    if (!settled) return total + ' ' + (total === 1 ? 'bet står åbent' : 'bets står åbne') + '. Intet er afgjort endnu.';
    if (!open) return 'Alle ' + total + ' bets er afgjort.';
    return settled + ' af ' + total + ' bets er afgjort. ' + open + ' ' + (open === 1 ? 'står åbent' : 'står åbne') + '.';
  }

  function wildStateText(wild) {
    if (!wild) return '';
    if (wild.outcome === 'hit') return COPY.hit;
    if (wild.outcome === 'miss') return COPY.miss;
    return COPY.open;
  }

  /* ------------------------------------------------------------------------
     Komponenter
     ------------------------------------------------------------------------ */
  function stampHtml(won) {
    return '<span class="stamp ' + (won ? 'stamp--win' : 'stamp--loss') + '">' + (won ? COPY.win : COPY.loss) + '</span>';
  }

  // Billetten. mode "shared" viser alle mænds valg, mode "personal" viser én mands.
  function ticketHtml(m, bet, opts) {
    const mode = (opts && opts.mode) || 'shared';
    const playerId = opts && opts.playerId;
    const modifier = teamModifier(betTeam(m, bet));
    const picks = m.picksByBet[bet.id] || [];
    const settled = !!bet.outcome;

    const sides = ['A', 'B'].map((side) => {
      const label = side === 'A' ? bet.optionA : bet.optionB;
      const sidePicks = picks.filter((p) => p.side === side);
      const won = settled && bet.outcome === side;
      let cls = 'ticket__option';
      let stamp = '';
      let names = [];

      if (mode === 'personal') {
        const mine = sidePicks.find((p) => p.playerId === playerId);
        if (mine) {
          cls += ' ticket__option--mine';
          names = [m.playersById[playerId]];
          if (settled) {
            cls += won ? ' ticket__option--won' : ' ticket__option--lost';
            stamp = stampHtml(won);
          }
        } else {
          cls += ' ticket__option--dim';
        }
      } else {
        names = sidePicks.map((p) => m.playersById[p.playerId]).filter(Boolean);
        if (settled) {
          cls += won ? ' ticket__option--won' : ' ticket__option--lost';
          if (won || names.length) stamp = stampHtml(won);
        }
      }

      const list = names.length
        ? '<ul class="ticket__names">' + names.map((p) => '<li>' + esc(displayName(p)) + '</li>').join('') + '</ul>'
        : '';
      return '<div class="' + cls + '">' +
        '<span class="ticket__option-label">' + esc(label) + '</span>' +
        list + stamp +
        '</div>';
    }).join('');

    const empty = (mode === 'shared' && picks.length === 0)
      ? '<p class="ticket__empty">' + COPY.noPicks + '</p>'
      : '';
    const gameLine = esc(betGameLine(m, bet)) + '. ';
    const stakeLine = STAKE + ' kr., odds ' + ODDS + ',0. ';
    const stateText = settled ? 'Afgjort' : COPY.open;

    return '<article class="ticket ticket--' + modifier + '" aria-label="Bet ' + bet.number + ', ' + esc(bet.title) + '">' +
      '<div class="ticket__stub"><span class="ticket__no">Bet ' + bet.number + '</span></div>' +
      '<div class="ticket__body">' +
      '<h4 class="ticket__title">' + esc(bet.title) + '</h4>' +
      '<p class="ticket__game">' + gameLine + stakeLine + stateText + '.</p>' +
      '<div class="ticket__options">' + sides + empty + '</div>' +
      '</div>' +
      '</article>';
  }

  function gamePendingText(game) {
    const t = new Date(game.kickoff).getTime();
    if (!isNaN(t) && t > Date.now()) return 'Kampen er ikke spillet endnu.';
    return 'Resultatet føres i bogen snarest.';
  }

  function gameHtml(game) {
    const focus = focusSides(game);
    const when = fmtDateTime(game.kickoff);
    return '<article class="game game--' + teamModifier(game.focusTeam) + '">' +
      '<p class="game__meta">' + esc(cap(when)) + '</p>' +
      '<p class="game__teams">' +
      '<span class="game__team' + (focus.away ? ' game__team--focus' : '') + '">' + esc(game.awayTeam) + '</span>' +
      '<span class="game__at">hos</span>' +
      '<span class="game__team' + (focus.home ? ' game__team--focus' : '') + '">' + esc(game.homeTeam) + '</span>' +
      '</p>' +
      (game.resultText
        ? '<p class="game__result">' + esc(game.resultText) + '</p>'
        : '<p class="game__pending">' + gamePendingText(game) + '</p>') +
      '</article>';
  }

  function goalpostsSvg() {
    return '<svg class="wild__posts" viewBox="0 0 80 100" aria-hidden="true" focusable="false">' +
      '<g class="wild__upright" fill="none" stroke="currentColor" stroke-width="4" stroke-linecap="round">' +
      '<line x1="40" y1="98" x2="40" y2="56"/>' +
      '<line x1="12" y1="56" x2="68" y2="56"/>' +
      '<line x1="12" y1="56" x2="12" y2="6"/>' +
      '<line x1="68" y1="56" x2="68" y2="6"/>' +
      '</g>' +
      '<g class="wild__ball" transform="translate(0 0)"><ellipse cx="18" cy="40" rx="7" ry="4.5" fill="currentColor" transform="rotate(-25 18 40)"/></g>' +
      '</svg>';
  }

  function wildHtml(info) {
    const wild = info.wild;
    if (!wild) return '';
    const modifier = wild.outcome === 'hit' ? 'wild--hit' : (wild.outcome === 'miss' ? 'wild--miss' : 'wild--open');
    const names = info.participants.map(displayName);
    const people = names.length
      ? '<span>Deltagere:</span> ' + esc(names.join(', ')) + '.'
      : '<span>Ingen deltager.</span>';
    return '<article class="wild ' + modifier + '">' +
      goalpostsSvg() +
      '<div class="wild__head"><h4 class="wild__title">' + esc(wild.title) + '</h4><span class="wild__state">' + wildStateText(wild) + '</span></div>' +
      (wild.description ? '<p class="wild__desc">' + esc(wild.description) + '</p>' : '') +
      '<p class="wild__people">' + people + '</p>' +
      '</article>';
  }

  function narrativeHtml(week) {
    if (!week || !week.narrative) {
      return '<p class="empty">Beretningen skrives, når kampene er spillet.</p>';
    }
    return '<div class="prose">' + paragraphsHtml(week.narrative) + '</div>';
  }

  function chapterHtml(m, info) {
    const written = !!info.week;
    const cls = 'chapter' + (written ? ' chapter--written' : '') + (info.isFinal ? ' chapter--final' : '');
    let body = '';
    if (!written) {
      body = '<p class="chapter__empty empty">' + COPY.emptyWeek + '</p>';
    } else {
      const games = info.games.length
        ? '<div class="chapter__part"><div class="games' + (info.games.length === 1 ? ' games--single' : '') + '">' + info.games.map(gameHtml).join('') + '</div></div>'
        : '';
      const tickets = '<div class="chapter__part"><span class="kicker">Bettene</span>' +
        (info.bets.length
          ? '<div class="tickets">' + info.bets.map((b) => ticketHtml(m, b, { mode: 'shared' })).join('') + '</div>'
          : '<p class="empty">Ingen bets i bogen endnu.</p>') +
        '</div>';
      const wild = info.wild
        ? '<div class="chapter__part"><span class="kicker">Ugens wild bet</span>' + wildHtml(info) + '</div>'
        : '';
      const narrative = '<div class="chapter__part"><span class="kicker">Ugens beretning</span>' + narrativeHtml(info.week) + '</div>';
      body = games + tickets + wild + narrative;
    }
    const sub = info.isFinal
      ? '<p class="chapter__sub">' + COPY.final + '. Jaguars mod Texans, Wembley.</p>'
      : '';
    return '<section class="' + cls + '" id="uge-' + info.weekNo + '">' +
      '<div class="chapter__head"><h2 class="chapter__title">' + esc(info.title) + '</h2>' + sub + '</div>' +
      body +
      '</section>';
  }

  function boardHtml(m, animated) {
    const rows = m.leaderboard.map((s, i) => {
      const p = s.player;
      const nick = displayName(p);
      const full = str(p.nickname) ? '<span class="board__full">' + esc(p.name) + '</span>' : '';
      return '<li class="board__row' + (i === 0 ? ' board__row--top' : '') + '" style="--i:' + i + '">' +
        '<a class="board__link" href="#/spiller/' + esc(p.id) + '">' +
        '<span class="board__rank">' + (i + 1) + '</span>' +
        '<span class="board__name"><span class="board__nick">' + esc(nick) + '</span>' + full + '</span>' +
        '<span class="board__money" data-target="' + s.formue + '">' + fmtMoney(s.formue) + '</span>' +
        '<span class="board__stats"><span>Træfsikkerhed ' + fmtPct(s) + '.</span> <span>' + picksText(s.total) + '.</span> <span>' + cap(streakText(s)) + '.</span></span>' +
        '</a></li>';
    }).join('');
    return '<ol class="board' + (animated && !reduceMotion ? ' is-animated' : '') + '" aria-label="Ranglisten">' + rows + '</ol>';
  }

  function shortboardHtml(m) {
    const rows = m.leaderboard.map((s, i) =>
      '<a class="shortboard__row' + (i === 0 ? ' shortboard__row--top' : '') + '" href="#/spiller/' + esc(s.player.id) + '">' +
      '<span class="shortboard__rank">' + (i + 1) + '</span>' +
      '<span class="shortboard__name">' + esc(displayName(s.player)) + '</span>' +
      '<span class="shortboard__money">' + fmtMoney(s.formue) + '</span>' +
      '</a>').join('');
    return '<div class="shortboard">' + rows + '</div>';
  }

  function houseHtml(m) {
    return '<section class="ledger ledger--house">' +
      '<div class="ledger__head"><h2 class="ledger__title">Husets kasse</h2><span class="ledger__sum">' + fmtMoney(m.house.formue) + '</span></div>' +
      '<p class="ledger__note">Alt hvad bordet taber, ender her. Alt hvad bordet vinder, tages herfra. Kassen står aldrig på Ranglisten.</p>' +
      '</section>';
  }

  function beerTableHtml(m) {
    const rows = m.players.map((p) => {
      const b = m.stats[p.id].beer;
      return '<tr><td>' + esc(displayName(p)) + '</td><td class="num">' + beerBetsText(b.owed) + '</td><td class="num">' + beerBetsText(b.won) + '</td></tr>';
    }).join('');
    return '<table class="ledger__table">' +
      '<thead><tr><th>Mand</th><th class="num">Tabt</th><th class="num">Vundet</th></tr></thead>' +
      '<tbody>' + rows +
      '<tr class="is-house"><td>Huset</td><td class="num">' + beerBetsText(m.house.rounds) + '</td><td class="num"></td></tr>' +
      '</tbody></table>';
  }

  function beerHtml(m) {
    return '<section class="ledger">' +
      '<div class="ledger__head"><h2 class="ledger__title">Øl-regnskabet</h2></div>' +
      '<p class="ledger__note">Øl, ikke kroner. Rammer ugens wild bet, har deltagerne vundet et bet, og huset giver. Rammer det forbi, har hver deltager tabt et bet og giver selv.</p>' +
      beerTableHtml(m) +
      '</section>';
  }

  function settlementHtml(m) {
    if (!m.settlementReady) return '';
    const lines = m.leaderboard.map((s) => {
      const name = esc(displayName(s.player));
      if (s.formue > 0) return '<li>' + name + ' har <strong>' + s.formue + ' kr.</strong> til gode hos huset.</li>';
      if (s.formue < 0) return '<li>' + name + ' skylder huset <strong>' + Math.abs(s.formue) + ' kr.</strong></li>';
      return '<li>' + name + ' og huset er kvit.</li>';
    }).join('');
    return '<section class="ledger ledger--house settlement">' +
      '<div class="ledger__head"><h2 class="ledger__title">' + COPY.settlement + '</h2><span class="ledger__sum">' + fmtMoney(m.house.formue) + '</span></div>' +
      '<p class="ledger__note">Bogen er lukket. Sådan står bordet og huset over for hinanden. Betales i London.</p>' +
      '<ul class="settlement__list">' + lines +
      '<li class="is-house">Husets kasse ender på <strong>' + fmtMoney(m.house.formue) + '</strong></li>' +
      '</ul>' +
      beerTableHtml(m) +
      '</section>';
  }

  function countdownHtml(m) {
    const diff = new Date(m.kickoff).getTime() - Date.now();
    if (isNaN(diff)) return '';
    if (diff <= 0) {
      return '<section class="hero"><p class="kicker">Wembley</p><p class="hero__done">Dagen er kommet.</p>' +
        '<p class="hero__line">Jaguars mod Texans. Bogen lukkes, når sidste bet er afgjort.</p></section>';
    }
    const days = Math.floor(diff / 86400000);
    const hours = Math.floor((diff % 86400000) / 3600000);
    return '<section class="hero">' +
      '<p class="kicker">' + COPY.countdown + '</p>' +
      '<div class="countdown" id="countdown" data-kickoff="' + esc(m.kickoff) + '">' +
      '<div class="countdown__unit"><span class="countdown__num" data-unit="days">' + days + '</span><span class="countdown__word">' + (days === 1 ? 'dag' : 'dage') + '</span></div>' +
      '<div class="countdown__unit"><span class="countdown__num" data-unit="hours">' + hours + '</span><span class="countdown__word">' + (hours === 1 ? 'time' : 'timer') + '</span></div>' +
      '</div>' +
      '<p class="hero__line">Jaguars mod Texans. Wembley, ' + esc(fmtDateTime(m.kickoff)) + '.</p>' +
      '</section>';
  }

  /* ------------------------------------------------------------------------
     Visninger
     ------------------------------------------------------------------------ */
  function viewHome(m) {
    const info = weekInfo(m, m.currentWeekNo);
    const wildLine = info.wild
      ? '<p class="status__line status__wild">Wild bet: ' + esc(info.wild.title) + '. ' + wildStateText(info.wild) + '.</p>'
      : '';
    const hero = m.settlementReady ? settlementHtml(m) : countdownHtml(m);
    return hero +
      '<section class="section">' +
      '<h2 class="status__title">' + esc(info.title) + '</h2>' +
      '<p class="status__line">' + weekStatusText(info) + '</p>' +
      wildLine +
      '<a class="link-more" href="#/uger/' + info.weekNo + '">Læs kapitlet</a>' +
      '</section>' +
      '<section class="section">' +
      '<h2 class="section__title">Ranglisten</h2>' +
      '<p class="section__lead">Efter uge ' + m.currentWeekNo + '. Der er ingen steder at gemme sig.</p>' +
      shortboardHtml(m) +
      '<a class="link-more" href="#/ranglisten">Hele ranglisten</a>' +
      '</section>' +
      '<section class="section">' +
      '<details class="manifest">' +
      '<summary>Manifestet <span class="kicker">Huset har ordet.</span></summary>' +
      '<div class="manifest__body">' + manifestHtml(m) + '</div>' +
      '</details>' +
      '</section>';
  }

  function manifestHtml(m) {
    const text = m.settings.welcomeText;
    if (!text) return '<p class="empty">Manifestet er endnu ikke skrevet.</p>';
    const parts = text.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
    let heading = '';
    if (parts.length > 1 && parts[0].length < 80 && !/[.!?]$/.test(parts[0]) && !parts[0].includes('\n')) {
      heading = '<h3>' + esc(parts.shift()) + '</h3>';
    }
    return '<div class="prose">' + heading + parts.map((p) => '<p>' + esc(p).replace(/\n/g, '<br>') + '</p>').join('') + '</div>';
  }

  function viewRanglisten(m) {
    return '<section class="section">' +
      '<h1 class="section__title">Ranglisten</h1>' +
      '<p class="section__lead">' + cap(numberWord(m.players.length)) + ' mænd. ' + cap(numberWord(m.finalWeek)) + ' uger. Ét bord i London. Efter uge ' + m.currentWeekNo + '.</p>' +
      boardHtml(m, true) +
      houseHtml(m) +
      beerHtml(m) +
      settlementHtml(m) +
      '</section>';
  }

  function viewUger(m) {
    const chapters = [];
    for (let n = 1; n <= m.maxWeekNo; n += 1) chapters.push(chapterHtml(m, weekInfo(m, n)));
    return '<section class="section">' +
      '<h1 class="section__title">Uger</h1>' +
      '<p class="section__lead">Seks kapitler frem mod London. Hvert kapitel skrives, når kampene er spillet.</p>' +
      '<div class="timeline">' + chapters.join('') + '</div>' +
      '</section>';
  }

  function viewSpiller(m, id) {
    const p = m.playersById[id];
    if (!p) {
      return '<div class="state"><p class="state__text">Manden findes ikke i bogen.</p><a class="button button--quiet" href="#/ranglisten">Til Ranglisten</a></div>';
    }
    const s = m.stats[p.id];
    const nick = displayName(p);
    const full = str(p.nickname) ? '<p class="player__full">' + esc(p.name) + '</p>' : '';
    const rank = m.leaderboard.findIndex((x) => x.player.id === p.id) + 1;

    const weekNos = [];
    s.picks.forEach((x) => { if (!weekNos.includes(x.bet.weekNo)) weekNos.push(x.bet.weekNo); });
    weekNos.sort((a, b) => a - b);
    const history = weekNos.length
      ? weekNos.map((n) => {
        const info = weekInfo(m, n);
        const mine = info.bets.filter((b) => s.picks.some((x) => x.betId === b.id));
        return '<div class="player__week"><span class="kicker">' + esc(info.title) + '</span>' +
          '<div class="tickets">' + mine.map((b) => ticketHtml(m, b, { mode: 'personal', playerId: p.id })).join('') + '</div></div>';
      }).join('')
      : '<p class="empty">' + COPY.noPicks + '</p>';

    return '<section class="player__head">' +
      '<p class="kicker">Nummer ' + rank + ' på Ranglisten</p>' +
      '<h1 class="player__nick">' + esc(nick) + '</h1>' + full +
      '<p class="player__money">' + fmtMoney(s.formue) + '</p>' +
      '<p class="player__money-label">Formue</p>' +
      '<dl class="player__facts">' +
      '<div><dt>Træfsikkerhed</dt><dd>' + fmtPct(s) + '</dd></div>' +
      '<div><dt>Stime</dt><dd>' + cap(streakText(s)) + '</dd></div>' +
      '<div><dt>Picks</dt><dd>' + s.total + ' i alt, ' + s.open + ' ' + (s.open === 1 ? 'åbent' : 'åbne') + '</dd></div>' +
      '<div><dt>Øl-regnskabet</dt><dd>' + beerBetsText(s.beer.owed) + ' tabt, ' + beerBetsText(s.beer.won) + ' vundet</dd></div>' +
      '</dl>' +
      '</section>' +
      '<section class="section"><h2 class="section__title">Historikken</h2>' + history + '</section>';
  }

  /* ------------------------------------------------------------------------
     Admin: husets værktøj
     ------------------------------------------------------------------------ */
  function hasToken() {
    return !!sessionStorage.getItem(TOKEN_KEY);
  }

  function viewTokenForm(message) {
    return '<form class="token-form" data-action="login" autocomplete="off">' +
      '<h1 class="section__title">Husets bog</h1>' +
      '<p class="admin__intro">Kun huset skriver i bogen. Indtast token.</p>' +
      (message ? '<p class="admin__note">' + esc(message) + '</p>' : '') +
      '<label class="field"><span>Token</span><input type="password" name="token" required autocomplete="current-password"></label>' +
      '<div class="form__actions"><button class="button" type="submit">Åbn bogen</button><a class="button button--quiet" href="#/">Tilbage</a></div>' +
      '</form>';
  }

  function optionsHtml(items, selected) {
    return items.map((it) =>
      '<option value="' + esc(it.value) + '"' + (String(it.value) === String(selected) ? ' selected' : '') + '>' + esc(it.label) + '</option>').join('');
  }

  function viewAdmin(m) {
    if (!hasToken()) return viewTokenForm('');
    const weekNo = m.weeksByNo[state.adminWeek] ? state.adminWeek : m.currentWeekNo;
    state.adminWeek = weekNo;
    const info = weekInfo(m, weekNo);
    const nextWeekNo = m.weeks.length ? Math.max.apply(null, m.weeks.map((w) => w.weekNo)) + 1 : 1;

    const weekSelect = m.weeks.length
      ? '<label class="field field--inline"><span>Uge i arbejde</span><select name="weekNo" data-action="selectWeek">' +
        optionsHtml(m.weeks.map((w) => ({ value: w.weekNo, label: w.title || ('Uge ' + w.weekNo) })), weekNo) +
        '</select></label>'
      : '<p class="admin__note">Ingen uger i bogen endnu. Opret den første.</p>';

    const focusOptions = [
      { value: 'JAX', label: 'JAX, Jaguars teal' },
      { value: 'HOU', label: 'HOU, Texans rød' },
      { value: 'BOTH', label: 'BOTH, begge hold' }
    ];
    const teamOptions = [
      { value: '', label: 'Som kampen' },
      { value: 'JAX', label: 'JAX, Jaguars teal' },
      { value: 'HOU', label: 'HOU, Texans rød' },
      { value: 'BOTH', label: 'BOTH, begge hold, billetten får begge farver' }
    ];

    const gamesList = info.games.length
      ? '<ul class="admin__list">' + info.games.map((g) =>
        '<li><div class="betrow__title">' + esc(g.awayTeam) + ' hos ' + esc(g.homeTeam) + '</div>' +
        '<div class="betrow__meta">' + esc(cap(fmtDateTime(g.kickoff))) + '. Farve: ' + esc(g.focusTeam) + '. Id ' + esc(g.id) + '.</div>' +
        '<form class="form--row" data-action="updateGame" data-id="' + esc(g.id) + '">' +
        '<label class="field"><span>Resultattekst</span><input type="text" name="resultText" value="' + esc(g.resultText) + '" placeholder="Fx Jaguars 27-13"></label>' +
        '<button class="button button--small" type="submit">Gem resultat</button>' +
        '</form>' +
        '<details class="editor"><summary>Redigér eller slet kampen</summary>' +
        '<form data-action="updateGame" data-id="' + esc(g.id) + '">' +
        '<div class="editor__grid">' +
        '<label class="field"><span>Udehold</span><input type="text" name="awayTeam" required value="' + esc(g.awayTeam) + '"></label>' +
        '<label class="field"><span>Hjemmehold</span><input type="text" name="homeTeam" required value="' + esc(g.homeTeam) + '"></label>' +
        '<label class="field"><span>Kickoff, dansk tid</span><input type="datetime-local" name="kickoff" required value="' + esc(isoToLocalInput(g.kickoff)) + '"></label>' +
        '<label class="field"><span>Farve</span><select name="focusTeam">' + optionsHtml(focusOptions, g.focusTeam) + '</select></label>' +
        '</div>' +
        '<div class="form__actions">' +
        '<button class="button button--small" type="submit">Gem kamp</button>' +
        '<button class="button button--small button--quiet" type="button" data-action="deleteGame" data-id="' + esc(g.id) + '" data-label="' + esc(shortTeam(g.awayTeam) + ' hos ' + shortTeam(g.homeTeam)) + '">Slet kamp</button>' +
        '<span class="admin__note">En kamp med bets kan ikke slettes. Slet eller flyt bettene først.</span>' +
        '</div>' +
        '</form></details>' +
        '</li>').join('') + '</ul>'
      : '<p class="admin__note">Ingen kampe i uge ' + weekNo + ' endnu.</p>';

    const gameOptions = info.games.map((g) => ({ value: g.id, label: shortTeam(g.awayTeam) + ' hos ' + shortTeam(g.homeTeam) }))
      .concat([{ value: '', label: 'Ingen enkelt kamp, fx begge kampe' }]);

    const betsList = info.bets.length
      ? info.bets.map((b) => {
        const settledText = b.outcome
          ? '<span class="betrow__settled">Afgjort: ' + esc(b.outcome === 'A' ? b.optionA : b.optionB) + '.</span> Afgør igen for at ændre.'
          : COPY.open + '.';
        return '<div class="betrow">' +
          '<div class="betrow__title">Bet ' + b.number + '. ' + esc(b.title) + '</div>' +
          '<div class="betrow__meta">' + esc(betGameLine(m, b)) + '. Farve: ' + esc(betTeam(m, b)) + '. A: ' + esc(b.optionA) + '. B: ' + esc(b.optionB) + '. ' + settledText + '</div>' +
          '<form data-action="settleBet" data-id="' + esc(b.id) + '">' +
          '<label class="choice"><input type="radio" name="outcome" value="A" required' + (b.outcome === 'A' ? ' checked' : '') + '> A: ' + esc(b.optionA) + '</label>' +
          '<label class="choice"><input type="radio" name="outcome" value="B" required' + (b.outcome === 'B' ? ' checked' : '') + '> B: ' + esc(b.optionB) + '</label>' +
          '<button class="button button--small" type="submit">Afgør bet</button>' +
          '</form>' +
          '<details class="editor"><summary>Redigér eller slet bettet</summary>' +
          '<form data-action="updateBet" data-id="' + esc(b.id) + '">' +
          '<div class="editor__grid">' +
          '<label class="field"><span>Nummer</span><input type="number" name="number" min="1" max="99" required value="' + b.number + '"></label>' +
          '<label class="field"><span>Kamp</span><select name="gameId">' + optionsHtml(gameOptions, b.gameId) + '</select></label>' +
          '<label class="field"><span>Titel</span><input type="text" name="title" required value="' + esc(b.title) + '"></label>' +
          '<label class="field"><span>Hold</span><select name="team">' + optionsHtml(teamOptions, b.team) + '</select></label>' +
          '<label class="field"><span>Udfald A</span><input type="text" name="optionA" required value="' + esc(b.optionA) + '"></label>' +
          '<label class="field"><span>Udfald B</span><input type="text" name="optionB" required value="' + esc(b.optionB) + '"></label>' +
          '</div>' +
          '<div class="form__actions">' +
          '<button class="button button--small" type="submit">Gem bet</button>' +
          '<button class="button button--small button--quiet" type="button" data-action="deleteBet" data-id="' + esc(b.id) + '" data-label="Bet ' + b.number + '">Slet bet</button>' +
          '<span class="admin__note">Sletning fjerner også alle picks på bettet.</span>' +
          '</div>' +
          '</form></details>' +
          '</div>';
      }).join('')
      : '<p class="admin__note">Ingen bets i uge ' + weekNo + ' endnu.</p>';

    const pickGrid = info.bets.length
      ? '<form data-action="setPicks">' +
        '<div class="grid-wrap"><table class="pickgrid">' +
        '<thead><tr><th>Mand</th>' + info.bets.map((b) => '<th>Bet ' + b.number + '<small>' + esc(b.title) + '</small></th>').join('') + '</tr></thead>' +
        '<tbody>' + m.players.map((p) =>
          '<tr><td>' + esc(displayName(p)) + '</td>' + info.bets.map((b) => {
            const current = (m.picksByBet[b.id] || []).find((x) => x.playerId === p.id);
            return '<td><select name="pick:' + esc(b.id) + ':' + esc(p.id) + '" aria-label="' + esc(displayName(p)) + ', bet ' + b.number + '">' +
              optionsHtml([
                { value: '', label: 'Intet' },
                { value: 'A', label: 'A: ' + b.optionA },
                { value: 'B', label: 'B: ' + b.optionB }
              ], current ? current.side : '') +
              '</select></td>';
          }).join('') + '</tr>').join('') +
        '</tbody></table></div>' +
        '<div class="form__actions"><button class="button" type="submit">Gem picks</button><span class="admin__note">Kun bets med ændringer skrives.</span></div>' +
        '</form>'
      : '<p class="admin__note">Opret bets først.</p>';

    const wild = info.wild;
    const wildForm = '<form data-action="setWildBet">' +
      '<label class="field"><span>Titel</span><input type="text" name="title" required value="' + esc(wild ? wild.title : '') + '"></label>' +
      '<label class="field"><span>Beskrivelse</span><textarea name="description">' + esc(wild ? wild.description : '') + '</textarea></label>' +
      '<div class="field"><span>Deltagere</span>' + m.players.map((p) =>
        '<label class="choice"><input type="checkbox" name="participant" value="' + esc(p.id) + '"' + (info.participants.some((x) => x.id === p.id) ? ' checked' : '') + '> ' + esc(displayName(p)) + '</label>').join('') +
      '</div>' +
      '<div class="form__actions"><button class="button" type="submit">Gem wild bet</button></div>' +
      '</form>';
    const wildSettle = wild
      ? '<h3>Afgør wild bet</h3>' +
        '<p class="admin__note">Udfald nu: ' + wildStateText(wild) + '.</p>' +
        '<form class="form__actions" data-action="settleWildBet">' +
        '<button class="button button--small" type="submit" name="outcome" value="hit">' + COPY.hit + '</button>' +
        '<button class="button button--small button--quiet" type="submit" name="outcome" value="miss">' + COPY.miss + '</button>' +
        '</form>'
      : '';

    const weekSection = info.week
      ? '<form data-action="updateWeek">' +
        '<label class="field"><span>Titel</span><input type="text" name="title" required value="' + esc(info.week.title) + '"></label>' +
        '<label class="field"><span>Ugens beretning</span><textarea name="narrative" rows="10">' + esc(info.week.narrative) + '</textarea></label>' +
        '<div class="form__actions"><button class="button" type="submit">Gem beretning</button></div>' +
        '</form>'
      : '';

    return '<div class="admin">' +
      '<section class="section">' +
      '<h1 class="section__title">Husets bog</h1>' +
      '<p class="admin__intro">Alt hvad du gemmer her, står i Sheetet med det samme. Bogen genindlæses efter hver skrivning.</p>' +
      '<div class="admin__toolbar">' + weekSelect + '<button class="button button--quiet button--small" type="button" data-action="logout">Luk bogen</button></div>' +
      '</section>' +

      '<section class="admin__section"><h2>Opret uge</h2>' +
      '<form data-action="createWeek">' +
      '<label class="field field--inline"><span>Ugenummer</span><input type="number" name="weekNo" min="1" max="20" required value="' + nextWeekNo + '"></label>' +
      '<label class="field"><span>Titel</span><input type="text" name="title" required placeholder="Uge ' + nextWeekNo + ': " value="Uge ' + nextWeekNo + ': "></label>' +
      '<div class="form__actions"><button class="button" type="submit">Opret uge</button></div>' +
      '</form></section>' +

      (info.week ? (
        '<section class="admin__section"><h2>Kampe i uge ' + weekNo + '</h2>' + gamesList +
        '<h3>Opret kamp</h3>' +
        '<form data-action="createGame">' +
        '<label class="field"><span>Udehold</span><input type="text" name="awayTeam" required placeholder="Fx Cleveland Browns"></label>' +
        '<label class="field"><span>Hjemmehold</span><input type="text" name="homeTeam" required placeholder="Fx Jacksonville Jaguars"></label>' +
        '<label class="field"><span>Kickoff, dansk tid</span><input type="datetime-local" name="kickoff" required></label>' +
        '<label class="field"><span>Farve</span><select name="focusTeam">' +
        optionsHtml(focusOptions, weekNo === m.finalWeek ? 'BOTH' : 'JAX') +
        '</select></label>' +
        '<div class="form__actions"><button class="button" type="submit">Opret kamp</button></div>' +
        '</form></section>' +

        '<section class="admin__section"><h2>Bets i uge ' + weekNo + '</h2>' + betsList +
        '<h3>Opret bet</h3>' +
        '<form data-action="createBet">' +
        '<label class="field"><span>Kamp</span><select name="gameId">' + optionsHtml(gameOptions, gameOptions[0].value) + '</select></label>' +
        '<label class="field"><span>Titel</span><input type="text" name="title" required placeholder="Fx Jaguars vinder med 10 point eller mere"></label>' +
        '<label class="field field--inline"><span>Udfald A</span><input type="text" name="optionA" required placeholder="Ja"></label>' +
        '<label class="field field--inline"><span>Udfald B</span><input type="text" name="optionB" required placeholder="Nej"></label>' +
        '<label class="field"><span>Hold</span><select name="team">' + optionsHtml(teamOptions, '') + '</select></label>' +
        '<p class="admin__note">Nummeret sættes automatisk. Næste er bet ' + (info.bets.length ? Math.max.apply(null, info.bets.map((b) => b.number)) + 1 : 1) + '. Vælg BOTH, hvis bettet gælder både Jaguars og Texans.</p>' +
        '<div class="form__actions"><button class="button" type="submit">Opret bet</button></div>' +
        '</form>' +
        '</section>' +

        '<section class="admin__section"><h2>Picks i uge ' + weekNo + '</h2>' + pickGrid + '</section>' +

        '<section class="admin__section"><h2>Wild bet i uge ' + weekNo + '</h2>' + wildForm + wildSettle + '</section>' +

        '<section class="admin__section"><h2>Ugens beretning</h2>' + weekSection + '</section>'
      ) : '') +

      '<section class="admin__section"><h2>Manifestet</h2>' +
      '<form data-action="updateSettings">' +
      '<label class="field"><span>Velkomsttekst</span><textarea name="welcomeText" rows="14">' + esc(m.settings.welcomeText) + '</textarea></label>' +
      '<div class="form__actions"><button class="button" type="submit">Gem Manifestet</button></div>' +
      '</form></section>' +

      '<section class="admin__section"><h2>Øgenavne</h2>' +
      '<form data-action="updatePlayers">' +
      m.players.map((p) =>
        '<label class="field"><span>' + esc(p.name) + '</span><input type="text" name="nick:' + esc(p.id) + '" value="' + esc(p.nickname) + '" placeholder="Tomt viser det fulde navn"></label>').join('') +
      '<div class="form__actions"><button class="button" type="submit">Gem øgenavne</button></div>' +
      '</form></section>' +
      '</div>';
  }

  function localToIso(value) {
    // "2026-09-13T19:00" fra datetime-local tolkes i browserens tidszone.
    const d = new Date(value);
    if (isNaN(d.getTime())) throw new Error('Ugyldigt tidspunkt.');
    const offset = -d.getTimezoneOffset();
    const sign = offset >= 0 ? '+' : '-';
    const pad = (n) => String(Math.abs(n)).padStart(2, '0');
    const base = value.length === 16 ? value + ':00' : value;
    return base + sign + pad(Math.floor(Math.abs(offset) / 60)) + ':' + pad(Math.abs(offset) % 60);
  }

  const ADMIN = {
    async login(ctx) {
      const token = str(ctx.fd.get('token'));
      if (!token) throw new Error('Indtast token.');
      sessionStorage.setItem(TOKEN_KEY, token);
      try {
        await postAction('verifyToken', {});
      } catch (err) {
        sessionStorage.removeItem(TOKEN_KEY);
        throw err;
      }
      return { message: 'Bogen er åben.', reload: false };
    },
    async createWeek(ctx) {
      const weekNo = num(ctx.fd.get('weekNo'), 0);
      const title = str(ctx.fd.get('title'));
      if (weekNo < 1) throw new Error('Ugenummer skal være mindst 1.');
      await postAction('createWeek', { weekNo: weekNo, title: title });
      state.adminWeek = weekNo;
    },
    async updateWeek(ctx) {
      await postAction('updateWeek', {
        weekNo: state.adminWeek,
        title: str(ctx.fd.get('title')),
        narrative: str(ctx.fd.get('narrative'))
      });
    },
    async createGame(ctx) {
      await postAction('createGame', {
        weekNo: state.adminWeek,
        awayTeam: str(ctx.fd.get('awayTeam')),
        homeTeam: str(ctx.fd.get('homeTeam')),
        kickoff: localToIso(str(ctx.fd.get('kickoff'))),
        focusTeam: str(ctx.fd.get('focusTeam')) || 'JAX'
      });
    },
    async updateGame(ctx) {
      // Samme handling bruges af resultat-formularen og redigeringsformularen.
      // Kun de felter, formularen har, sendes med.
      const payload = { id: ctx.form.dataset.id };
      if (ctx.fd.has('resultText')) payload.resultText = str(ctx.fd.get('resultText'));
      if (ctx.fd.has('awayTeam')) payload.awayTeam = str(ctx.fd.get('awayTeam'));
      if (ctx.fd.has('homeTeam')) payload.homeTeam = str(ctx.fd.get('homeTeam'));
      if (ctx.fd.has('kickoff')) payload.kickoff = localToIso(str(ctx.fd.get('kickoff')));
      if (ctx.fd.has('focusTeam')) payload.focusTeam = str(ctx.fd.get('focusTeam')) || 'JAX';
      await postAction('updateGame', payload);
    },
    async deleteGame(ctx) {
      await postAction('deleteGame', { id: ctx.id });
      return { message: 'Kampen er slettet.' };
    },
    async createBet(ctx) {
      await postAction('createBet', {
        weekNo: state.adminWeek,
        gameId: str(ctx.fd.get('gameId')),
        title: str(ctx.fd.get('title')),
        optionA: str(ctx.fd.get('optionA')),
        optionB: str(ctx.fd.get('optionB')),
        team: str(ctx.fd.get('team'))
      });
    },
    async updateBet(ctx) {
      await postAction('updateBet', {
        id: ctx.form.dataset.id,
        number: num(ctx.fd.get('number'), 0),
        gameId: str(ctx.fd.get('gameId')),
        title: str(ctx.fd.get('title')),
        optionA: str(ctx.fd.get('optionA')),
        optionB: str(ctx.fd.get('optionB')),
        team: str(ctx.fd.get('team'))
      });
    },
    async deleteBet(ctx) {
      await postAction('deleteBet', { id: ctx.id });
      return { message: 'Bettet er slettet.' };
    },
    async settleBet(ctx) {
      const outcome = str(ctx.fd.get('outcome'));
      if (outcome !== 'A' && outcome !== 'B') throw new Error('Vælg den vindende side.');
      await postAction('settleBet', { id: ctx.form.dataset.id, outcome: outcome });
    },
    async setPicks(ctx) {
      const m = state.model;
      const info = weekInfo(m, state.adminWeek);
      const changed = [];
      info.bets.forEach((b) => {
        const wanted = [];
        m.players.forEach((p) => {
          const side = str(ctx.fd.get('pick:' + b.id + ':' + p.id));
          if (side === 'A' || side === 'B') wanted.push({ playerId: p.id, side: side });
        });
        const current = (m.picksByBet[b.id] || []).map((x) => ({ playerId: x.playerId, side: x.side }));
        const key = (list) => list.slice().sort((x, y) => x.playerId.localeCompare(y.playerId)).map((x) => x.playerId + ':' + x.side).join('|');
        if (key(wanted) !== key(current)) changed.push({ betId: b.id, picks: wanted });
      });
      if (!changed.length) return { message: 'Intet at ændre.', reload: false };
      for (const item of changed) {
        await postAction('setPicks', item);
      }
    },
    async setWildBet(ctx) {
      await postAction('setWildBet', {
        weekNo: state.adminWeek,
        title: str(ctx.fd.get('title')),
        description: str(ctx.fd.get('description')),
        participants: ctx.fd.getAll('participant').map(str).filter(Boolean)
      });
    },
    async settleWildBet(ctx) {
      const outcome = ctx.submitter && ctx.submitter.value;
      if (outcome !== 'hit' && outcome !== 'miss') throw new Error('Vælg et udfald.');
      await postAction('settleWildBet', { weekNo: state.adminWeek, outcome: outcome });
    },
    async updateSettings(ctx) {
      await postAction('updateSettings', { welcomeText: str(ctx.fd.get('welcomeText')) });
    },
    async updatePlayers(ctx) {
      const players = state.model.players.map((p) => ({ id: p.id, nickname: str(ctx.fd.get('nick:' + p.id)) }));
      await postAction('updatePlayers', { players: players });
    }
  };

  // Kører én admin-handling: skriver, viser bekræftelse, genindlæser bogen.
  async function runAdmin(handler, ctx, buttons) {
    if (state.busy) return;
    state.busy = true;
    buttons.forEach((b) => { b.disabled = true; b.setAttribute('aria-busy', 'true'); });
    try {
      const result = await handler(ctx);
      const reload = !(result && result.reload === false);
      toast((result && result.message) || COPY.saved);
      if (reload) await load();
      render();
    } catch (err) {
      if (err && (err.status === 401 || err.status === 403)) {
        sessionStorage.removeItem(TOKEN_KEY);
        toast('Ugyldigt token.', true);
        render();
      } else {
        toast(err && err.message ? err.message : 'Skrivningen mislykkedes. Prøv igen.', true);
        buttons.forEach((b) => { b.disabled = false; b.removeAttribute('aria-busy'); });
      }
    } finally {
      state.busy = false;
    }
  }

  function onSubmit(event) {
    const form = event.target;
    if (!(form instanceof HTMLFormElement) || !form.dataset.action) return;
    event.preventDefault();
    const handler = ADMIN[form.dataset.action];
    if (!handler) return;
    const buttons = Array.from(form.querySelectorAll('button[type="submit"]'));
    runAdmin(handler, { form: form, fd: new FormData(form), submitter: event.submitter || null }, buttons);
  }

  function onDelete(el) {
    const action = el.dataset.action;
    const label = el.dataset.label || '';
    const question = action === 'deleteBet'
      ? 'Slet ' + label + '? Alle picks på bettet slettes også.'
      : 'Slet kampen ' + label + '?';
    if (!window.confirm(question)) return;
    runAdmin(ADMIN[action], { id: el.dataset.id, form: null, fd: null, submitter: null }, [el]);
  }

  function onChange(event) {
    const el = event.target;
    if (el && el.dataset && el.dataset.action === 'selectWeek') {
      state.adminWeek = num(el.value, state.adminWeek);
      render();
    }
  }

  function onClick(event) {
    const el = event.target.closest('[data-action]');
    if (!el || el.tagName === 'FORM' || el.tagName === 'SELECT') return;
    if (el.dataset.action === 'logout') {
      sessionStorage.removeItem(TOKEN_KEY);
      toast('Bogen er lukket.');
      render();
    } else if (el.dataset.action === 'retry') {
      boot();
    } else if (el.dataset.action === 'deleteBet' || el.dataset.action === 'deleteGame') {
      onDelete(el);
    }
  }

  /* ------------------------------------------------------------------------
     Toast
     ------------------------------------------------------------------------ */
  function toast(message, isError) {
    clearTimeout(toastTimer);
    toastEl.textContent = message;
    toastEl.className = 'toast' + (isError ? ' toast--error' : '');
    toastEl.hidden = false;
    toastTimer = setTimeout(() => { toastEl.hidden = true; }, isError ? 6000 : 3200);
  }

  /* ------------------------------------------------------------------------
     Bevægelse: kun som svar på en hændelse
     ------------------------------------------------------------------------ */
  function ensureObserver() {
    if (observer || !('IntersectionObserver' in window)) return observer;
    observer = new IntersectionObserver((entries) => {
      entries.forEach((entry) => {
        if (entry.isIntersecting) {
          entry.target.classList.add('is-in');
          observer.unobserve(entry.target);
        }
      });
    }, { threshold: 0.35 });
    return observer;
  }

  function armReveals() {
    const targets = app.querySelectorAll('.stamp:not(.is-in), .wild--hit:not(.is-in)');
    const io = ensureObserver();
    targets.forEach((el) => {
      if (io) io.observe(el);
      else el.classList.add('is-in');
    });
  }

  function countUpMoney() {
    if (reduceMotion) return;
    const cells = app.querySelectorAll('.board.is-animated .board__money[data-target]');
    if (!cells.length) return;
    const duration = 900;
    const start = performance.now() + 160;
    cells.forEach((cell) => { cell.textContent = fmtMoney(0); });
    const step = (now) => {
      const t = Math.min(1, Math.max(0, (now - start) / duration));
      const eased = 1 - Math.pow(1 - t, 3);
      cells.forEach((cell) => {
        const target = Number(cell.dataset.target) || 0;
        cell.textContent = fmtMoney(Math.round(target * eased));
      });
      if (t < 1) requestAnimationFrame(step);
      else cells.forEach((cell) => { cell.textContent = fmtMoney(Number(cell.dataset.target) || 0); });
    };
    requestAnimationFrame(step);
  }

  function startCountdown() {
    clearInterval(countdownTimer);
    const el = document.getElementById('countdown');
    if (!el) return;
    const tick = () => {
      const diff = new Date(el.dataset.kickoff).getTime() - Date.now();
      if (isNaN(diff) || diff <= 0) { render(); return; }
      const days = Math.floor(diff / 86400000);
      const hours = Math.floor((diff % 86400000) / 3600000);
      const d = el.querySelector('[data-unit="days"]');
      const h = el.querySelector('[data-unit="hours"]');
      if (d && d.textContent !== String(days)) {
        d.textContent = String(days);
        d.nextElementSibling.textContent = days === 1 ? 'dag' : 'dage';
      }
      if (h && h.textContent !== String(hours)) {
        h.textContent = String(hours);
        h.nextElementSibling.textContent = hours === 1 ? 'time' : 'timer';
      }
    };
    countdownTimer = setInterval(tick, 30000);
  }

  /* ------------------------------------------------------------------------
     Router og rendering
     ------------------------------------------------------------------------ */
  function parseRoute() {
    const hash = location.hash.replace(/^#\/?/, '');
    const parts = hash.split('/').filter(Boolean).map(decodeURIComponent);
    return { name: parts[0] || 'home', param: parts[1] || null };
  }

  function setActiveNav(name) {
    document.querySelectorAll('.nav__link').forEach((link) => {
      link.classList.toggle('is-active', link.dataset.route === name);
      if (link.dataset.route === name) link.setAttribute('aria-current', 'page');
      else link.removeAttribute('aria-current');
    });
  }

  function render() {
    const route = parseRoute();
    setActiveNav(route.name);
    clearInterval(countdownTimer);

    if (state.error) {
      const noApi = state.error.code === 'NO_API';
      app.innerHTML = '<div class="state" role="alert">' +
        '<p class="state__text">' + (noApi ? 'Bogen er ikke forbundet.' : COPY.error) + '</p>' +
        (noApi
          ? '<p class="state__hint">Indsæt webappens URL i <code>config.js</code> som <code>API_URL</code>. Se SETUP.md.</p>'
          : '<p class="state__hint">' + esc(state.error.message || '') + '</p><button class="button" type="button" data-action="retry">Prøv igen</button>') +
        '</div>';
      return;
    }
    if (!state.model) {
      app.innerHTML = '<div class="state state--loading" role="status"><p class="state__text">' + COPY.loading + '</p></div>';
      return;
    }

    const m = state.model;
    let html = '';
    let title = 'Wise Men Sports Betting';
    switch (route.name) {
      case 'ranglisten':
        html = viewRanglisten(m);
        title = 'Ranglisten. Wise Men Sports Betting';
        break;
      case 'uger':
        html = viewUger(m);
        title = 'Uger. Wise Men Sports Betting';
        break;
      case 'spiller':
        html = viewSpiller(m, route.param || '');
        title = (m.playersById[route.param] ? displayName(m.playersById[route.param]) + '. ' : '') + 'Wise Men Sports Betting';
        break;
      case 'admin':
        html = viewAdmin(m);
        title = 'Husets bog. Wise Men Sports Betting';
        break;
      default:
        html = viewHome(m);
    }
    app.innerHTML = html;
    document.title = title;

    if (route.name === 'uger' && route.param) {
      const target = document.getElementById('uge-' + route.param);
      if (target) target.scrollIntoView({ block: 'start', behavior: reduceMotion ? 'auto' : 'smooth' });
    } else if (route.name !== 'admin') {
      window.scrollTo({ top: 0, behavior: 'auto' });
    }

    armReveals();
    countUpMoney();
    startCountdown();
  }

  async function boot() {
    state.error = null;
    state.model = null;
    render();
    try {
      await load();
    } catch (err) {
      state.error = err;
    }
    render();
  }

  window.addEventListener('hashchange', render);
  app.addEventListener('submit', onSubmit);
  app.addEventListener('change', onChange);
  app.addEventListener('click', onClick);

  boot();
})();
