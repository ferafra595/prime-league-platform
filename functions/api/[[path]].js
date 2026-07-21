const json = (data, status = 200, headers = {}) => new Response(JSON.stringify(data), {
  status,
  headers: { 'content-type': 'application/json; charset=utf-8', ...headers }
});

const slugify = (value = '') => value.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
const safeText = (value) => typeof value === 'string' ? value.trim() : value;


async function ensureAuthSchema(env) {
  // The production database already contains users and sessions.
  // Do not run schema migrations on every request: this keeps Pages Functions stable.
  if (!env.DB) throw new Error('Binding D1 DB non configurato');
}

function storageRole(role) {
  if (role === 'team') return 'team';
  if (role === 'referee') return 'fan';
  return 'admin';
}

async function setExtendedRole() {
  // Not needed: the existing users.role field is the source of truth.
}

async function hashPassword(password, salt = crypto.randomUUID()) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt: new TextEncoder().encode(salt), iterations: 100000, hash: 'SHA-256' }, key, 256);
  const hash = [...new Uint8Array(bits)].map(b => b.toString(16).padStart(2, '0')).join('');
  return `${salt}:${hash}`;
}

async function verifyPassword(password, stored) {
  if (!stored || !stored.includes(':')) return false;
  const [salt] = stored.split(':');
  return (await hashPassword(password, salt)) === stored;
}

function cookie(name, value, maxAge = 60 * 60 * 24 * 14) {
  return `${name}=${value}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${maxAge}`;
}

async function currentUser(request, env) {
  const token = (request.headers.get('cookie') || '').split(';').map(v => v.trim()).find(v => v.startsWith('pl_session='))?.split('=')[1];
  if (!token) return null;
  return env.DB.prepare(`SELECT u.id,u.email,u.username,u.role,u.team_id,u.display_name,u.avatar_url
    FROM sessions s JOIN users u ON u.id=s.user_id
    WHERE s.id=? AND s.expires_at > datetime('now') AND u.is_active=1`).bind(token).first();
}

function requireRole(user, ...roles) {
  if (!user) return json({ error: 'Accesso richiesto' }, 401);
  if (!roles.includes(user.role)) return json({ error: 'Permessi insufficienti' }, 403);
  return null;
}

const ROLE_ALIASES = {
  admin: 'admin',
  team: 'team',
  fan: 'referee'
};
function normalizedRole(user) { return user ? (ROLE_ALIASES[user.role] || user.role) : null; }
function hasRole(user, ...roles) { return !!user && roles.includes(normalizedRole(user)); }
function requireAnyRole(user, ...roles) {
  if (!user) return json({ error: 'Accesso richiesto' }, 401);
  if (!hasRole(user, ...roles)) return json({ error: 'Permessi insufficienti' }, 403);
  return null;
}
function publicUser(user) {
  if (!user) return null;
  return { ...user, role: normalizedRole(user) };
}
function resetCookie() { return cookie('pl_session','',0); }

async function body(request) {
  try { return await request.json(); } catch { return {}; }
}

async function audit(env, userId, action, entityType = null, entityId = null, details = null) {
  // Audit must never block login or normal operations.
  try {
    await env.DB.prepare('INSERT INTO audit_log(user_id,action,entity_type,entity_id,details) VALUES(?,?,?,?,?)')
      .bind(userId || null, action, entityType, entityId ? String(entityId) : null, details ? JSON.stringify(details) : null).run();
  } catch (error) {
    console.warn('Audit non disponibile:', error?.message || error);
  }
}

async function standings(env, requestedSeasonId = null) {
  const seasons = await env.DB.prepare(`SELECT s.id,s.name,s.start_date,s.end_date,s.is_current,c.name competition_name
    FROM seasons s JOIN competitions c ON c.id=s.competition_id
    ORDER BY s.is_current DESC,COALESCE(s.start_date,'') DESC,s.id DESC`).all();
  const selected = requestedSeasonId
    ? seasons.results.find(s => Number(s.id) === Number(requestedSeasonId))
    : (seasons.results.find(s => Number(s.is_current) === 1) || seasons.results[0]);
  if (!selected) return { standings:[], seasons:[], selectedSeason:null };

  const teams = await env.DB.prepare(`SELECT DISTINCT t.id,t.name,t.slug,t.short_name,t.logo_url,t.primary_color
    FROM teams t
    LEFT JOIN matches mh ON mh.home_team_id=t.id AND mh.season_id=?
    LEFT JOIN matches ma ON ma.away_team_id=t.id AND ma.season_id=?
    WHERE t.is_active=1 OR mh.id IS NOT NULL OR ma.id IS NOT NULL
    ORDER BY t.name`).bind(selected.id,selected.id).all();
  const matches = await env.DB.prepare(`SELECT home_team_id,away_team_id,home_score,away_score
    FROM matches WHERE status='published' AND season_id=?`).bind(selected.id).all();
  const table = new Map(teams.results.map(t => [t.id, { ...t, played:0, won:0, drawn:0, lost:0, gf:0, ga:0, gd:0, points:0 }]));
  for (const m of matches.results) {
    const h = table.get(m.home_team_id), a = table.get(m.away_team_id); if (!h || !a) continue;
    h.played++; a.played++; h.gf += Number(m.home_score||0); h.ga += Number(m.away_score||0); a.gf += Number(m.away_score||0); a.ga += Number(m.home_score||0);
    if (m.home_score > m.away_score) { h.won++; h.points += 3; a.lost++; }
    else if (m.home_score < m.away_score) { a.won++; a.points += 3; h.lost++; }
    else { h.drawn++; a.drawn++; h.points++; a.points++; }
  }
  const rows=[...table.values()].map(t => ({...t, gd:t.gf-t.ga})).sort((a,b) => b.points-a.points || b.gd-a.gd || b.gf-a.gf || a.name.localeCompare(b.name));
  return { standings:rows, seasons:seasons.results, selectedSeason:selected };
}

async function publicDashboard(env) {
  const [next, recent, top, newsRows, sponsors] = await Promise.all([
    env.DB.prepare(`SELECT m.*, ht.name home_name,ht.logo_url home_logo,at.name away_name,at.logo_url away_logo FROM matches m JOIN teams ht ON ht.id=m.home_team_id JOIN teams at ON at.id=m.away_team_id WHERE m.status='scheduled' ORDER BY m.match_date LIMIT 4`).all(),
    env.DB.prepare(`SELECT m.*, ht.name home_name,ht.logo_url home_logo,at.name away_name,at.logo_url away_logo FROM matches m JOIN teams ht ON ht.id=m.home_team_id JOIN teams at ON at.id=m.away_team_id WHERE m.status='published' ORDER BY m.match_date DESC LIMIT 4`).all(),
    env.DB.prepare(`SELECT p.id,p.first_name,p.last_name,p.slug,p.photo_url,t.name team_name,COALESCE(SUM(e.quantity),0) goals FROM players p JOIN teams t ON t.id=p.team_id LEFT JOIN match_events e ON e.player_id=p.id AND e.event_type='goal' GROUP BY p.id ORDER BY goals DESC,p.last_name LIMIT 5`).all(),
    env.DB.prepare(`SELECT id,title,slug,excerpt,cover_url,published_at FROM news WHERE is_published=1 ORDER BY published_at DESC LIMIT 3`).all(),
    env.DB.prepare(`SELECT * FROM sponsors WHERE level='league' AND is_active=1 ORDER BY is_featured DESC,name`).all()
  ]);
  const currentTable=await standings(env); return { next:next.results, recent:recent.results, topScorers:top.results, news:newsRows.results, sponsors:sponsors.results, standings:currentTable.standings };
}

