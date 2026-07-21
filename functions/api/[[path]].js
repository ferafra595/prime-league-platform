const json = (data, status = 200, headers = {}) => new Response(JSON.stringify(data), {
  status,
  headers: { 'content-type': 'application/json; charset=utf-8', ...headers }
});

const slugify = (value = '') => value.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
const safeText = (value) => typeof value === 'string' ? value.trim() : value;

async function hashPassword(password, salt = crypto.randomUUID()) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt: new TextEncoder().encode(salt), iterations: 120000, hash: 'SHA-256' }, key, 256);
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

async function body(request) {
  try { return await request.json(); } catch { return {}; }
}

async function audit(env, userId, action, entityType = null, entityId = null, details = null) {
  await env.DB.prepare('INSERT INTO audit_log(user_id,action,entity_type,entity_id,details) VALUES(?,?,?,?,?)')
    .bind(userId || null, action, entityType, entityId ? String(entityId) : null, details ? JSON.stringify(details) : null).run();
}

async function standings(env) {
  const teams = await env.DB.prepare('SELECT id,name,slug,short_name,logo_url,primary_color FROM teams WHERE is_active=1 ORDER BY name').all();
  const matches = await env.DB.prepare("SELECT home_team_id,away_team_id,home_score,away_score FROM matches WHERE status='published'").all();
  const table = new Map(teams.results.map(t => [t.id, { ...t, played:0, won:0, drawn:0, lost:0, gf:0, ga:0, gd:0, points:0 }]));
  for (const m of matches.results) {
    const h = table.get(m.home_team_id), a = table.get(m.away_team_id); if (!h || !a) continue;
    h.played++; a.played++; h.gf += m.home_score; h.ga += m.away_score; a.gf += m.away_score; a.ga += m.home_score;
    if (m.home_score > m.away_score) { h.won++; h.points += 3; a.lost++; }
    else if (m.home_score < m.away_score) { a.won++; a.points += 3; h.lost++; }
    else { h.drawn++; a.drawn++; h.points++; a.points++; }
  }
  return [...table.values()].map(t => ({...t, gd:t.gf-t.ga})).sort((a,b) => b.points-a.points || b.gd-a.gd || b.gf-a.gf || a.name.localeCompare(b.name));
}

async function publicDashboard(env) {
  const [next, recent, top, newsRows, sponsors] = await Promise.all([
    env.DB.prepare(`SELECT m.*, ht.name home_name,ht.logo_url home_logo,at.name away_name,at.logo_url away_logo FROM matches m JOIN teams ht ON ht.id=m.home_team_id JOIN teams at ON at.id=m.away_team_id WHERE m.status='scheduled' ORDER BY m.match_date LIMIT 4`).all(),
    env.DB.prepare(`SELECT m.*, ht.name home_name,ht.logo_url home_logo,at.name away_name,at.logo_url away_logo FROM matches m JOIN teams ht ON ht.id=m.home_team_id JOIN teams at ON at.id=m.away_team_id WHERE m.status='published' ORDER BY m.match_date DESC LIMIT 4`).all(),
    env.DB.prepare(`SELECT p.id,p.first_name,p.last_name,p.slug,p.photo_url,t.name team_name,COALESCE(SUM(e.quantity),0) goals FROM players p JOIN teams t ON t.id=p.team_id LEFT JOIN match_events e ON e.player_id=p.id AND e.event_type='goal' GROUP BY p.id ORDER BY goals DESC,p.last_name LIMIT 5`).all(),
    env.DB.prepare(`SELECT id,title,slug,excerpt,cover_url,published_at FROM news WHERE is_published=1 ORDER BY published_at DESC LIMIT 3`).all(),
    env.DB.prepare(`SELECT * FROM sponsors WHERE level='league' AND is_active=1 ORDER BY is_featured DESC,name`).all()
  ]);
  return { next:next.results, recent:recent.results, topScorers:top.results, news:newsRows.results, sponsors:sponsors.results, standings:await standings(env) };
}

async function route(request, env, path) {
  const method = request.method;
  const user = await currentUser(request, env);

  if (path === 'health') return json({ ok:true, database:true, time:new Date().toISOString() });
  if (path === 'me') return json({ user });

  if (path === 'setup' && method === 'POST') {
    const data = await body(request);
    if (!env.SETUP_TOKEN || data.setupToken !== env.SETUP_TOKEN) return json({ error:'Token di configurazione non valido' }, 403);
    const existing = await env.DB.prepare("SELECT id FROM users WHERE role='admin' LIMIT 1").first();
    if (existing) return json({ error:'Amministratore già configurato' }, 409);
    if (!data.email || !data.password || data.password.length < 8) return json({ error:'Email e password di almeno 8 caratteri sono obbligatorie' }, 400);
    const hash = await hashPassword(data.password);
    await env.DB.prepare("INSERT INTO users(email,username,password_hash,role,display_name) VALUES(?,?,?,?,?)")
      .bind(data.email.toLowerCase(), safeText(data.username || 'admin'), hash, 'admin', safeText(data.displayName || 'Amministratore')).run();
    return json({ ok:true });
  }

  if (path === 'auth/login' && method === 'POST') {
    const data = await body(request);
    const found = await env.DB.prepare('SELECT * FROM users WHERE (email=? OR username=?) AND is_active=1').bind((data.login||'').toLowerCase(), data.login||'').first();
    if (!found || !(await verifyPassword(data.password || '', found.password_hash))) return json({ error:'Credenziali non valide' }, 401);
    const token = crypto.randomUUID() + crypto.randomUUID().replaceAll('-','');
    await env.DB.prepare("INSERT INTO sessions(id,user_id,expires_at) VALUES(?,?,datetime('now','+14 days'))").bind(token, found.id).run();
    await audit(env, found.id, 'login');
    return json({ ok:true, user:{id:found.id,email:found.email,role:found.role,team_id:found.team_id,display_name:found.display_name} }, 200, { 'set-cookie':cookie('pl_session',token) });
  }

  if (path === 'auth/logout' && method === 'POST') {
    const token = (request.headers.get('cookie') || '').split(';').map(v=>v.trim()).find(v=>v.startsWith('pl_session='))?.split('=')[1];
    if (token) await env.DB.prepare('DELETE FROM sessions WHERE id=?').bind(token).run();
    return json({ ok:true }, 200, { 'set-cookie':cookie('pl_session','',0) });
  }

  if (path === 'auth/register-fan' && method === 'POST') {
    const data = await body(request);
    if (!data.email || !data.password || data.password.length < 8 || !data.displayName) return json({error:'Dati non validi'},400);
    try {
      const hash = await hashPassword(data.password);
      await env.DB.prepare("INSERT INTO users(email,password_hash,role,display_name) VALUES(?,?, 'fan',?)").bind(data.email.toLowerCase(),hash,safeText(data.displayName)).run();
      return json({ok:true},201);
    } catch { return json({error:'Email già registrata'},409); }
  }

  if (path === 'public/home') return json(await publicDashboard(env));
  if (path === 'public/standings') return json({ standings:await standings(env) });
  if (path === 'public/teams') {
    const rows = await env.DB.prepare(`SELECT t.*, COUNT(DISTINCT p.id) players_count FROM teams t LEFT JOIN players p ON p.team_id=t.id AND p.is_active=1 WHERE t.is_active=1 GROUP BY t.id ORDER BY t.name`).all();
    return json({ teams:rows.results });
  }
  if (path.startsWith('public/team/')) {
    const slug = path.split('/').pop();
    const team = await env.DB.prepare('SELECT * FROM teams WHERE slug=? AND is_active=1').bind(slug).first();
    if (!team) return json({error:'Squadra non trovata'},404);
    const [players,matches,sponsors] = await Promise.all([
      env.DB.prepare('SELECT * FROM players WHERE team_id=? AND is_active=1 ORDER BY role,shirt_number,last_name').bind(team.id).all(),
      env.DB.prepare(`SELECT m.*,ht.name home_name,at.name away_name FROM matches m JOIN teams ht ON ht.id=m.home_team_id JOIN teams at ON at.id=m.away_team_id WHERE m.home_team_id=? OR m.away_team_id=? ORDER BY m.match_date DESC`).bind(team.id,team.id).all(),
      env.DB.prepare("SELECT * FROM sponsors WHERE team_id=? AND level='team' AND is_active=1 ORDER BY is_featured DESC,name").bind(team.id).all()
    ]);
    return json({team,players:players.results,matches:matches.results,sponsors:sponsors.results});
  }
  if (path === 'public/players') {
    const rows = await env.DB.prepare(`SELECT p.*,t.name team_name,t.slug team_slug,t.logo_url team_logo,
      COALESCE(SUM(CASE WHEN e.event_type='goal' THEN e.quantity ELSE 0 END),0) goals,
      COALESCE(SUM(CASE WHEN e.event_type='yellow' THEN e.quantity ELSE 0 END),0) yellows,
      COALESCE(SUM(CASE WHEN e.event_type='red' THEN e.quantity ELSE 0 END),0) reds,
      COUNT(DISTINCT CASE WHEN m.mvp_player_id=p.id THEN m.id END) mvps
      FROM players p JOIN teams t ON t.id=p.team_id LEFT JOIN match_events e ON e.player_id=p.id LEFT JOIN matches m ON m.mvp_player_id=p.id
      WHERE p.is_active=1 GROUP BY p.id ORDER BY p.last_name,p.first_name`).all();
    return json({players:rows.results});
  }
  if (path.startsWith('public/player/')) {
    const slug = path.split('/').pop();
    const player = await env.DB.prepare(`SELECT p.*,t.name team_name,t.slug team_slug,t.logo_url team_logo FROM players p JOIN teams t ON t.id=p.team_id WHERE p.slug=?`).bind(slug).first();
    if (!player) return json({error:'Giocatore non trovato'},404);
    const stats = await env.DB.prepare(`SELECT
      COALESCE(SUM(CASE WHEN event_type='goal' THEN quantity ELSE 0 END),0) goals,
      COALESCE(SUM(CASE WHEN event_type='yellow' THEN quantity ELSE 0 END),0) yellows,
      COALESCE(SUM(CASE WHEN event_type='red' THEN quantity ELSE 0 END),0) reds
      FROM match_events WHERE player_id=?`).bind(player.id).first();
    const assists = await env.DB.prepare("SELECT COALESCE(SUM(quantity),0) assists FROM match_events WHERE assist_player_id=? AND event_type='goal'").bind(player.id).first();
    const appearances = await env.DB.prepare('SELECT COUNT(DISTINCT match_id) appearances FROM match_events WHERE player_id=? OR assist_player_id=?').bind(player.id,player.id).first();
    const mvps = await env.DB.prepare('SELECT COUNT(*) mvps FROM matches WHERE mvp_player_id=? AND status=\'published\'').bind(player.id).first();
    return json({player,stats:{...stats,...assists,...appearances,...mvps}});
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
    const scorers = await env.DB.prepare(`SELECT p.id,p.first_name,p.last_name,p.slug,p.photo_url,t.name team_name,t.logo_url team_logo,SUM(e.quantity) value FROM match_events e JOIN players p ON p.id=e.player_id JOIN teams t ON t.id=p.team_id WHERE e.event_type='goal' GROUP BY p.id ORDER BY value DESC,p.last_name LIMIT 30`).all();
    const assists = await env.DB.prepare(`SELECT p.id,p.first_name,p.last_name,p.slug,p.photo_url,t.name team_name,t.logo_url team_logo,SUM(e.quantity) value FROM match_events e JOIN players p ON p.id=e.assist_player_id JOIN teams t ON t.id=p.team_id WHERE e.event_type='goal' AND e.assist_player_id IS NOT NULL GROUP BY p.id ORDER BY value DESC,p.last_name LIMIT 30`).all();
    const mvps = await env.DB.prepare(`SELECT p.id,p.first_name,p.last_name,p.slug,p.photo_url,t.name team_name,t.logo_url team_logo,COUNT(*) value FROM matches m JOIN players p ON p.id=m.mvp_player_id JOIN teams t ON t.id=p.team_id WHERE m.status='published' GROUP BY p.id ORDER BY value DESC,p.last_name LIMIT 30`).all();
    const yellows = await env.DB.prepare(`SELECT p.id,p.first_name,p.last_name,p.slug,p.photo_url,t.name team_name,t.logo_url team_logo,SUM(e.quantity) value FROM match_events e JOIN players p ON p.id=e.player_id JOIN teams t ON t.id=p.team_id WHERE e.event_type='yellow' GROUP BY p.id ORDER BY value DESC,p.last_name LIMIT 30`).all();
    const reds = await env.DB.prepare(`SELECT p.id,p.first_name,p.last_name,p.slug,p.photo_url,t.name team_name,t.logo_url team_logo,SUM(e.quantity) value FROM match_events e JOIN players p ON p.id=e.player_id JOIN teams t ON t.id=p.team_id WHERE e.event_type='red' GROUP BY p.id ORDER BY value DESC,p.last_name LIMIT 30`).all();
    return json({scorers:scorers.results,assists:assists.results,mvps:mvps.results,yellows:yellows.results,reds:reds.results});
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
    const denied = requireRole(user,'fan','admin','team'); if (denied) return denied;
    const data = await body(request);
    const option = await env.DB.prepare(`SELECT o.id,o.poll_id,p.status,p.starts_at,p.ends_at FROM poll_options o JOIN polls p ON p.id=o.poll_id WHERE o.id=?`).bind(data.optionId).first();
    if (!option || option.status!=='open') return json({error:'Votazione non disponibile'},400);
    try { await env.DB.prepare('INSERT INTO votes(poll_id,option_id,user_id) VALUES(?,?,?)').bind(option.poll_id,option.id,user.id).run(); }
    catch { return json({error:'Hai già votato'},409); }
    return json({ok:true});
  }

  // Dashboard data
  if (path === 'dashboard') {
    const denied = requireRole(user,'admin','team'); if (denied) return denied;
    if (user.role === 'admin') {
      const counts = {};
      for (const table of ['teams','players','matches','users','sponsors']) counts[table] = (await env.DB.prepare(`SELECT COUNT(*) c FROM ${table}`).first()).c;
      counts.pending = (await env.DB.prepare("SELECT COUNT(*) c FROM match_submissions WHERE status='pending'").first()).c;
      return json({user,counts});
    }
    const team = await env.DB.prepare('SELECT * FROM teams WHERE id=?').bind(user.team_id).first();
    const counts = {
      players:(await env.DB.prepare('SELECT COUNT(*) c FROM players WHERE team_id=? AND is_active=1').bind(user.team_id).first()).c,
      sponsors:(await env.DB.prepare("SELECT COUNT(*) c FROM sponsors WHERE team_id=? AND level='team' AND is_active=1").bind(user.team_id).first()).c,
      pending:(await env.DB.prepare("SELECT COUNT(*) c FROM match_submissions WHERE team_id=? AND status='pending'").bind(user.team_id).first()).c
    };
    return json({user,team,counts});
  }

  // Generic admin list endpoints
  if (path === 'admin/teams') {
    const denied=requireRole(user,'admin'); if(denied)return denied;
    if(method==='GET') return json({teams:(await env.DB.prepare('SELECT * FROM teams ORDER BY name').all()).results});
    if(method==='POST') { const d=await body(request); if(!d.name)return json({error:'Nome obbligatorio'},400); const result=await env.DB.prepare('INSERT INTO teams(name,slug,short_name,logo_url,primary_color,secondary_color,manager_name,coach_name,description) VALUES(?,?,?,?,?,?,?,?,?)').bind(safeText(d.name),slugify(d.slug||d.name),safeText(d.short_name||''),safeText(d.logo_url||''),d.primary_color||'#7c3cff',d.secondary_color||'#ffffff',safeText(d.manager_name||''),safeText(d.coach_name||''),safeText(d.description||'')).run(); await audit(env,user.id,'create','team',result.meta.last_row_id,d); return json({ok:true,id:result.meta.last_row_id},201); }
  }
  if (path.match(/^admin\/teams\/\d+$/)) {
    const denied=requireRole(user,'admin'); if(denied)return denied; const id=Number(path.split('/').pop()); const d=await body(request);
    if(method==='PUT') { await env.DB.prepare('UPDATE teams SET name=?,slug=?,short_name=?,logo_url=?,primary_color=?,secondary_color=?,manager_name=?,coach_name=?,description=?,is_active=?,updated_at=CURRENT_TIMESTAMP WHERE id=?').bind(d.name,slugify(d.slug||d.name),d.short_name||'',d.logo_url||'',d.primary_color||'#7c3cff',d.secondary_color||'#ffffff',d.manager_name||'',d.coach_name||'',d.description||'',d.is_active===0?0:1,id).run(); await audit(env,user.id,'update','team',id,d); return json({ok:true}); }
    if(method==='DELETE') { await env.DB.prepare('UPDATE teams SET is_active=0 WHERE id=?').bind(id).run(); await audit(env,user.id,'disable','team',id); return json({ok:true}); }
  }
  if (path === 'admin/players' || path === 'team/players') {
    const denied=requireRole(user,'admin','team'); if(denied)return denied;
    const teamFilter=user.role==='team'?user.team_id:null;
    if(method==='GET') { const q=teamFilter?env.DB.prepare('SELECT p.*,t.name team_name FROM players p JOIN teams t ON t.id=p.team_id WHERE p.team_id=? ORDER BY p.last_name').bind(teamFilter):env.DB.prepare('SELECT p.*,t.name team_name FROM players p JOIN teams t ON t.id=p.team_id ORDER BY t.name,p.last_name'); return json({players:(await q.all()).results}); }
    if(method==='POST') { const d=await body(request); const teamId=teamFilter||Number(d.team_id); if(!teamId||!d.first_name||!d.last_name||!d.role)return json({error:'Dati obbligatori mancanti'},400); const result=await env.DB.prepare('INSERT INTO players(team_id,first_name,last_name,slug,shirt_number,role,photo_url) VALUES(?,?,?,?,?,?,?)').bind(teamId,safeText(d.first_name),safeText(d.last_name),slugify(d.slug||`${d.first_name}-${d.last_name}-${crypto.randomUUID().slice(0,5)}`),d.shirt_number?Number(d.shirt_number):null,d.role,d.photo_url||'').run(); await audit(env,user.id,'create','player',result.meta.last_row_id,d); return json({ok:true,id:result.meta.last_row_id},201); }
  }
  if (path.match(/^(admin|team)\/players\/\d+$/)) {
    const denied=requireRole(user,'admin','team'); if(denied)return denied; const id=Number(path.split('/').pop()); const existing=await env.DB.prepare('SELECT * FROM players WHERE id=?').bind(id).first(); if(!existing)return json({error:'Non trovato'},404); if(user.role==='team'&&existing.team_id!==user.team_id)return json({error:'Permessi insufficienti'},403); const d=await body(request);
    if(method==='PUT') { const teamId=user.role==='team'?user.team_id:Number(d.team_id||existing.team_id); await env.DB.prepare('UPDATE players SET team_id=?,first_name=?,last_name=?,slug=?,shirt_number=?,role=?,photo_url=?,is_active=?,updated_at=CURRENT_TIMESTAMP WHERE id=?').bind(teamId,d.first_name,d.last_name,slugify(d.slug||`${d.first_name}-${d.last_name}-${id}`),d.shirt_number?Number(d.shirt_number):null,d.role,d.photo_url||'',d.is_active===0?0:1,id).run(); await audit(env,user.id,'update','player',id,d); return json({ok:true}); }
    if(method==='DELETE') { await env.DB.prepare('UPDATE players SET is_active=0 WHERE id=?').bind(id).run(); await audit(env,user.id,'disable','player',id); return json({ok:true}); }
  }
  if (path === 'admin/matches') {
    const denied=requireRole(user,'admin'); if(denied)return denied;
    if(method==='GET') return json({matches:(await env.DB.prepare(`SELECT m.*,ht.name home_name,at.name away_name FROM matches m JOIN teams ht ON ht.id=m.home_team_id JOIN teams at ON at.id=m.away_team_id ORDER BY m.match_date DESC`).all()).results});
    if(method==='POST') { const d=await body(request); const result=await env.DB.prepare('INSERT INTO matches(season_id,round_name,home_team_id,away_team_id,match_date,venue,status) VALUES(?,?,?,?,?,?,?)').bind(Number(d.season_id||1),d.round_name||'',Number(d.home_team_id),Number(d.away_team_id),d.match_date,d.venue||'',d.status||'scheduled').run(); await audit(env,user.id,'create','match',result.meta.last_row_id,d); return json({ok:true,id:result.meta.last_row_id},201); }
  }
  if (path.match(/^admin\/matches\/\d+$/) && method==='PUT') {
    const denied=requireRole(user,'admin'); if(denied)return denied; const id=Number(path.split('/').pop()); const d=await body(request);
    await env.DB.prepare('UPDATE matches SET round_name=?,home_team_id=?,away_team_id=?,match_date=?,venue=?,status=?,home_score=?,away_score=?,highlights_url=?,mvp_player_id=?,updated_at=CURRENT_TIMESTAMP WHERE id=?').bind(d.round_name||'',Number(d.home_team_id),Number(d.away_team_id),d.match_date,d.venue||'',d.status||'scheduled',d.home_score===''?null:Number(d.home_score),d.away_score===''?null:Number(d.away_score),d.highlights_url||'',d.mvp_player_id?Number(d.mvp_player_id):null,id).run();
    if(Array.isArray(d.events)) { await env.DB.prepare('DELETE FROM match_events WHERE match_id=?').bind(id).run(); for(const e of d.events) await env.DB.prepare('INSERT INTO match_events(match_id,team_id,player_id,assist_player_id,event_type,quantity) VALUES(?,?,?,?,?,?)').bind(id,Number(e.team_id),e.player_id?Number(e.player_id):null,e.assist_player_id?Number(e.assist_player_id):null,e.event_type,Number(e.quantity||1)).run(); }
    await audit(env,user.id,'update','match',id,d); return json({ok:true});
  }
  if (path === 'team/matches') {
    const denied=requireRole(user,'team'); if(denied)return denied;
    const rows=await env.DB.prepare(`SELECT m.*,ht.name home_name,at.name away_name FROM matches m JOIN teams ht ON ht.id=m.home_team_id JOIN teams at ON at.id=m.away_team_id WHERE m.home_team_id=? OR m.away_team_id=? ORDER BY m.match_date DESC`).bind(user.team_id,user.team_id).all(); return json({matches:rows.results});
  }
  if (path === 'team/submissions' && method==='POST') {
    const denied=requireRole(user,'team'); if(denied)return denied; const d=await body(request); const match=await env.DB.prepare('SELECT * FROM matches WHERE id=? AND (home_team_id=? OR away_team_id=?)').bind(Number(d.match_id),user.team_id,user.team_id).first(); if(!match)return json({error:'Partita non valida'},400);
    const result=await env.DB.prepare('INSERT INTO match_submissions(match_id,submitted_by_user_id,team_id,home_score,away_score,events_json,notes) VALUES(?,?,?,?,?,?,?)').bind(match.id,user.id,user.team_id,Number(d.home_score),Number(d.away_score),JSON.stringify(d.events||[]),d.notes||'').run(); await audit(env,user.id,'submit','match_submission',result.meta.last_row_id,d); return json({ok:true},201);
  }
  if (path === 'admin/submissions') {
    const denied=requireRole(user,'admin'); if(denied)return denied; const rows=await env.DB.prepare(`SELECT s.*,t.name team_name,m.round_name,ht.name home_name,at.name away_name,u.display_name submitted_by FROM match_submissions s JOIN teams t ON t.id=s.team_id JOIN users u ON u.id=s.submitted_by_user_id JOIN matches m ON m.id=s.match_id JOIN teams ht ON ht.id=m.home_team_id JOIN teams at ON at.id=m.away_team_id ORDER BY CASE s.status WHEN 'pending' THEN 0 ELSE 1 END,s.created_at DESC`).all(); return json({submissions:rows.results});
  }
  if (path.match(/^admin\/submissions\/\d+\/(approve|reject)$/) && method==='POST') {
    const denied=requireRole(user,'admin'); if(denied)return denied; const parts=path.split('/'); const id=Number(parts[2]); const action=parts[3]; const d=await body(request); const s=await env.DB.prepare('SELECT * FROM match_submissions WHERE id=?').bind(id).first(); if(!s)return json({error:'Invio non trovato'},404);
    if(action==='approve') { await env.DB.prepare("UPDATE match_submissions SET status='approved',admin_note=?,reviewed_at=CURRENT_TIMESTAMP WHERE id=?").bind(d.admin_note||'',id).run(); await env.DB.prepare("UPDATE matches SET home_score=?,away_score=?,status='published',updated_at=CURRENT_TIMESTAMP WHERE id=?").bind(s.home_score,s.away_score,s.match_id).run(); const events=JSON.parse(s.events_json||'[]'); await env.DB.prepare('DELETE FROM match_events WHERE match_id=?').bind(s.match_id).run(); for(const e of events) await env.DB.prepare('INSERT INTO match_events(match_id,team_id,player_id,assist_player_id,event_type,quantity) VALUES(?,?,?,?,?,?)').bind(s.match_id,Number(e.team_id),e.player_id?Number(e.player_id):null,e.assist_player_id?Number(e.assist_player_id):null,e.event_type,Number(e.quantity||1)).run(); }
    else await env.DB.prepare("UPDATE match_submissions SET status='rejected',admin_note=?,reviewed_at=CURRENT_TIMESTAMP WHERE id=?").bind(d.admin_note||'',id).run(); await audit(env,user.id,action,'match_submission',id,d); return json({ok:true});
  }
  if (path === 'admin/users') {
    const denied=requireRole(user,'admin'); if(denied)return denied;
    if(method==='GET') return json({users:(await env.DB.prepare('SELECT id,email,username,role,team_id,display_name,is_active,created_at FROM users ORDER BY role,display_name').all()).results});
    if(method==='POST') { const d=await body(request); if(!d.email||!d.password||!d.display_name)return json({error:'Dati obbligatori mancanti'},400); const hash=await hashPassword(d.password); const result=await env.DB.prepare('INSERT INTO users(email,username,password_hash,role,team_id,display_name) VALUES(?,?,?,?,?,?)').bind(d.email.toLowerCase(),d.username||null,hash,d.role||'team',d.team_id?Number(d.team_id):null,d.display_name).run(); await audit(env,user.id,'create','user',result.meta.last_row_id,d); return json({ok:true,id:result.meta.last_row_id},201); }
  }
  if (path === 'admin/sponsors' || path === 'team/sponsors') {
    const denied=requireRole(user,'admin','team'); if(denied)return denied;
    if(method==='GET') { const q=user.role==='team'?env.DB.prepare("SELECT * FROM sponsors WHERE team_id=? AND level='team' ORDER BY is_featured DESC,name").bind(user.team_id):env.DB.prepare('SELECT s.*,t.name team_name FROM sponsors s LEFT JOIN teams t ON t.id=s.team_id ORDER BY s.level,s.is_featured DESC,s.name'); return json({sponsors:(await q.all()).results}); }
    if(method==='POST') { const d=await body(request); const level=user.role==='team'?'team':(d.level||'league'); const teamId=user.role==='team'?user.team_id:(level==='team'?Number(d.team_id):null); const result=await env.DB.prepare('INSERT INTO sponsors(name,logo_url,website_url,level,team_id,is_featured) VALUES(?,?,?,?,?,?)').bind(d.name,d.logo_url||'',d.website_url||'',level,teamId,d.is_featured?1:0).run(); await audit(env,user.id,'create','sponsor',result.meta.last_row_id,d); return json({ok:true,id:result.meta.last_row_id},201); }
  }
  if (path === 'admin/news') {
    const denied=requireRole(user,'admin'); if(denied)return denied;
    if(method==='GET') return json({news:(await env.DB.prepare('SELECT * FROM news ORDER BY created_at DESC').all()).results});
    if(method==='POST') { const d=await body(request); const result=await env.DB.prepare('INSERT INTO news(title,slug,excerpt,body,cover_url,is_published,published_at) VALUES(?,?,?,?,?,?,CASE WHEN ?=1 THEN CURRENT_TIMESTAMP ELSE NULL END)').bind(d.title,slugify(d.slug||d.title),d.excerpt||'',d.body||'',d.cover_url||'',d.is_published?1:0,d.is_published?1:0).run(); await audit(env,user.id,'create','news',result.meta.last_row_id,d); return json({ok:true,id:result.meta.last_row_id},201); }
  }
  if (path === 'admin/polls') {
    const denied=requireRole(user,'admin'); if(denied)return denied;
    if(method==='GET') { const polls=(await env.DB.prepare('SELECT * FROM polls ORDER BY created_at DESC').all()).results; for(const p of polls)p.options=(await env.DB.prepare('SELECT * FROM poll_options WHERE poll_id=?').bind(p.id).all()).results; return json({polls}); }
    if(method==='POST') { const d=await body(request); const r=await env.DB.prepare('INSERT INTO polls(title,description,poll_type,starts_at,ends_at,status) VALUES(?,?,?,?,?,?)').bind(d.title,d.description||'',d.poll_type||'custom',d.starts_at,d.ends_at,d.status||'draft').run(); for(const o of (d.options||[])) if(o.label) await env.DB.prepare('INSERT INTO poll_options(poll_id,label,image_url,player_id,team_id) VALUES(?,?,?,?,?)').bind(r.meta.last_row_id,o.label,o.image_url||'',o.player_id?Number(o.player_id):null,o.team_id?Number(o.team_id):null).run(); await audit(env,user.id,'create','poll',r.meta.last_row_id,d); return json({ok:true,id:r.meta.last_row_id},201); }
  }

  return json({ error:'Endpoint non trovato', path },404);
}

export async function onRequest(context) {
  const path = context.params.path ? (Array.isArray(context.params.path) ? context.params.path.join('/') : context.params.path) : '';
  try { return await route(context.request, context.env, path); }
  catch (error) { console.error(error); return json({ error:'Errore interno', detail:error.message },500); }
}