async function route(request, env, path) {
  const method = request.method;
  const user = await currentUser(request, env);

  if (path === 'health') return json({ ok:true, database:true, time:new Date().toISOString() });
  if (path === 'me') return json({ user: publicUser(user) });

  if (path === 'setup' && method === 'POST') {
    const data = await body(request);
    if (!env.SETUP_TOKEN || data.setupToken !== env.SETUP_TOKEN) return json({ error:'Token di configurazione non valido' }, 403);
    const existing = await env.DB.prepare("SELECT id FROM users WHERE role='admin' LIMIT 1").first();
    if (existing) return json({ error:'Amministratore già configurato' }, 409);
    if (!data.email || !data.password || data.password.length < 8) return json({ error:'Email e password di almeno 8 caratteri sono obbligatorie' }, 400);
    const hash = await hashPassword(data.password);
    try {
      await env.DB.prepare("INSERT INTO users(email,username,password_hash,role,display_name) VALUES(?,?,?,?,?)")
        .bind(data.email.toLowerCase(), safeText(data.username || 'admin'), hash, 'admin', safeText(data.displayName || 'Admin')).run();
    } catch (error) {
      const message = String(error?.message || '');
      if (message.includes('UNIQUE')) return json({ error:'Email o username già utilizzati' }, 409);
      throw error;
    }
    return json({ ok:true });
  }

  if (path === 'auth/login' && method === 'POST') {
    const data = await body(request);
    const found = await env.DB.prepare(`SELECT u.* FROM users u WHERE (u.email=? OR u.username=?) AND u.is_active=1`).bind((data.login||'').toLowerCase(), data.login||'').first();
    if (!found || !(await verifyPassword(data.password || '', found.password_hash))) return json({ error:'Credenziali non valide' }, 401);
    await env.DB.prepare("DELETE FROM sessions WHERE expires_at <= datetime('now') OR (user_id=? AND created_at < datetime('now','-30 days'))").bind(found.id).run();
    const token = crypto.randomUUID() + crypto.randomUUID().replaceAll('-','');
    await env.DB.prepare("INSERT INTO sessions(id,user_id,expires_at) VALUES(?,?,datetime('now','+14 days'))").bind(token, found.id).run();
    await audit(env, found.id, 'login');
    return json({ ok:true, user:{id:found.id,email:found.email,role:(ROLE_ALIASES[found.role]||found.role),team_id:found.team_id,display_name:found.display_name} }, 200, { 'set-cookie':cookie('pl_session',token) });
  }

  if (path === 'auth/logout' && method === 'POST') {
    const token = (request.headers.get('cookie') || '').split(';').map(v=>v.trim()).find(v=>v.startsWith('pl_session='))?.split('=')[1];
    if (token) await env.DB.prepare('DELETE FROM sessions WHERE id=?').bind(token).run();
    return json({ ok:true }, 200, { 'set-cookie':cookie('pl_session','',0) });
  }


  if (path === 'auth/request-reset' && method === 'POST') {
    const data = await body(request);
    const login = String(data.login || '').trim();
    const found = login ? await env.DB.prepare('SELECT id,email FROM users WHERE (email=? OR username=?) AND is_active=1').bind(login.toLowerCase(),login).first() : null;
    let resetUrl = null;
    if (found) {
      await env.DB.prepare("DELETE FROM password_reset_tokens WHERE user_id=? OR expires_at <= datetime('now')").bind(found.id).run();
      const token = crypto.randomUUID().replaceAll('-','') + crypto.randomUUID().replaceAll('-','');
      await env.DB.prepare("INSERT INTO password_reset_tokens(token,user_id,expires_at) VALUES(?,?,datetime('now','+30 minutes'))").bind(token,found.id).run();
      // Until an email provider is connected, only privileged users can retrieve a reset link from Account.
      if (env.ALLOW_RESET_LINK_RESPONSE === 'true') resetUrl = `${new URL(request.url).origin}/#/reset-password/${token}`;
      await audit(env,found.id,'password_reset_requested','user',found.id);
    }
    return json({ ok:true, message:'Se l’account esiste, la procedura di recupero è stata avviata.', resetUrl });
  }

  if (path === 'auth/reset-password' && method === 'POST') {
    const data = await body(request);
    if (!data.token || !data.password || data.password.length < 10) return json({error:'Token e password di almeno 10 caratteri sono obbligatori'},400);
    const row = await env.DB.prepare("SELECT * FROM password_reset_tokens WHERE token=? AND used_at IS NULL AND expires_at > datetime('now')").bind(data.token).first();
    if (!row) return json({error:'Link non valido o scaduto'},400);
    const hash = await hashPassword(data.password);
    await env.DB.batch([
      env.DB.prepare('UPDATE users SET password_hash=?,updated_at=CURRENT_TIMESTAMP WHERE id=?').bind(hash,row.user_id),
      env.DB.prepare('UPDATE password_reset_tokens SET used_at=CURRENT_TIMESTAMP WHERE token=?').bind(data.token),
      env.DB.prepare('DELETE FROM sessions WHERE user_id=?').bind(row.user_id)
    ]);
    await audit(env,row.user_id,'password_reset_completed','user',row.user_id);
    return json({ok:true});
  }

  if (path === 'auth/register-fan' && method === 'POST') return json({ error:'Registrazione pubblica disattivata' }, 403);


  if (path === 'public/home') return json(await publicDashboard(env));
  if (path === 'public/standings') {
    const seasonId = new URL(request.url).searchParams.get('season');
    return json(await standings(env, seasonId ? Number(seasonId) : null));
  }
  if (path === 'public/teams') {
    const seasonId = new URL(request.url).searchParams.get('season');
    const tableData = await standings(env, seasonId ? Number(seasonId) : null);
    const selected = tableData.selectedSeason;
    if (!selected) return json({teams:[],seasons:tableData.seasons,selectedSeason:null});
    const formRows = await env.DB.prepare(`SELECT m.home_team_id,m.away_team_id,m.home_score,m.away_score,m.match_date
      FROM matches m WHERE m.season_id=? AND m.status='published' ORDER BY m.match_date DESC,m.id DESC`).bind(selected.id).all();
    const forms = new Map();
    for (const m of formRows.results) {
      for (const [teamId,isHome] of [[m.home_team_id,true],[m.away_team_id,false]]) {
        if (!forms.has(teamId)) forms.set(teamId,[]);
        if (forms.get(teamId).length >= 5) continue;
        const gf = Number(isHome ? m.home_score : m.away_score), ga = Number(isHome ? m.away_score : m.home_score);
        forms.get(teamId).push(gf > ga ? 'V' : gf === ga ? 'N' : 'P');
      }
    }
    const teams = tableData.standings.map((t,index)=>({...t,position:index+1,form:(forms.get(t.id)||[]).join('')}));
    return json({teams,seasons:tableData.seasons,selectedSeason:selected});
  }
  if (path.startsWith('public/team/')) {
    const slug = path.split('/').pop();
    const seasonId = new URL(request.url).searchParams.get('season');
    const team = await env.DB.prepare('SELECT * FROM teams WHERE slug=?').bind(slug).first();
    if (!team) return json({error:'Squadra non trovata'},404);
    const tableData = await standings(env, seasonId ? Number(seasonId) : null);
    const selected = tableData.selectedSeason;
    if (!selected) return json({error:'Nessuna stagione disponibile'},404);
    const rowIndex = tableData.standings.findIndex(t=>Number(t.id)===Number(team.id));
    const teamStats = rowIndex >= 0 ? {...tableData.standings[rowIndex],position:rowIndex+1} : {played:0,won:0,drawn:0,lost:0,gf:0,ga:0,gd:0,points:0,position:null};
    const [players,upcoming,recent,sponsors] = await Promise.all([
      env.DB.prepare(`SELECT p.*,
        COALESCE(SUM(CASE WHEN m.season_id=? AND m.status='published' AND e.event_type='goal' THEN e.quantity ELSE 0 END),0) goals,
        COALESCE(SUM(CASE WHEN m.season_id=? AND m.status='published' AND e.event_type='goal' AND e.assist_player_id=p.id THEN e.quantity ELSE 0 END),0) assists
        FROM players p
        LEFT JOIN match_events e ON e.player_id=p.id OR e.assist_player_id=p.id
        LEFT JOIN matches m ON m.id=e.match_id
        WHERE p.team_id=? AND p.is_active=1
        GROUP BY p.id ORDER BY CASE p.role WHEN 'Portiere' THEN 1 WHEN 'Difensore' THEN 2 WHEN 'Centrocampista' THEN 3 WHEN 'Attaccante' THEN 4 ELSE 5 END,p.shirt_number,p.last_name`).bind(selected.id,selected.id,team.id).all(),
      env.DB.prepare(`SELECT m.*,ht.name home_name,ht.slug home_slug,ht.logo_url home_logo,at.name away_name,at.slug away_slug,at.logo_url away_logo
        FROM matches m JOIN teams ht ON ht.id=m.home_team_id JOIN teams at ON at.id=m.away_team_id
        WHERE m.season_id=? AND m.status='scheduled' AND (m.home_team_id=? OR m.away_team_id=?)
        ORDER BY m.match_date ASC LIMIT 4`).bind(selected.id,team.id,team.id).all(),
      env.DB.prepare(`SELECT m.*,ht.name home_name,ht.slug home_slug,ht.logo_url home_logo,at.name away_name,at.slug away_slug,at.logo_url away_logo
        FROM matches m JOIN teams ht ON ht.id=m.home_team_id JOIN teams at ON at.id=m.away_team_id
        WHERE m.season_id=? AND m.status='published' AND (m.home_team_id=? OR m.away_team_id=?)
        ORDER BY m.match_date DESC LIMIT 5`).bind(selected.id,team.id,team.id).all(),
      env.DB.prepare("SELECT * FROM sponsors WHERE team_id=? AND level='team' AND is_active=1 ORDER BY is_featured DESC,name").bind(team.id).all()
    ]);
    return json({team,stats:teamStats,seasons:tableData.seasons,selectedSeason:selected,players:players.results,upcoming:upcoming.results,recent:recent.results,sponsors:sponsors.results});
  }
  if (path === 'public/players') {
    const seasonId = new URL(request.url).searchParams.get('season');
    const tableData = await standings(env, seasonId ? Number(seasonId) : null);
    const selected = tableData.selectedSeason;
    if (!selected) return json({players:[],seasons:tableData.seasons,selectedSeason:null});
    const rows = await env.DB.prepare(`SELECT p.*,t.name team_name,t.slug team_slug,t.logo_url team_logo,t.primary_color team_color,
      COUNT(DISTINCT CASE WHEN m.season_id=? AND m.status='published' AND (e.player_id=p.id OR e.assist_player_id=p.id OR m.mvp_player_id=p.id) THEN m.id END) appearances,
      COALESCE(SUM(CASE WHEN m.season_id=? AND m.status='published' AND e.player_id=p.id AND e.event_type='goal' THEN e.quantity ELSE 0 END),0) goals,
      COALESCE(SUM(CASE WHEN m.season_id=? AND m.status='published' AND e.assist_player_id=p.id AND e.event_type='goal' THEN e.quantity ELSE 0 END),0) assists,
      COALESCE(SUM(CASE WHEN m.season_id=? AND m.status='published' AND e.player_id=p.id AND e.event_type='yellow' THEN e.quantity ELSE 0 END),0) yellows,
      COALESCE(SUM(CASE WHEN m.season_id=? AND m.status='published' AND e.player_id=p.id AND e.event_type='red' THEN e.quantity ELSE 0 END),0) reds,
      COUNT(DISTINCT CASE WHEN m.season_id=? AND m.status='published' AND m.mvp_player_id=p.id THEN m.id END) mvps
      FROM players p JOIN teams t ON t.id=p.team_id
      LEFT JOIN match_events e ON e.player_id=p.id OR e.assist_player_id=p.id
      LEFT JOIN matches m ON m.id=e.match_id OR m.mvp_player_id=p.id
      WHERE p.is_active=1 GROUP BY p.id
      ORDER BY t.name,CASE p.role WHEN 'Portiere' THEN 1 WHEN 'Difensore' THEN 2 WHEN 'Centrocampista' THEN 3 WHEN 'Attaccante' THEN 4 ELSE 5 END,p.shirt_number,p.last_name,p.first_name`)
      .bind(selected.id,selected.id,selected.id,selected.id,selected.id,selected.id).all();
    return json({players:rows.results,seasons:tableData.seasons,selectedSeason:selected});
  }
  if (path.startsWith('public/player/')) {
    const slug = path.split('/').pop();
    const seasonId = new URL(request.url).searchParams.get('season');
    const tableData = await standings(env, seasonId ? Number(seasonId) : null);
    const selected = tableData.selectedSeason;
    const player = await env.DB.prepare(`SELECT p.*,t.name team_name,t.slug team_slug,t.logo_url team_logo,t.primary_color FROM players p JOIN teams t ON t.id=p.team_id WHERE p.slug=?`).bind(slug).first();
    if (!player) return json({error:'Giocatore non trovato'},404);
    if (!selected) return json({error:'Nessuna stagione disponibile'},404);
    const aggregate = async sid => {
      const base = await env.DB.prepare(`SELECT
        COUNT(DISTINCT CASE WHEN m.status='published' AND (e.player_id=? OR e.assist_player_id=? OR m.mvp_player_id=?) THEN m.id END) appearances,
        COALESCE(SUM(CASE WHEN m.status='published' AND e.player_id=? AND e.event_type='goal' THEN e.quantity ELSE 0 END),0) goals,
        COALESCE(SUM(CASE WHEN m.status='published' AND e.assist_player_id=? AND e.event_type='goal' THEN e.quantity ELSE 0 END),0) assists,
        COALESCE(SUM(CASE WHEN m.status='published' AND e.player_id=? AND e.event_type='yellow' THEN e.quantity ELSE 0 END),0) yellows,
        COALESCE(SUM(CASE WHEN m.status='published' AND e.player_id=? AND e.event_type='red' THEN e.quantity ELSE 0 END),0) reds,
        COUNT(DISTINCT CASE WHEN m.status='published' AND m.mvp_player_id=? THEN m.id END) mvps
        FROM matches m LEFT JOIN match_events e ON e.match_id=m.id WHERE m.season_id=?`)
        .bind(player.id,player.id,player.id,player.id,player.id,player.id,player.id,player.id,sid).first();
      return base;
    };
    const stats = await aggregate(selected.id);
    const scorerRankRows = await env.DB.prepare(`SELECT e.player_id,SUM(e.quantity) value FROM match_events e JOIN matches m ON m.id=e.match_id WHERE m.season_id=? AND m.status='published' AND e.event_type='goal' GROUP BY e.player_id ORDER BY value DESC`).bind(selected.id).all();
    const assistRankRows = await env.DB.prepare(`SELECT e.assist_player_id player_id,SUM(e.quantity) value FROM match_events e JOIN matches m ON m.id=e.match_id WHERE m.season_id=? AND m.status='published' AND e.event_type='goal' AND e.assist_player_id IS NOT NULL GROUP BY e.assist_player_id ORDER BY value DESC`).bind(selected.id).all();
    stats.rank_scorers = scorerRankRows.results.findIndex(r=>Number(r.player_id)===Number(player.id))+1 || null;
    stats.rank_assists = assistRankRows.results.findIndex(r=>Number(r.player_id)===Number(player.id))+1 || null;
    const recent = await env.DB.prepare(`SELECT m.*,ht.name home_name,ht.logo_url home_logo,at.name away_name,at.logo_url away_logo,
      COALESCE(SUM(CASE WHEN e.player_id=? AND e.event_type='goal' THEN e.quantity ELSE 0 END),0) player_goals,
      COALESCE(SUM(CASE WHEN e.assist_player_id=? AND e.event_type='goal' THEN e.quantity ELSE 0 END),0) player_assists,
      COALESCE(SUM(CASE WHEN e.player_id=? AND e.event_type='yellow' THEN e.quantity ELSE 0 END),0) player_yellows,
      COALESCE(SUM(CASE WHEN e.player_id=? AND e.event_type='red' THEN e.quantity ELSE 0 END),0) player_reds,
      CASE WHEN m.mvp_player_id=? THEN 1 ELSE 0 END is_mvp
      FROM matches m JOIN teams ht ON ht.id=m.home_team_id JOIN teams at ON at.id=m.away_team_id
      LEFT JOIN match_events e ON e.match_id=m.id
      WHERE m.season_id=? AND m.status='published' AND (EXISTS(SELECT 1 FROM match_events pe WHERE pe.match_id=m.id AND (pe.player_id=? OR pe.assist_player_id=?)) OR m.mvp_player_id=?)
      GROUP BY m.id ORDER BY m.match_date DESC LIMIT 8`).bind(player.id,player.id,player.id,player.id,player.id,selected.id,player.id,player.id,player.id).all();
    const career=[];
    for (const season of tableData.seasons) {
      const row=await aggregate(season.id);
      career.push({season_id:season.id,season_name:season.name,team_name:player.team_name,...row});
    }
    return json({player,stats,recent:recent.results,career,seasons:tableData.seasons,selectedSeason:selected});
  }
  if (path === 'public/matches') {
    const rows = await env.DB.prepare(`SELECT m.*,ht.name home_name,ht.slug home_slug,ht.logo_url home_logo,at.name away_name,at.slug away_slug,at.logo_url away_logo,p.first_name mvp_first,p.last_name mvp_last FROM matches m JOIN teams ht ON ht.id=m.home_team_id JOIN teams at ON at.id=m.away_team_id LEFT JOIN players p ON p.id=m.mvp_player_id ORDER BY m.match_date DESC`).all();
    return json({matches:rows.results});
  }
  if (path.match(/^public\/match\/\d+$/)) {
    const matchId = Number(path.split('/').pop());
    const match = await env.DB.prepare(`
      SELECT m.*,
        ht.name home_name, ht.slug home_slug, ht.logo_url home_logo,
        at.name away_name, at.slug away_slug, at.logo_url away_logo,
        p.id mvp_player_id, p.slug mvp_slug, p.photo_url mvp_photo,
        TRIM(COALESCE(p.first_name,'') || ' ' || COALESCE(p.last_name,'')) mvp_name,
        mt.name mvp_team_name
      FROM matches m
      JOIN teams ht ON ht.id=m.home_team_id
      JOIN teams at ON at.id=m.away_team_id
      LEFT JOIN players p ON p.id=m.mvp_player_id
      LEFT JOIN teams mt ON mt.id=p.team_id
      WHERE m.id=?
    `).bind(matchId).first();
    if (!match) return json({error:'Partita non trovata'},404);

    const events = await env.DB.prepare(`
      SELECT e.id,e.match_id,e.team_id,e.player_id,e.assist_player_id,e.event_type,e.quantity,
        TRIM(COALESCE(p.first_name,'') || ' ' || COALESCE(p.last_name,'')) player_name,
        p.slug player_slug,p.photo_url player_photo,
        TRIM(COALESCE(a.first_name,'') || ' ' || COALESCE(a.last_name,'')) assist_name,
        a.slug assist_slug,a.photo_url assist_photo,
        t.name team_name,t.slug team_slug,t.logo_url team_logo
      FROM match_events e
      JOIN teams t ON t.id=e.team_id
      LEFT JOIN players p ON p.id=e.player_id
      LEFT JOIN players a ON a.id=e.assist_player_id
      WHERE e.match_id=?
      ORDER BY CASE e.event_type WHEN 'goal' THEN 1 WHEN 'yellow' THEN 2 WHEN 'red' THEN 3 ELSE 4 END,e.id
    `).bind(matchId).all();

    const related = await env.DB.prepare(`
      SELECT m.*,ht.name home_name,ht.slug home_slug,ht.logo_url home_logo,
        at.name away_name,at.slug away_slug,at.logo_url away_logo
      FROM matches m
      JOIN teams ht ON ht.id=m.home_team_id
      JOIN teams at ON at.id=m.away_team_id
      WHERE m.id<>? AND m.season_id=? AND COALESCE(m.round_name,'')=COALESCE(?,'')
      ORDER BY m.match_date
      LIMIT 4
    `).bind(matchId,match.season_id,match.round_name||'').all();

    async function recentForm(teamId){
      const rows = await env.DB.prepare(`
        SELECT home_team_id,away_team_id,home_score,away_score
        FROM matches
        WHERE status='published' AND id<>? AND (home_team_id=? OR away_team_id=?)
        ORDER BY match_date DESC LIMIT 5
      `).bind(matchId,teamId,teamId).all();
      return rows.results.map(r=>{
        const home=Number(r.home_team_id)===Number(teamId);
        const gf=Number(home?r.home_score:r.away_score);
        const ga=Number(home?r.away_score:r.home_score);
        return gf>ga?'w':gf<ga?'l':'d';
      });
    }
    const [homeForm,awayForm]=await Promise.all([recentForm(match.home_team_id),recentForm(match.away_team_id)]);
    return json({match,events:events.results,related:related.results,team_form:{home:homeForm,away:awayForm}});
  }
  if (path === 'public/stats') {
    const params = new URL(request.url).searchParams;
    const requestedSeason = params.get('season');
    const teamId = Number(params.get('team') || 0);
    const allowedRoles = ['Portiere','Difensore','Centrocampista','Attaccante'];
    const role = allowedRoles.includes(params.get('role')) ? params.get('role') : '';
    const tableData = await standings(env, requestedSeason ? Number(requestedSeason) : null);
    const selected = tableData.selectedSeason;
    if (!selected) return json({seasons:tableData.seasons,selectedSeason:null,overview:{},scorers:[],assists:[],mvps:[],yellows:[],reds:[],teams:[],roundGoals:[]});

    const playerWhere = `${teamId ? ' AND p.team_id='+teamId : ''}${role ? " AND p.role='"+role+"'" : ''}`;
    const leaderboard = async (kind) => {
      let joinField = 'e.player_id', eventFilter = "e.event_type='goal'", valueExpr = 'SUM(e.quantity)';
      if (kind === 'assists') joinField = 'e.assist_player_id';
      if (kind === 'yellow') eventFilter = "e.event_type='yellow'";
      if (kind === 'red') eventFilter = "e.event_type='red'";
      if (kind === 'mvp') {
        return (await env.DB.prepare(`SELECT p.id,p.first_name,p.last_name,p.slug,p.photo_url,p.role,t.id team_id,t.name team_name,t.logo_url team_logo,COUNT(m.id) value
          FROM matches m JOIN players p ON p.id=m.mvp_player_id JOIN teams t ON t.id=p.team_id
          WHERE m.status='published' AND m.season_id=? ${playerWhere}
          GROUP BY p.id ORDER BY value DESC,p.last_name,p.first_name LIMIT 100`).bind(selected.id).all()).results;
      }
      return (await env.DB.prepare(`SELECT p.id,p.first_name,p.last_name,p.slug,p.photo_url,p.role,t.id team_id,t.name team_name,t.logo_url team_logo,${valueExpr} value
        FROM match_events e JOIN matches m ON m.id=e.match_id JOIN players p ON p.id=${joinField} JOIN teams t ON t.id=p.team_id
        WHERE m.status='published' AND m.season_id=? AND ${eventFilter} ${kind==='assists'?'AND e.assist_player_id IS NOT NULL':''} ${playerWhere}
        GROUP BY p.id ORDER BY value DESC,p.last_name,p.first_name LIMIT 100`).bind(selected.id).all()).results;
    };

    const [scorers,assists,mvps,yellows,reds,overviewRow,roundRows,teamRows] = await Promise.all([
      leaderboard('scorers'), leaderboard('assists'), leaderboard('mvp'), leaderboard('yellow'), leaderboard('red'),
      env.DB.prepare(`SELECT COUNT(*) matches_played,COALESCE(SUM(home_score+away_score),0) total_goals,
        COALESCE(MAX(home_score+away_score),0) max_goals_match,
        COUNT(DISTINCT home_team_id)+COUNT(DISTINCT away_team_id) raw_team_count
        FROM matches WHERE status='published' AND season_id=?`).bind(selected.id).first(),
      env.DB.prepare(`SELECT COALESCE(round_name,'Giornata') round_name,COUNT(*) matches_played,COALESCE(SUM(home_score+away_score),0) goals,MIN(match_date) first_date
        FROM matches WHERE status='published' AND season_id=? GROUP BY COALESCE(round_name,'Giornata') ORDER BY first_date,id`).bind(selected.id).all(),
      env.DB.prepare(`SELECT DISTINCT t.id,t.name,t.slug,t.logo_url FROM teams t
        JOIN matches m ON (m.home_team_id=t.id OR m.away_team_id=t.id) WHERE m.season_id=? ORDER BY t.name`).bind(selected.id).all()
    ]);

    const publishedMatches = Number(overviewRow?.matches_played || 0);
    const totalGoals = Number(overviewRow?.total_goals || 0);
    const totalYellows = yellows.reduce((n,r)=>n+Number(r.value||0),0);
    const totalReds = reds.reduce((n,r)=>n+Number(r.value||0),0);
    const standingsRows = tableData.standings.map((t,index)=>({...t,position:index+1}));
    const filteredTeams = teamId ? standingsRows.filter(t=>Number(t.id)===teamId) : standingsRows;
    const byAttack=[...filteredTeams].sort((a,b)=>b.gf-a.gf || b.points-a.points);
    const byDefense=[...filteredTeams].sort((a,b)=>a.ga-b.ga || b.points-a.points);
    const byWins=[...filteredTeams].sort((a,b)=>b.won-a.won || b.points-a.points);
    return json({
      seasons:tableData.seasons,selectedSeason:selected,teams:teamRows.results,
      overview:{matches:publishedMatches,goals:totalGoals,goals_per_match:publishedMatches?(totalGoals/publishedMatches):0,yellows:totalYellows,reds:totalReds,teams:standingsRows.length},
      scorers,assists,mvps,yellows,reds,
      teamRankings:{attack:byAttack,defense:byDefense,wins:byWins},
      roundGoals:roundRows.results
    });
  }
  if (path === 'public/news') {
    const rows = await env.DB.prepare('SELECT * FROM news WHERE is_published=1 ORDER BY published_at DESC').all();
    return json({news:rows.results});
  }
  if (path === 'public/polls') {
    const polls = await env.DB.prepare(`SELECT p.*,COUNT(v.id) votes_count FROM polls p LEFT JOIN votes v ON v.poll_id=p.id WHERE p.status='open' AND p.starts_at<=datetime('now') AND p.ends_at>=datetime('now') GROUP BY p.id ORDER BY p.ends_at`).all();
    for (const p of polls.results) {
      p.options = (await env.DB.prepare(`SELECT o.*,COUNT(v.id) votes FROM poll_options o LEFT JOIN votes v ON v.option_id=o.id WHERE o.poll_id=? GROUP BY o.id ORDER BY o.id`).bind(p.id).all()).results;
      p.user_voted = user ? !!(await env.DB.prepare('SELECT id FROM votes WHERE poll_id=? AND user_id=?').bind(p.id,user.id).first()) : false;
    }
    return json({polls:polls.results,authenticated:!!user});
  }
  if (path === 'vote' && method === 'POST') {
    const denied = requireAnyRole(user,'fan','admin','team','referee'); if (denied) return denied;
    const data = await body(request);
    const option = await env.DB.prepare(`SELECT o.id,o.poll_id,p.status,p.starts_at,p.ends_at FROM poll_options o JOIN polls p ON p.id=o.poll_id WHERE o.id=?`).bind(data.optionId).first();
    if (!option || option.status!=='open') return json({error:'Votazione non disponibile'},400);
    try { await env.DB.prepare('INSERT INTO votes(poll_id,option_id,user_id) VALUES(?,?,?)').bind(option.poll_id,option.id,user.id).run(); }
    catch { return json({error:'Hai già votato'},409); }
    return json({ok:true});
  }

  // Dashboard data
  if (path === 'dashboard') {
    const denied = requireAnyRole(user,'admin','team','referee'); if (denied) return denied;
    if (hasRole(user,'admin')) {
      const counts = {};
      for (const table of ['teams','players','matches','users','sponsors']) counts[table] = (await env.DB.prepare(`SELECT COUNT(*) c FROM ${table}`).first()).c;
      counts.pending = (await env.DB.prepare("SELECT COUNT(*) c FROM match_submissions WHERE status='pending'").first()).c;
      const currentSeason = await env.DB.prepare(`SELECT s.*,c.name competition_name FROM seasons s JOIN competitions c ON c.id=s.competition_id WHERE s.is_current=1 ORDER BY s.id DESC LIMIT 1`).first();
      const recentMatches = (await env.DB.prepare(`SELECT m.id,m.round_name,m.match_date,m.status,m.home_score,m.away_score,ht.name home_name,at.name away_name FROM matches m JOIN teams ht ON ht.id=m.home_team_id JOIN teams at ON at.id=m.away_team_id ORDER BY m.match_date DESC LIMIT 5`).all()).results;
      return json({user:publicUser(user),counts,currentSeason,recentMatches});
    }
    const team = await env.DB.prepare('SELECT * FROM teams WHERE id=?').bind(user.team_id).first();
    const counts = {
      players:(await env.DB.prepare('SELECT COUNT(*) c FROM players WHERE team_id=? AND is_active=1').bind(user.team_id).first()).c,
      sponsors:(await env.DB.prepare("SELECT COUNT(*) c FROM sponsors WHERE team_id=? AND level='team' AND is_active=1").bind(user.team_id).first()).c,
      pending:(await env.DB.prepare("SELECT COUNT(*) c FROM match_submissions WHERE team_id=? AND status='pending'").bind(user.team_id).first()).c
    };
    return json({user:publicUser(user),team,counts});
  }

  if (path === 'admin/seasons') {
    const denied=requireAnyRole(user,'admin'); if(denied)return denied;
    if(method==='GET') return json({seasons:(await env.DB.prepare(`SELECT s.*,c.name competition_name FROM seasons s JOIN competitions c ON c.id=s.competition_id ORDER BY s.is_current DESC,s.start_date DESC,s.id DESC`).all()).results});
    if(method==='POST') {
      const d=await body(request); if(!d.name)return json({error:'Nome stagione obbligatorio'},400);
      if(d.is_current) await env.DB.prepare('UPDATE seasons SET is_current=0').run();
      const r=await env.DB.prepare('INSERT INTO seasons(competition_id,name,start_date,end_date,is_current) VALUES(1,?,?,?,?)').bind(safeText(d.name),d.start_date||null,d.end_date||null,d.is_current?1:0).run();
      await audit(env,user.id,'create','season',r.meta.last_row_id,d); return json({ok:true,id:r.meta.last_row_id},201);
    }
  }
  if (path.match(/^admin\/seasons\/\d+$/) && method==='PUT') {
    const denied=requireAnyRole(user,'admin'); if(denied)return denied; const id=Number(path.split('/').pop()); const d=await body(request);
    if(!d.name)return json({error:'Nome stagione obbligatorio'},400);
    if(d.is_current) await env.DB.prepare('UPDATE seasons SET is_current=0').run();
    await env.DB.prepare('UPDATE seasons SET name=?,start_date=?,end_date=?,is_current=? WHERE id=?').bind(safeText(d.name),d.start_date||null,d.end_date||null,d.is_current?1:0,id).run();
    await audit(env,user.id,'update','season',id,d); return json({ok:true});
  }
  if (path.match(/^admin\/seasons\/\d+\/current$/) && method==='POST') {
    const denied=requireAnyRole(user,'admin'); if(denied)return denied; const id=Number(path.split('/')[2]);
    await env.DB.prepare('UPDATE seasons SET is_current=0').run(); await env.DB.prepare('UPDATE seasons SET is_current=1 WHERE id=?').bind(id).run();
    await audit(env,user.id,'set_current','season',id,{}); return json({ok:true});
  }

  // Generic admin list endpoints
  if (path === 'admin/teams') {
    const denied=requireAnyRole(user,'admin'); if(denied)return denied;
    if(method==='GET') return json({teams:(await env.DB.prepare('SELECT * FROM teams ORDER BY name').all()).results});
    if(method==='POST') { const d=await body(request); if(!d.name)return json({error:'Nome obbligatorio'},400); const result=await env.DB.prepare('INSERT INTO teams(name,slug,short_name,logo_url,primary_color,secondary_color,manager_name,coach_name,description) VALUES(?,?,?,?,?,?,?,?,?)').bind(safeText(d.name),slugify(d.slug||d.name),safeText(d.short_name||''),safeText(d.logo_url||''),d.primary_color||'#7c3cff',d.secondary_color||'#ffffff',safeText(d.manager_name||''),safeText(d.coach_name||''),safeText(d.description||'')).run(); await audit(env,user.id,'create','team',result.meta.last_row_id,d); return json({ok:true,id:result.meta.last_row_id},201); }
  }
  if (path.match(/^admin\/teams\/\d+$/)) {
    const denied=requireAnyRole(user,'admin'); if(denied)return denied; const id=Number(path.split('/').pop()); const d=await body(request);
    if(method==='PUT') { await env.DB.prepare('UPDATE teams SET name=?,slug=?,short_name=?,logo_url=?,primary_color=?,secondary_color=?,manager_name=?,coach_name=?,description=?,is_active=?,updated_at=CURRENT_TIMESTAMP WHERE id=?').bind(d.name,slugify(d.slug||d.name),d.short_name||'',d.logo_url||'',d.primary_color||'#7c3cff',d.secondary_color||'#ffffff',d.manager_name||'',d.coach_name||'',d.description||'',d.is_active===0?0:1,id).run(); await audit(env,user.id,'update','team',id,d); return json({ok:true}); }
    if(method==='DELETE') { await env.DB.prepare('UPDATE teams SET is_active=0 WHERE id=?').bind(id).run(); await audit(env,user.id,'disable','team',id); return json({ok:true}); }
  }
  if (path === 'admin/players' || path === 'team/players') {
    const denied=requireAnyRole(user,'admin','team'); if(denied)return denied;
    const teamFilter=hasRole(user,'team')?user.team_id:null;
    if(method==='GET') { const q=teamFilter?env.DB.prepare('SELECT p.*,t.name team_name FROM players p JOIN teams t ON t.id=p.team_id WHERE p.team_id=? ORDER BY p.last_name').bind(teamFilter):env.DB.prepare('SELECT p.*,t.name team_name FROM players p JOIN teams t ON t.id=p.team_id ORDER BY t.name,p.last_name'); return json({players:(await q.all()).results}); }
    if(method==='POST') { const d=await body(request); const teamId=teamFilter||Number(d.team_id); if(!teamId||!d.first_name||!d.last_name||!d.role)return json({error:'Dati obbligatori mancanti'},400); const result=await env.DB.prepare('INSERT INTO players(team_id,first_name,last_name,slug,shirt_number,role,photo_url) VALUES(?,?,?,?,?,?,?)').bind(teamId,safeText(d.first_name),safeText(d.last_name),slugify(d.slug||`${d.first_name}-${d.last_name}-${crypto.randomUUID().slice(0,5)}`),d.shirt_number?Number(d.shirt_number):null,d.role,d.photo_url||'').run(); await audit(env,user.id,'create','player',result.meta.last_row_id,d); return json({ok:true,id:result.meta.last_row_id},201); }
  }
  if (path.match(/^(admin|team)\/players\/\d+$/)) {
    const denied=requireAnyRole(user,'admin','team'); if(denied)return denied; const id=Number(path.split('/').pop()); const existing=await env.DB.prepare('SELECT * FROM players WHERE id=?').bind(id).first(); if(!existing)return json({error:'Non trovato'},404); if(hasRole(user,'team')&&existing.team_id!==user.team_id)return json({error:'Permessi insufficienti'},403); const d=await body(request);
    if(method==='PUT') { const teamId=hasRole(user,'team')?user.team_id:Number(d.team_id||existing.team_id); await env.DB.prepare('UPDATE players SET team_id=?,first_name=?,last_name=?,slug=?,shirt_number=?,role=?,photo_url=?,is_active=?,updated_at=CURRENT_TIMESTAMP WHERE id=?').bind(teamId,d.first_name,d.last_name,slugify(d.slug||`${d.first_name}-${d.last_name}-${id}`),d.shirt_number?Number(d.shirt_number):null,d.role,d.photo_url||'',d.is_active===0?0:1,id).run(); await audit(env,user.id,'update','player',id,d); return json({ok:true}); }
    if(method==='DELETE') { await env.DB.prepare('UPDATE players SET is_active=0 WHERE id=?').bind(id).run(); await audit(env,user.id,'disable','player',id); return json({ok:true}); }
  }
  if (path === 'admin/matches') {
    const denied=requireAnyRole(user,'admin'); if(denied)return denied;
    if(method==='GET') return json({matches:(await env.DB.prepare(`SELECT m.*,ht.name home_name,at.name away_name FROM matches m JOIN teams ht ON ht.id=m.home_team_id JOIN teams at ON at.id=m.away_team_id ORDER BY m.match_date DESC`).all()).results});
    if(method==='POST') { const d=await body(request); const result=await env.DB.prepare('INSERT INTO matches(season_id,round_name,home_team_id,away_team_id,match_date,venue,status) VALUES(?,?,?,?,?,?,?)').bind(Number(d.season_id||1),d.round_name||'',Number(d.home_team_id),Number(d.away_team_id),d.match_date,d.venue||'',d.status||'scheduled').run(); await audit(env,user.id,'create','match',result.meta.last_row_id,d); return json({ok:true,id:result.meta.last_row_id},201); }
  }
  if (path.match(/^admin\/matches\/\d+$/) && method==='PUT') {
    const denied=requireAnyRole(user,'admin'); if(denied)return denied; const id=Number(path.split('/').pop()); const d=await body(request);
    await env.DB.prepare('UPDATE matches SET round_name=?,home_team_id=?,away_team_id=?,match_date=?,venue=?,status=?,home_score=?,away_score=?,highlights_url=?,mvp_player_id=?,updated_at=CURRENT_TIMESTAMP WHERE id=?').bind(d.round_name||'',Number(d.home_team_id),Number(d.away_team_id),d.match_date,d.venue||'',d.status||'scheduled',d.home_score===''?null:Number(d.home_score),d.away_score===''?null:Number(d.away_score),d.highlights_url||'',d.mvp_player_id?Number(d.mvp_player_id):null,id).run();
    if(Array.isArray(d.events)) { await env.DB.prepare('DELETE FROM match_events WHERE match_id=?').bind(id).run(); for(const e of d.events) await env.DB.prepare('INSERT INTO match_events(match_id,team_id,player_id,assist_player_id,event_type,quantity) VALUES(?,?,?,?,?,?)').bind(id,Number(e.team_id),e.player_id?Number(e.player_id):null,e.assist_player_id?Number(e.assist_player_id):null,e.event_type,Number(e.quantity||1)).run(); }
    await audit(env,user.id,'update','match',id,d); return json({ok:true});
  }
  if (path === 'team/matches') {
    const denied=requireAnyRole(user,'team','referee'); if(denied)return denied;
    const q=hasRole(user,'referee')
      ? env.DB.prepare(`SELECT m.*,ht.name home_name,at.name away_name FROM matches m JOIN teams ht ON ht.id=m.home_team_id JOIN teams at ON at.id=m.away_team_id ORDER BY m.match_date DESC`)
      : env.DB.prepare(`SELECT m.*,ht.name home_name,at.name away_name FROM matches m JOIN teams ht ON ht.id=m.home_team_id JOIN teams at ON at.id=m.away_team_id WHERE m.home_team_id=? OR m.away_team_id=? ORDER BY m.match_date DESC`).bind(user.team_id,user.team_id);
    const rows=await q.all(); return json({matches:rows.results});
  }
  if (path === 'team/submissions' && method==='POST') {
    const denied=requireAnyRole(user,'team','referee'); if(denied)return denied; const d=await body(request);
    const match=hasRole(user,'referee')
      ? await env.DB.prepare('SELECT * FROM matches WHERE id=?').bind(Number(d.match_id)).first()
      : await env.DB.prepare('SELECT * FROM matches WHERE id=? AND (home_team_id=? OR away_team_id=?)').bind(Number(d.match_id),user.team_id,user.team_id).first();
    if(!match)return json({error:'Partita non valida'},400);
    const submissionTeamId=hasRole(user,'referee')?match.home_team_id:user.team_id;
    const result=await env.DB.prepare('INSERT INTO match_submissions(match_id,submitted_by_user_id,team_id,home_score,away_score,events_json,notes) VALUES(?,?,?,?,?,?,?)').bind(match.id,user.id,submissionTeamId,Number(d.home_score),Number(d.away_score),JSON.stringify(d.events||[]),d.notes||'').run(); await audit(env,user.id,'submit','match_submission',result.meta.last_row_id,d); return json({ok:true},201);
  }
  if (path === 'admin/submissions') {
    const denied=requireAnyRole(user,'admin'); if(denied)return denied; const rows=await env.DB.prepare(`SELECT s.*,t.name team_name,m.round_name,ht.name home_name,at.name away_name,u.display_name submitted_by FROM match_submissions s JOIN teams t ON t.id=s.team_id JOIN users u ON u.id=s.submitted_by_user_id JOIN matches m ON m.id=s.match_id JOIN teams ht ON ht.id=m.home_team_id JOIN teams at ON at.id=m.away_team_id ORDER BY CASE s.status WHEN 'pending' THEN 0 ELSE 1 END,s.created_at DESC`).all(); return json({submissions:rows.results});
  }
  if (path.match(/^admin\/submissions\/\d+\/(approve|reject)$/) && method==='POST') {
    const denied=requireAnyRole(user,'admin'); if(denied)return denied; const parts=path.split('/'); const id=Number(parts[2]); const action=parts[3]; const d=await body(request); const s=await env.DB.prepare('SELECT * FROM match_submissions WHERE id=?').bind(id).first(); if(!s)return json({error:'Invio non trovato'},404);
    if(action==='approve') { await env.DB.prepare("UPDATE match_submissions SET status='approved',admin_note=?,reviewed_at=CURRENT_TIMESTAMP WHERE id=?").bind(d.admin_note||'',id).run(); await env.DB.prepare("UPDATE matches SET home_score=?,away_score=?,status='published',updated_at=CURRENT_TIMESTAMP WHERE id=?").bind(s.home_score,s.away_score,s.match_id).run(); const events=JSON.parse(s.events_json||'[]'); await env.DB.prepare('DELETE FROM match_events WHERE match_id=?').bind(s.match_id).run(); for(const e of events) await env.DB.prepare('INSERT INTO match_events(match_id,team_id,player_id,assist_player_id,event_type,quantity) VALUES(?,?,?,?,?,?)').bind(s.match_id,Number(e.team_id),e.player_id?Number(e.player_id):null,e.assist_player_id?Number(e.assist_player_id):null,e.event_type,Number(e.quantity||1)).run(); }
    else await env.DB.prepare("UPDATE match_submissions SET status='rejected',admin_note=?,reviewed_at=CURRENT_TIMESTAMP WHERE id=?").bind(d.admin_note||'',id).run(); await audit(env,user.id,action,'match_submission',id,d); return json({ok:true});
  }
  if (path === 'admin/users') {
    const denied=requireAnyRole(user,'admin'); if(denied)return denied;
    if(method==='GET') { const rows=(await env.DB.prepare('SELECT u.id,u.email,u.username,u.role,u.team_id,u.display_name,u.is_active,u.created_at FROM users u ORDER BY role,display_name').all()).results.map(u=>({...u,role:ROLE_ALIASES[u.role]||u.role})); return json({users:rows}); }
    if(method==='POST') { const d=await body(request); if(!d.email||!d.password||d.password.length<10||!d.display_name)return json({error:'Nome, email e password di almeno 10 caratteri sono obbligatori'},400); const role=['admin','team','referee'].includes(d.role)?d.role:'referee'; const hash=await hashPassword(d.password); const result=await env.DB.prepare('INSERT INTO users(email,username,password_hash,role,team_id,display_name) VALUES(?,?,?,?,?,?)').bind(d.email.toLowerCase(),d.username||null,hash,storageRole(role),d.team_id?Number(d.team_id):null,d.display_name).run(); await audit(env,user.id,'create','user',result.meta.last_row_id,d); return json({ok:true,id:result.meta.last_row_id},201); }
  }

  if (path.match(/^admin\/users\/\d+$/) && method==='PUT') {
    const denied=requireAnyRole(user,'admin'); if(denied)return denied;
    const id=Number(path.split('/').pop()), d=await body(request);
    const role=['admin','team','referee'].includes(d.role)?d.role:'referee';
    if (id===user.id && d.is_active===0) return json({error:'Non puoi disattivare il tuo account'},400);
    await env.DB.prepare('UPDATE users SET display_name=?,email=?,username=?,role=?,team_id=?,is_active=?,updated_at=CURRENT_TIMESTAMP WHERE id=?')
      .bind(safeText(d.display_name),String(d.email||'').toLowerCase(),safeText(d.username||'')||null,storageRole(role),d.team_id?Number(d.team_id):null,d.is_active===0?0:1,id).run();
    if(d.is_active===0) await env.DB.prepare('DELETE FROM sessions WHERE user_id=?').bind(id).run();
    await audit(env,user.id,'update','user',id,{role,is_active:d.is_active}); return json({ok:true});
  }
  if (path.match(/^admin\/users\/\d+\/reset-link$/) && method==='POST') {
    const denied=requireAnyRole(user,'admin'); if(denied)return denied;
    const id=Number(path.split('/')[2]); const found=await env.DB.prepare('SELECT id FROM users WHERE id=?').bind(id).first();
    if(!found)return json({error:'Account non trovato'},404);
    await env.DB.prepare("DELETE FROM password_reset_tokens WHERE user_id=? OR expires_at <= datetime('now')").bind(id).run();
    const token=crypto.randomUUID().replaceAll('-','')+crypto.randomUUID().replaceAll('-','');
    await env.DB.prepare("INSERT INTO password_reset_tokens(token,user_id,expires_at,created_by_user_id) VALUES(?,?,datetime('now','+30 minutes'),?)").bind(token,id,user.id).run();
    await audit(env,user.id,'create_reset_link','user',id); return json({ok:true,resetUrl:`${new URL(request.url).origin}/#/reset-password/${token}`});
  }

  if (path === 'admin/sponsors' || path === 'team/sponsors') {
    const denied=requireAnyRole(user,'admin','team'); if(denied)return denied;
    if(method==='GET') { const q=hasRole(user,'team')?env.DB.prepare("SELECT * FROM sponsors WHERE team_id=? AND level='team' ORDER BY is_featured DESC,name").bind(user.team_id):env.DB.prepare('SELECT s.*,t.name team_name FROM sponsors s LEFT JOIN teams t ON t.id=s.team_id ORDER BY s.level,s.is_featured DESC,s.name'); return json({sponsors:(await q.all()).results}); }
    if(method==='POST') { const d=await body(request); const level=hasRole(user,'team')?'team':(d.level||'league'); const teamId=hasRole(user,'team')?user.team_id:(level==='team'?Number(d.team_id):null); const result=await env.DB.prepare('INSERT INTO sponsors(name,logo_url,website_url,level,team_id,is_featured) VALUES(?,?,?,?,?,?)').bind(d.name,d.logo_url||'',d.website_url||'',level,teamId,d.is_featured?1:0).run(); await audit(env,user.id,'create','sponsor',result.meta.last_row_id,d); return json({ok:true,id:result.meta.last_row_id},201); }
  }
  if (path === 'admin/news') {
    const denied=requireAnyRole(user,'admin'); if(denied)return denied;
    if(method==='GET') return json({news:(await env.DB.prepare('SELECT * FROM news ORDER BY created_at DESC').all()).results});
    if(method==='POST') { const d=await body(request); const result=await env.DB.prepare('INSERT INTO news(title,slug,excerpt,body,cover_url,is_published,published_at) VALUES(?,?,?,?,?,?,CASE WHEN ?=1 THEN CURRENT_TIMESTAMP ELSE NULL END)').bind(d.title,slugify(d.slug||d.title),d.excerpt||'',d.body||'',d.cover_url||'',d.is_published?1:0,d.is_published?1:0).run(); await audit(env,user.id,'create','news',result.meta.last_row_id,d); return json({ok:true,id:result.meta.last_row_id},201); }
  }
  if (path === 'admin/polls') {
    const denied=requireAnyRole(user,'admin'); if(denied)return denied;
    if(method==='GET') { const polls=(await env.DB.prepare('SELECT * FROM polls ORDER BY created_at DESC').all()).results; for(const p of polls)p.options=(await env.DB.prepare('SELECT * FROM poll_options WHERE poll_id=?').bind(p.id).all()).results; return json({polls}); }
    if(method==='POST') { const d=await body(request); const r=await env.DB.prepare('INSERT INTO polls(title,description,poll_type,starts_at,ends_at,status) VALUES(?,?,?,?,?,?)').bind(d.title,d.description||'',d.poll_type||'custom',d.starts_at,d.ends_at,d.status||'draft').run(); for(const o of (d.options||[])) if(o.label) await env.DB.prepare('INSERT INTO poll_options(poll_id,label,image_url,player_id,team_id) VALUES(?,?,?,?,?)').bind(r.meta.last_row_id,o.label,o.image_url||'',o.player_id?Number(o.player_id):null,o.team_id?Number(o.team_id):null).run(); await audit(env,user.id,'create','poll',r.meta.last_row_id,d); return json({ok:true,id:r.meta.last_row_id},201); }
  }

  return json({ error:'Endpoint non trovato', path },404);
}

export async function onRequest(context) {
  const path = context.params.path ? (Array.isArray(context.params.path) ? context.params.path.join('/') : context.params.path) : '';
  try { await ensureAuthSchema(context.env); return await route(context.request, context.env, path); }
  catch (error) { console.error(error); return json({ error:'Errore interno', detail:error.message },500); }
}
