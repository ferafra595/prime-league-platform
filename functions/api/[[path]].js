const json = (data, status = 200, headers = {}) => new Response(JSON.stringify(data), {
  status,
  headers: { 'content-type': 'application/json; charset=utf-8', ...headers }
});

const slugify = (value = '') => value.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
const safeText = (value) => typeof value === 'string' ? value.trim() : value;




const MEDIA_TYPES = new Set(['image/jpeg','image/png','image/webp']);
const MEDIA_CATEGORIES = new Set(['players','teams','sponsors','news','other']);

function mediaKeyFromUrl(value='') {
  const prefix='/api/media/';
  const text=String(value||'');
  const index=text.indexOf(prefix);
  if(index<0)return null;
  return decodeURIComponent(text.slice(index+prefix.length)).replace(/^\/+/,'');
}
function safeMediaName(value='image') {
  return String(value||'image').toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g,'')
    .replace(/[^a-z0-9._-]+/g,'-').replace(/^-+|-+$/g,'').slice(0,80)||'image';
}

async function ensureCalendarSchema(env) {
  await env.DB.batch([
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS match_schedule_meta (
      match_id INTEGER PRIMARY KEY,
      phase TEXT NOT NULL DEFAULT 'regular' CHECK(phase IN ('regular','playoff','semifinal','final')),
      schedule_status TEXT NOT NULL DEFAULT 'scheduled' CHECK(schedule_status IN ('scheduled','postponed','suspended','recovery','cancelled','completed')),
      manually_modified INTEGER NOT NULL DEFAULT 0,
      notes TEXT,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`),
    env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_schedule_meta_phase ON match_schedule_meta(phase)`),
    env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_schedule_meta_status ON match_schedule_meta(schedule_status)`)
  ]);
}

const pad2 = n => String(n).padStart(2,'0');
function toSqlDateTime(date) {
  return `${date.getFullYear()}-${pad2(date.getMonth()+1)}-${pad2(date.getDate())} ${pad2(date.getHours())}:${pad2(date.getMinutes())}:00`;
}
function parseLocalDate(value) {
  const [y,m,d] = String(value||'').split('-').map(Number);
  return new Date(y,m-1,d,12,0,0,0);
}
function nextAllowedDate(start, allowedDays) {
  const d = new Date(start);
  while (!allowedDays.includes(d.getDay())) d.setDate(d.getDate()+1);
  return d;
}
function roundRobin(teamIds) {
  const teams=[...teamIds];
  if(teams.length%2) teams.push(null);
  const n=teams.length, rounds=[];
  let arr=[...teams];
  for(let r=0;r<n-1;r++){
    const pairs=[];
    for(let i=0;i<n/2;i++){
      let a=arr[i], b=arr[n-1-i];
      if(a&&b){
        if(r%2===0) pairs.push([a,b]); else pairs.push([b,a]);
      }
    }
    rounds.push(pairs);
    arr=[arr[0],arr[n-1],...arr.slice(1,n-1)];
  }
  return rounds;
}
function scheduleRoundGames(roundPairs, cursor, allowedDays, times, maxPerDay) {
  const out=[];
  let day=nextAllowedDate(cursor,allowedDays), used=0;
  for(const pair of roundPairs){
    if(used>=Math.min(maxPerDay,times.length)){
      day.setDate(day.getDate()+1); day=nextAllowedDate(day,allowedDays); used=0;
    }
    const dt=new Date(day); const [hh,mm]=times[used].split(':').map(Number); dt.setHours(hh,mm,0,0);
    out.push({pair,date:dt}); used++;
  }
  const next=new Date(day); next.setDate(next.getDate()+1);
  return {games:out,nextCursor:next};
}

async function ensureAuthSchema(env) {
  // Compatibility layer: the original database accepts only admin/team/fan.
  // Extended application roles are stored separately, without destructive migrations.
  // Create the authentication tables before creating indexes.
  // Existing Prime League databases may only contain the original `users` table.
  await env.DB.batch([
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS auth_roles (
      user_id INTEGER PRIMARY KEY,
      role TEXT NOT NULL CHECK(role IN ('super_admin','organizer','team_manager','referee','fan')),
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL,
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS password_reset_tokens (
      token TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL,
      expires_at TEXT NOT NULL,
      used_at TEXT,
      created_by_user_id INTEGER,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER,
      action TEXT NOT NULL,
      entity_type TEXT,
      entity_id TEXT,
      details TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS team_profile_details (
      team_id INTEGER PRIMARY KEY,
      city TEXT,
      home_venue TEXT,
      phone TEXT,
      public_email TEXT,
      instagram_url TEXT,
      facebook_url TEXT,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`)
  ]);

  await env.DB.batch([
    env.DB.prepare('CREATE INDEX IF NOT EXISTS idx_password_reset_user ON password_reset_tokens(user_id)'),
    env.DB.prepare('CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id)'),
    env.DB.prepare('CREATE INDEX IF NOT EXISTS idx_auth_roles_role ON auth_roles(role)')
  ]);
}

function storageRole(role) {
  if (role === 'team_manager') return 'team';
  if (role === 'fan') return 'fan';
  return 'admin';
}

async function setExtendedRole(env, userId, role) {
  await env.DB.prepare(`INSERT INTO auth_roles(user_id,role,updated_at)
    VALUES(?,?,CURRENT_TIMESTAMP)
    ON CONFLICT(user_id) DO UPDATE SET role=excluded.role,updated_at=CURRENT_TIMESTAMP`)
    .bind(userId, role).run();
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
  return env.DB.prepare(`SELECT u.id,u.email,u.username,COALESCE(ar.role,u.role) role,u.team_id,u.display_name,u.avatar_url
    FROM sessions s JOIN users u ON u.id=s.user_id LEFT JOIN auth_roles ar ON ar.user_id=u.id
    WHERE s.id=? AND s.expires_at > datetime('now') AND u.is_active=1`).bind(token).first();
}

function requireRole(user, ...roles) {
  if (!user) return json({ error: 'Accesso richiesto' }, 401);
  if (!roles.includes(user.role)) return json({ error: 'Permessi insufficienti' }, 403);
  return null;
}

const ROLE_ALIASES = {
  admin: 'super_admin',
  team: 'team_manager'
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
  await env.DB.prepare('INSERT INTO audit_log(user_id,action,entity_type,entity_id,details) VALUES(?,?,?,?,?)')
    .bind(userId || null, action, entityType, entityId ? String(entityId) : null, details ? JSON.stringify(details) : null).run();
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


  if (path.startsWith('media/') && method==='GET') {
    if(!env.MEDIA) return json({error:'Archivio media non configurato'},503);
    const key=decodeURIComponent(path.slice('media/'.length));
    if(!key || key.includes('..')) return json({error:'File non valido'},400);
    const object=await env.MEDIA.get(key);
    if(!object) return new Response('File non trovato',{status:404});
    const headers=new Headers();
    object.writeHttpMetadata(headers);
    headers.set('etag',object.httpEtag);
    headers.set('cache-control','public, max-age=31536000, immutable');
    headers.set('x-content-type-options','nosniff');
    return new Response(object.body,{headers});
  }

  if (path === 'admin/media/upload' && method==='POST') {
    const denied=requireAnyRole(user,'super_admin','organizer'); if(denied)return denied;
    if(!env.MEDIA) return json({error:'Binding R2 MEDIA non disponibile'},503);
    let form;
    try { form=await request.formData(); } catch { return json({error:'Caricamento non valido'},400); }
    const file=form.get('file');
    const category=String(form.get('category')||'other');
    const oldUrl=String(form.get('old_url')||'');
    if(!(file instanceof File)) return json({error:'Seleziona un file'},400);
    if(!MEDIA_CATEGORIES.has(category)) return json({error:'Categoria non valida'},400);
    if(!MEDIA_TYPES.has(file.type)) return json({error:'Sono ammessi solo PNG, JPG e WEBP'},400);
    if(file.size<=0 || file.size>5*1024*1024) return json({error:'Il file deve pesare al massimo 5 MB'},400);

    const ext=file.type==='image/png'?'png':file.type==='image/webp'?'webp':'jpg';
    const base=safeMediaName(file.name.replace(/\.[^.]+$/,''));
    const key=`${category}/${Date.now()}-${crypto.randomUUID().slice(0,8)}-${base}.${ext}`;
    await env.MEDIA.put(key,file.stream(),{
      httpMetadata:{contentType:file.type,cacheControl:'public, max-age=31536000, immutable'},
      customMetadata:{uploadedBy:String(user.id),originalName:file.name}
    });

    const oldKey=mediaKeyFromUrl(oldUrl);
    if(oldKey && oldKey!==key) {
      try { await env.MEDIA.delete(oldKey); } catch {}
    }
    await audit(env,user.id,'upload','media',key,{category,size:file.size,type:file.type});
    return json({ok:true,key,url:`/api/media/${encodeURIComponent(key).replaceAll('%2F','/')}`,size:file.size,type:file.type},201);
  }

  if (path === 'admin/media' && method==='GET') {
    const denied=requireAnyRole(user,'super_admin','organizer'); if(denied)return denied;
    if(!env.MEDIA) return json({error:'Binding R2 MEDIA non disponibile'},503);
    const category=new URL(request.url).searchParams.get('category')||'';
    const prefix=MEDIA_CATEGORIES.has(category)?`${category}/`:undefined;
    const listed=await env.MEDIA.list({prefix,limit:500});
    return json({objects:listed.objects.map(o=>({
      key:o.key,url:`/api/media/${encodeURIComponent(o.key).replaceAll('%2F','/')}`,
      size:o.size,uploaded:o.uploaded,etag:o.etag,
      category:o.key.split('/')[0]||'other'
    }))});
  }

  if (path === 'admin/media/delete' && method==='POST') {
    const denied=requireAnyRole(user,'super_admin','organizer'); if(denied)return denied;
    if(!env.MEDIA) return json({error:'Binding R2 MEDIA non disponibile'},503);
    const d=await body(request);
    const key=String(d.key||mediaKeyFromUrl(d.url)||'');
    if(!key || key.includes('..')) return json({error:'File non valido'},400);
    await env.MEDIA.delete(key);
    await audit(env,user.id,'delete','media',key,{});
    return json({ok:true});
  }

  if (path === 'health') return json({ ok:true, database:true, time:new Date().toISOString() });
  if (path === 'me') return json({ user: publicUser(user) });

  if (path === 'setup' && method === 'POST') {
    const data = await body(request);
    if (!env.SETUP_TOKEN || data.setupToken !== env.SETUP_TOKEN) return json({ error:'Token di configurazione non valido' }, 403);
    const existing = await env.DB.prepare("SELECT u.id FROM users u LEFT JOIN auth_roles ar ON ar.user_id=u.id WHERE COALESCE(ar.role,u.role) IN ('admin','super_admin') LIMIT 1").first();
    if (existing) return json({ error:'Amministratore già configurato' }, 409);
    if (!data.email || !data.password || data.password.length < 8) return json({ error:'Email e password di almeno 8 caratteri sono obbligatorie' }, 400);
    const hash = await hashPassword(data.password);
    const created = await env.DB.prepare("INSERT INTO users(email,username,password_hash,role,display_name) VALUES(?,?,?,?,?)")
      .bind(data.email.toLowerCase(), safeText(data.username || 'admin'), hash, 'admin', safeText(data.displayName || 'Super Admin')).run();
    await setExtendedRole(env, created.meta.last_row_id, 'super_admin');
    return json({ ok:true });
  }

  if (path === 'auth/login' && method === 'POST') {
    const data = await body(request);
    const found = await env.DB.prepare(`SELECT u.*,COALESCE(ar.role,u.role) effective_role FROM users u LEFT JOIN auth_roles ar ON ar.user_id=u.id WHERE (u.email=? OR u.username=?) AND u.is_active=1`).bind((data.login||'').toLowerCase(), data.login||'').first();
    if (!found || !(await verifyPassword(data.password || '', found.password_hash))) return json({ error:'Credenziali non valide' }, 401);
    await env.DB.prepare("DELETE FROM sessions WHERE expires_at <= datetime('now') OR (user_id=? AND created_at < datetime('now','-30 days'))").bind(found.id).run();
    const token = crypto.randomUUID() + crypto.randomUUID().replaceAll('-','');
    await env.DB.prepare("INSERT INTO sessions(id,user_id,expires_at) VALUES(?,?,datetime('now','+14 days'))").bind(token, found.id).run();
    await audit(env, found.id, 'login');
    return json({ ok:true, user:{id:found.id,email:found.email,role:(ROLE_ALIASES[found.effective_role||found.role]||found.effective_role||found.role),team_id:found.team_id,display_name:found.display_name} }, 200, { 'set-cookie':cookie('pl_session',token) });
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

  if (path === 'auth/register-fan' && method === 'POST') {
    const data = await body(request);
    if (!data.email || !data.password || data.password.length < 8 || !data.displayName) return json({error:'Dati non validi'},400);
    try {
      const hash = await hashPassword(data.password);
      const created = await env.DB.prepare("INSERT INTO users(email,password_hash,role,display_name) VALUES(?,?, 'fan',?)").bind(data.email.toLowerCase(),hash,safeText(data.displayName)).run();
      await setExtendedRole(env, created.meta.last_row_id, 'fan');
      return json({ok:true},201);
    } catch { return json({error:'Email già registrata'},409); }
  }

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
    const denied = requireAnyRole(user,'fan','super_admin','organizer','team_manager','referee'); if (denied) return denied;
    const data = await body(request);
    const option = await env.DB.prepare(`SELECT o.id,o.poll_id,p.status,p.starts_at,p.ends_at FROM poll_options o JOIN polls p ON p.id=o.poll_id WHERE o.id=?`).bind(data.optionId).first();
    if (!option || option.status!=='open') return json({error:'Votazione non disponibile'},400);
    try { await env.DB.prepare('INSERT INTO votes(poll_id,option_id,user_id) VALUES(?,?,?)').bind(option.poll_id,option.id,user.id).run(); }
    catch { return json({error:'Hai già votato'},409); }
    return json({ok:true});
  }

  // Dashboard data
  if (path === 'dashboard') {
    const denied = requireAnyRole(user,'super_admin','organizer','team_manager','referee'); if (denied) return denied;
    if (hasRole(user,'super_admin','organizer')) {
      const counts = {};
      for (const table of ['teams','players','matches','users','sponsors']) counts[table] = (await env.DB.prepare(`SELECT COUNT(*) c FROM ${table}`).first()).c;
      counts.pending = (await env.DB.prepare("SELECT COUNT(*) c FROM match_submissions WHERE status='pending'").first()).c;
      const currentSeason = await env.DB.prepare(`SELECT s.*,c.name competition_name FROM seasons s JOIN competitions c ON c.id=s.competition_id WHERE s.is_current=1 ORDER BY s.id DESC LIMIT 1`).first();
      const recentMatches = (await env.DB.prepare(`SELECT m.id,m.round_name,m.match_date,m.status,m.home_score,m.away_score,ht.name home_name,at.name away_name FROM matches m JOIN teams ht ON ht.id=m.home_team_id JOIN teams at ON at.id=m.away_team_id ORDER BY m.match_date DESC LIMIT 5`).all()).results;
      return json({user:publicUser(user),counts,currentSeason,recentMatches});
    }
    const team = user.team_id ? await env.DB.prepare('SELECT * FROM teams WHERE id=?').bind(user.team_id).first() : null;
    const counts = user.team_id ? {
      players:(await env.DB.prepare('SELECT COUNT(*) c FROM players WHERE team_id=? AND is_active=1').bind(user.team_id).first()).c,
      sponsors:(await env.DB.prepare("SELECT COUNT(*) c FROM sponsors WHERE team_id=? AND level='team' AND is_active=1").bind(user.team_id).first()).c,
      pending:(await env.DB.prepare("SELECT COUNT(*) c FROM match_submissions WHERE team_id=? AND status='pending'").bind(user.team_id).first()).c
    } : {players:0,sponsors:0,pending:0};
    if(hasRole(user,'team_manager')&&user.team_id){
      const nextMatch=await env.DB.prepare(`SELECT m.*,ht.name home_name,ht.logo_url home_logo,at.name away_name,at.logo_url away_logo
        FROM matches m JOIN teams ht ON ht.id=m.home_team_id JOIN teams at ON at.id=m.away_team_id
        WHERE (m.home_team_id=? OR m.away_team_id=?) AND datetime(m.match_date)>=datetime('now') AND m.status!='published'
        ORDER BY datetime(m.match_date) LIMIT 1`).bind(user.team_id,user.team_id).first();
      const lastMatch=await env.DB.prepare(`SELECT m.*,ht.name home_name,ht.logo_url home_logo,at.name away_name,at.logo_url away_logo
        FROM matches m JOIN teams ht ON ht.id=m.home_team_id JOIN teams at ON at.id=m.away_team_id
        WHERE (m.home_team_id=? OR m.away_team_id=?) AND m.status='published'
        ORDER BY datetime(m.match_date) DESC LIMIT 1`).bind(user.team_id,user.team_id).first();
      const reportTodo=(await env.DB.prepare(`SELECT COUNT(*) c FROM matches m
        WHERE (m.home_team_id=? OR m.away_team_id=?) AND datetime(m.match_date)<=datetime('now') AND m.status!='published'
        AND NOT EXISTS(SELECT 1 FROM match_submissions s WHERE s.match_id=m.id AND s.team_id=? AND s.status='pending')`).bind(user.team_id,user.team_id,user.team_id).first()).c;
      return json({user:publicUser(user),team,counts,nextMatch,lastMatch,reportTodo});
    }
    return json({user:publicUser(user),team,counts});
  }

  if (path === 'admin/seasons') {
    const denied=requireAnyRole(user,'super_admin','organizer'); if(denied)return denied;
    if(method==='GET') return json({seasons:(await env.DB.prepare(`SELECT s.*,c.name competition_name FROM seasons s JOIN competitions c ON c.id=s.competition_id ORDER BY s.is_current DESC,s.start_date DESC,s.id DESC`).all()).results});
    if(method==='POST') {
      const d=await body(request); if(!d.name)return json({error:'Nome stagione obbligatorio'},400);
      if(d.is_current) await env.DB.prepare('UPDATE seasons SET is_current=0').run();
      const r=await env.DB.prepare('INSERT INTO seasons(competition_id,name,start_date,end_date,is_current) VALUES(1,?,?,?,?)').bind(safeText(d.name),d.start_date||null,d.end_date||null,d.is_current?1:0).run();
      await audit(env,user.id,'create','season',r.meta.last_row_id,d); return json({ok:true,id:r.meta.last_row_id},201);
    }
  }
  if (path.match(/^admin\/seasons\/\d+$/) && method==='PUT') {
    const denied=requireAnyRole(user,'super_admin','organizer'); if(denied)return denied; const id=Number(path.split('/').pop()); const d=await body(request);
    if(!d.name)return json({error:'Nome stagione obbligatorio'},400);
    if(d.is_current) await env.DB.prepare('UPDATE seasons SET is_current=0').run();
    await env.DB.prepare('UPDATE seasons SET name=?,start_date=?,end_date=?,is_current=? WHERE id=?').bind(safeText(d.name),d.start_date||null,d.end_date||null,d.is_current?1:0,id).run();
    await audit(env,user.id,'update','season',id,d); return json({ok:true});
  }
  if (path.match(/^admin\/seasons\/\d+\/current$/) && method==='POST') {
    const denied=requireAnyRole(user,'super_admin','organizer'); if(denied)return denied; const id=Number(path.split('/')[2]);
    await env.DB.prepare('UPDATE seasons SET is_current=0').run(); await env.DB.prepare('UPDATE seasons SET is_current=1 WHERE id=?').bind(id).run();
    await audit(env,user.id,'set_current','season',id,{}); return json({ok:true});
  }

  if (path === 'team/profile') {
    const denied=requireAnyRole(user,'team_manager'); if(denied)return denied;
    if(!user.team_id)return json({error:'Account non collegato a una squadra'},400);
    if(method==='GET'){
      const team=await env.DB.prepare('SELECT * FROM teams WHERE id=?').bind(user.team_id).first();
      const details=await env.DB.prepare('SELECT * FROM team_profile_details WHERE team_id=?').bind(user.team_id).first();
      return json({team,details:details||{}});
    }
    if(method==='PUT'){
      const d=await body(request);
      await env.DB.prepare(`UPDATE teams SET short_name=?,logo_url=?,primary_color=?,secondary_color=?,manager_name=?,coach_name=?,description=?,updated_at=CURRENT_TIMESTAMP WHERE id=?`)
        .bind(safeText(d.short_name||''),safeText(d.logo_url||''),d.primary_color||'#07172f',d.secondary_color||'#ffffff',safeText(d.manager_name||''),safeText(d.coach_name||''),safeText(d.description||''),user.team_id).run();
      await env.DB.prepare(`INSERT INTO team_profile_details(team_id,city,home_venue,phone,public_email,instagram_url,facebook_url,updated_at)
        VALUES(?,?,?,?,?,?,?,CURRENT_TIMESTAMP)
        ON CONFLICT(team_id) DO UPDATE SET city=excluded.city,home_venue=excluded.home_venue,phone=excluded.phone,public_email=excluded.public_email,instagram_url=excluded.instagram_url,facebook_url=excluded.facebook_url,updated_at=CURRENT_TIMESTAMP`)
        .bind(user.team_id,safeText(d.city||''),safeText(d.home_venue||''),safeText(d.phone||''),safeText(d.public_email||''),safeText(d.instagram_url||''),safeText(d.facebook_url||'')).run();
      await audit(env,user.id,'update','team_profile',user.team_id,d);return json({ok:true});
    }
  }

  // Generic admin list endpoints
  if (path === 'admin/teams') {
    const denied=requireAnyRole(user,'super_admin','organizer'); if(denied)return denied;
    if(method==='GET') return json({teams:(await env.DB.prepare('SELECT * FROM teams ORDER BY name').all()).results});
    if(method==='POST') { const d=await body(request); if(!d.name)return json({error:'Nome obbligatorio'},400); const result=await env.DB.prepare('INSERT INTO teams(name,slug,short_name,logo_url,primary_color,secondary_color,manager_name,coach_name,description) VALUES(?,?,?,?,?,?,?,?,?)').bind(safeText(d.name),slugify(d.slug||d.name),safeText(d.short_name||''),safeText(d.logo_url||''),d.primary_color||'#7c3cff',d.secondary_color||'#ffffff',safeText(d.manager_name||''),safeText(d.coach_name||''),safeText(d.description||'')).run(); await audit(env,user.id,'create','team',result.meta.last_row_id,d); return json({ok:true,id:result.meta.last_row_id},201); }
  }
  if (path.match(/^admin\/teams\/\d+$/)) {
    const denied=requireAnyRole(user,'super_admin','organizer'); if(denied)return denied; const id=Number(path.split('/').pop()); const d=await body(request);
    if(method==='PUT') { await env.DB.prepare('UPDATE teams SET name=?,slug=?,short_name=?,logo_url=?,primary_color=?,secondary_color=?,manager_name=?,coach_name=?,description=?,is_active=?,updated_at=CURRENT_TIMESTAMP WHERE id=?').bind(d.name,slugify(d.slug||d.name),d.short_name||'',d.logo_url||'',d.primary_color||'#7c3cff',d.secondary_color||'#ffffff',d.manager_name||'',d.coach_name||'',d.description||'',d.is_active===0?0:1,id).run(); await audit(env,user.id,'update','team',id,d); return json({ok:true}); }
    if(method==='DELETE') { await env.DB.prepare('DELETE FROM match_submissions WHERE match_id IN (SELECT id FROM matches WHERE home_team_id=? OR away_team_id=?)').bind(id,id).run(); await env.DB.prepare('DELETE FROM match_events WHERE match_id IN (SELECT id FROM matches WHERE home_team_id=? OR away_team_id=?)').bind(id,id).run(); await env.DB.prepare('DELETE FROM match_schedule_meta WHERE match_id IN (SELECT id FROM matches WHERE home_team_id=? OR away_team_id=?)').bind(id,id).run(); await env.DB.prepare('DELETE FROM matches WHERE home_team_id=? OR away_team_id=?').bind(id,id).run(); await env.DB.prepare('UPDATE users SET team_id=NULL WHERE team_id=?').bind(id).run(); await env.DB.prepare('DELETE FROM sponsors WHERE team_id=?').bind(id).run(); await env.DB.prepare('DELETE FROM players WHERE team_id=?').bind(id).run(); await env.DB.prepare('DELETE FROM teams WHERE id=?').bind(id).run(); await audit(env,user.id,'delete','team',id); return json({ok:true}); }
  }
  if (path === 'admin/players' || path === 'team/players') {
    const denied=requireAnyRole(user,'super_admin','organizer','team_manager'); if(denied)return denied;
    const teamFilter=hasRole(user,'team_manager')?user.team_id:null;
    if(method==='GET') { const q=teamFilter?env.DB.prepare('SELECT p.*,t.name team_name,t.logo_url team_logo FROM players p JOIN teams t ON t.id=p.team_id WHERE p.team_id=? ORDER BY p.last_name').bind(teamFilter):env.DB.prepare('SELECT p.*,t.name team_name,t.logo_url team_logo FROM players p JOIN teams t ON t.id=p.team_id ORDER BY t.name,p.last_name'); return json({players:(await q.all()).results}); }
    if(method==='POST') { const d=await body(request); const teamId=teamFilter||Number(d.team_id); if(!teamId||!d.first_name||!d.last_name||!d.role)return json({error:'Dati obbligatori mancanti'},400); const result=await env.DB.prepare('INSERT INTO players(team_id,first_name,last_name,slug,shirt_number,role,photo_url) VALUES(?,?,?,?,?,?,?)').bind(teamId,safeText(d.first_name),safeText(d.last_name),slugify(d.slug||`${d.first_name}-${d.last_name}-${crypto.randomUUID().slice(0,5)}`),d.shirt_number?Number(d.shirt_number):null,d.role,d.photo_url||'').run(); await audit(env,user.id,'create','player',result.meta.last_row_id,d); return json({ok:true,id:result.meta.last_row_id},201); }
  }
  if (path.match(/^(admin|team)\/players\/\d+$/)) {
    const denied=requireAnyRole(user,'super_admin','organizer','team_manager'); if(denied)return denied; const id=Number(path.split('/').pop()); const existing=await env.DB.prepare('SELECT * FROM players WHERE id=?').bind(id).first(); if(!existing)return json({error:'Non trovato'},404); if(hasRole(user,'team_manager')&&existing.team_id!==user.team_id)return json({error:'Permessi insufficienti'},403); const d=await body(request);
    if(method==='PUT') { const teamId=hasRole(user,'team_manager')?user.team_id:Number(d.team_id||existing.team_id); await env.DB.prepare('UPDATE players SET team_id=?,first_name=?,last_name=?,slug=?,shirt_number=?,role=?,photo_url=?,is_active=?,updated_at=CURRENT_TIMESTAMP WHERE id=?').bind(teamId,d.first_name,d.last_name,slugify(d.slug||`${d.first_name}-${d.last_name}-${id}`),d.shirt_number?Number(d.shirt_number):null,d.role,d.photo_url||'',d.is_active===0?0:1,id).run(); await audit(env,user.id,'update','player',id,d); return json({ok:true}); }
    if(method==='DELETE') { await env.DB.prepare('UPDATE matches SET mvp_player_id=NULL WHERE mvp_player_id=?').bind(id).run(); await env.DB.prepare('UPDATE match_events SET player_id=NULL WHERE player_id=?').bind(id).run(); await env.DB.prepare('UPDATE match_events SET assist_player_id=NULL WHERE assist_player_id=?').bind(id).run(); await env.DB.prepare('DELETE FROM players WHERE id=?').bind(id).run(); await audit(env,user.id,'delete','player',id); return json({ok:true}); }
  }

  if (path === 'admin/calendar/generate' && method==='POST') {
    const denied=requireAnyRole(user,'super_admin','organizer'); if(denied)return denied;
    const d=await body(request);
    const seasonId=Number(d.season_id); const teamIds=(d.team_ids||[]).map(Number).filter(Boolean);
    if(!seasonId || teamIds.length<2 || !d.start_date) return json({error:'Stagione, data iniziale e almeno due squadre sono obbligatorie'},400);
    const existing=(await env.DB.prepare('SELECT COUNT(*) c FROM matches WHERE season_id=?').bind(seasonId).first()).c;
    if(existing && !d.replace_existing) return json({error:'La stagione contiene già delle partite. Conferma la sostituzione completa.'},409);
    const allowedDays=(d.allowed_days||[3,4,5]).map(Number).filter(x=>x>=0&&x<=6);
    const times=(d.times||['19:00','20:00','21:00']).filter(Boolean).slice(0,3);
    const maxPerDay=Math.max(1,Math.min(3,Number(d.max_per_day||3)));
    const marketBreakDays=Math.max(0,Number(d.market_break_days||20));
    const rounds=roundRobin(teamIds); const returnRounds=rounds.map(r=>r.map(([h,a])=>[a,h]));
    const all=[];

    // Ogni giornata occupa una sola settimana di campionato.
    // Le partite vengono distribuite nei giorni scelti, poi la giornata
    // successiva parte dalla settimana seguente.
    const nextCompetitionWeek = (referenceDate) => {
      const next = new Date(referenceDate);
      const mondayOffset = (next.getDay() + 6) % 7;
      next.setDate(next.getDate() - mondayOffset + 7);
      next.setHours(12,0,0,0);
      return nextAllowedDate(next, allowedDays);
    };

    let cursor=nextAllowedDate(parseLocalDate(d.start_date),allowedDays);
    let lastFirstLegMatch=null;

    for(let i=0;i<rounds.length;i++){
      const roundStart=new Date(cursor);
      const sch=scheduleRoundGames(rounds[i],roundStart,allowedDays,times,maxPerDay);
      sch.games.forEach(g=>all.push({round_name:`${i+1}ª Giornata`,home:g.pair[0],away:g.pair[1],date:g.date,phase:'regular'}));
      lastFirstLegMatch=sch.games.length ? sch.games[sch.games.length-1].date : roundStart;
      cursor=nextCompetitionWeek(roundStart);
    }

    // Pausa mercato calcolata dall'ultima partita del girone di andata.
    const restartBase=new Date(lastFirstLegMatch || cursor);
    restartBase.setDate(restartBase.getDate()+marketBreakDays+1);
    cursor=nextAllowedDate(restartBase,allowedDays);

    for(let i=0;i<returnRounds.length;i++){
      const roundStart=new Date(cursor);
      const sch=scheduleRoundGames(returnRounds[i],roundStart,allowedDays,times,maxPerDay);
      sch.games.forEach(g=>all.push({round_name:`${rounds.length+i+1}ª Giornata`,home:g.pair[0],away:g.pair[1],date:g.date,phase:'regular'}));
      cursor=nextCompetitionWeek(roundStart);
    }
    if(d.end_date){ const end=parseLocalDate(d.end_date); if(all.some(x=>x.date>end)) return json({error:'Il periodo indicato è troppo breve per tutte le partite. Estendi la data finale o aumenta le partite per sera.'},400); }
    if(existing){
      await env.DB.prepare('DELETE FROM match_events WHERE match_id IN (SELECT id FROM matches WHERE season_id=?)').bind(seasonId).run();
      await env.DB.prepare('DELETE FROM match_submissions WHERE match_id IN (SELECT id FROM matches WHERE season_id=?)').bind(seasonId).run();
      await env.DB.prepare('DELETE FROM match_schedule_meta WHERE match_id IN (SELECT id FROM matches WHERE season_id=?)').bind(seasonId).run();
      await env.DB.prepare('DELETE FROM matches WHERE season_id=?').bind(seasonId).run();
    }
    for(const m of all){
      const r=await env.DB.prepare(`INSERT INTO matches(season_id,round_name,home_team_id,away_team_id,match_date,venue,status) VALUES(?,?,?,?,?,?, 'scheduled')`).bind(seasonId,m.round_name,m.home,m.away,toSqlDateTime(m.date),d.venue||'').run();
      await env.DB.prepare(`INSERT INTO match_schedule_meta(match_id,phase,schedule_status) VALUES(?,?, 'scheduled')`).bind(r.meta.last_row_id,m.phase).run();
    }
    await audit(env,user.id,'generate_calendar','season',seasonId,{matches:all.length,teams:teamIds.length,marketBreakDays});
    return json({ok:true,matches_created:all.length,first_match:all[0]?toSqlDateTime(all[0].date):null,last_match:all.at(-1)?toSqlDateTime(all.at(-1).date):null});
  }

  if (path === 'admin/calendar/delete' && method==='POST') {
    const denied=requireAnyRole(user,'super_admin','organizer'); if(denied)return denied;
    const d=await body(request); const seasonId=Number(d.season_id);
    if(d.confirmation!=='ELIMINA') return json({error:'Scrivi ELIMINA per confermare'},400);
    if(!seasonId) return json({error:'Stagione non valida'},400);
    await env.DB.prepare('DELETE FROM match_events WHERE match_id IN (SELECT id FROM matches WHERE season_id=?)').bind(seasonId).run();
    await env.DB.prepare('DELETE FROM match_submissions WHERE match_id IN (SELECT id FROM matches WHERE season_id=?)').bind(seasonId).run();
    await env.DB.prepare('DELETE FROM match_schedule_meta WHERE match_id IN (SELECT id FROM matches WHERE season_id=?)').bind(seasonId).run();
    const r=await env.DB.prepare('DELETE FROM matches WHERE season_id=?').bind(seasonId).run();
    await audit(env,user.id,'delete_calendar','season',seasonId,{deleted:r.meta.changes});
    return json({ok:true,deleted:r.meta.changes||0});
  }

  if (path === 'admin/calendar/finals' && method==='POST') {
    const denied=requireAnyRole(user,'super_admin','organizer'); if(denied)return denied;
    const d=await body(request); const seasonId=Number(d.season_id);
    const phase=['playoff','semifinal','final'].includes(d.phase)?d.phase:'playoff';
    if(!seasonId||!d.home_team_id||!d.away_team_id||!d.match_date) return json({error:'Completa tutti i dati della partita'},400);
    const label=d.round_name||({playoff:'Playoff',semifinal:'Semifinale',final:'Finale'}[phase]);
    const r=await env.DB.prepare(`INSERT INTO matches(season_id,round_name,home_team_id,away_team_id,match_date,venue,status) VALUES(?,?,?,?,?,?, 'scheduled')`).bind(seasonId,label,Number(d.home_team_id),Number(d.away_team_id),d.match_date,d.venue||'').run();
    await env.DB.prepare(`INSERT INTO match_schedule_meta(match_id,phase,schedule_status,notes) VALUES(?,?, 'scheduled',?)`).bind(r.meta.last_row_id,phase,d.notes||'').run();
    await audit(env,user.id,'create_final_phase_match','match',r.meta.last_row_id,d); return json({ok:true,id:r.meta.last_row_id},201);
  }

  if (path === 'admin/matches') {
    const denied=requireAnyRole(user,'super_admin','organizer'); if(denied)return denied;
    if(method==='GET') return json({matches:(await env.DB.prepare(`SELECT m.*,ht.name home_name,at.name away_name,COALESCE(msm.phase,'regular') phase,COALESCE(msm.schedule_status,CASE WHEN m.status='published' THEN 'completed' WHEN m.status='postponed' THEN 'postponed' ELSE 'scheduled' END) schedule_status,COALESCE(msm.manually_modified,0) manually_modified,msm.notes schedule_notes FROM matches m JOIN teams ht ON ht.id=m.home_team_id JOIN teams at ON at.id=m.away_team_id LEFT JOIN match_schedule_meta msm ON msm.match_id=m.id ORDER BY m.match_date DESC`).all()).results,seasons:(await env.DB.prepare('SELECT * FROM seasons ORDER BY is_current DESC,start_date DESC,id DESC').all()).results});
    if(method==='POST') { const d=await body(request); const result=await env.DB.prepare('INSERT INTO matches(season_id,round_name,home_team_id,away_team_id,match_date,venue,status) VALUES(?,?,?,?,?,?,?)').bind(Number(d.season_id||1),d.round_name||'',Number(d.home_team_id),Number(d.away_team_id),d.match_date,d.venue||'',d.status||'scheduled').run(); await audit(env,user.id,'create','match',result.meta.last_row_id,d); return json({ok:true,id:result.meta.last_row_id},201); }
  }
  if (path.match(/^admin\/matches\/\d+$/) && method==='PUT') {
    const denied=requireAnyRole(user,'super_admin','organizer'); if(denied)return denied; const id=Number(path.split('/').pop()); const d=await body(request);
    await env.DB.prepare('UPDATE matches SET round_name=?,home_team_id=?,away_team_id=?,match_date=?,venue=?,status=?,home_score=?,away_score=?,highlights_url=?,mvp_player_id=?,updated_at=CURRENT_TIMESTAMP WHERE id=?').bind(d.round_name||'',Number(d.home_team_id),Number(d.away_team_id),d.match_date,d.venue||'',d.status||'scheduled',d.home_score===''?null:Number(d.home_score),d.away_score===''?null:Number(d.away_score),d.highlights_url||'',d.mvp_player_id?Number(d.mvp_player_id):null,id).run();
    const scheduleStatus=['scheduled','postponed','suspended','recovery','cancelled','completed'].includes(d.schedule_status)?d.schedule_status:(d.status==='published'?'completed':d.status==='postponed'?'postponed':'scheduled');
    const phase=['regular','playoff','semifinal','final'].includes(d.phase)?d.phase:'regular';
    await env.DB.prepare(`INSERT INTO match_schedule_meta(match_id,phase,schedule_status,manually_modified,notes,updated_at) VALUES(?,?,?,1,?,CURRENT_TIMESTAMP) ON CONFLICT(match_id) DO UPDATE SET phase=excluded.phase,schedule_status=excluded.schedule_status,manually_modified=1,notes=excluded.notes,updated_at=CURRENT_TIMESTAMP`).bind(id,phase,scheduleStatus,d.schedule_notes||'').run();
    if(Array.isArray(d.events)) { await env.DB.prepare('DELETE FROM match_events WHERE match_id=?').bind(id).run(); for(const e of d.events) await env.DB.prepare('INSERT INTO match_events(match_id,team_id,player_id,assist_player_id,event_type,quantity) VALUES(?,?,?,?,?,?)').bind(id,Number(e.team_id),e.player_id?Number(e.player_id):null,e.assist_player_id?Number(e.assist_player_id):null,e.event_type,Number(e.quantity||1)).run(); }
    await audit(env,user.id,'update','match',id,d); return json({ok:true});
  }
  if (path === 'team/matches') {
    const denied=requireAnyRole(user,'team_manager','referee'); if(denied)return denied;
    const q=hasRole(user,'referee')
      ? env.DB.prepare(`SELECT m.*,ht.name home_name,ht.logo_url home_logo,at.name away_name,at.logo_url away_logo,
        (SELECT s.status FROM match_submissions s WHERE s.match_id=m.id AND s.submitted_by_user_id=? ORDER BY s.created_at DESC LIMIT 1) submission_status,
        (SELECT s.home_score FROM match_submissions s WHERE s.match_id=m.id AND s.submitted_by_user_id=? ORDER BY s.created_at DESC LIMIT 1) submission_home_score,
        (SELECT s.away_score FROM match_submissions s WHERE s.match_id=m.id AND s.submitted_by_user_id=? ORDER BY s.created_at DESC LIMIT 1) submission_away_score,
        (SELECT s.events_json FROM match_submissions s WHERE s.match_id=m.id AND s.submitted_by_user_id=? ORDER BY s.created_at DESC LIMIT 1) submission_events_json,
        (SELECT s.admin_note FROM match_submissions s WHERE s.match_id=m.id AND s.submitted_by_user_id=? ORDER BY s.created_at DESC LIMIT 1) admin_note
        FROM matches m JOIN teams ht ON ht.id=m.home_team_id JOIN teams at ON at.id=m.away_team_id ORDER BY m.match_date DESC`).bind(user.id,user.id,user.id,user.id,user.id)
      : env.DB.prepare(`SELECT m.*,ht.name home_name,ht.logo_url home_logo,at.name away_name,at.logo_url away_logo,
        (SELECT s.status FROM match_submissions s WHERE s.match_id=m.id AND s.team_id=? ORDER BY s.created_at DESC LIMIT 1) submission_status,
        (SELECT s.home_score FROM match_submissions s WHERE s.match_id=m.id AND s.team_id=? ORDER BY s.created_at DESC LIMIT 1) submission_home_score,
        (SELECT s.away_score FROM match_submissions s WHERE s.match_id=m.id AND s.team_id=? ORDER BY s.created_at DESC LIMIT 1) submission_away_score,
        (SELECT s.events_json FROM match_submissions s WHERE s.match_id=m.id AND s.team_id=? ORDER BY s.created_at DESC LIMIT 1) submission_events_json,
        (SELECT s.notes FROM match_submissions s WHERE s.match_id=m.id AND s.team_id=? ORDER BY s.created_at DESC LIMIT 1) submission_notes,
        (SELECT s.admin_note FROM match_submissions s WHERE s.match_id=m.id AND s.team_id=? ORDER BY s.created_at DESC LIMIT 1) admin_note
        FROM matches m JOIN teams ht ON ht.id=m.home_team_id JOIN teams at ON at.id=m.away_team_id
        WHERE m.home_team_id=? OR m.away_team_id=? ORDER BY m.match_date DESC`)
        .bind(user.team_id,user.team_id,user.team_id,user.team_id,user.team_id,user.team_id,user.team_id,user.team_id);
    const rows=await q.all(); return json({matches:rows.results});
  }
  if (path.match(/^referee\/matches\/\d+\/report-data$/) && method==='GET') {
    const denied=requireAnyRole(user,'referee'); if(denied)return denied;
    const id=Number(path.split('/')[2]);
    const match=await env.DB.prepare('SELECT * FROM matches WHERE id=?').bind(id).first();
    if(!match)return json({error:'Partita non trovata'},404);
    const players=await env.DB.prepare(`SELECT id,team_id,first_name,last_name,shirt_number,role FROM players WHERE team_id IN (?,?) AND is_active=1 ORDER BY team_id,last_name`).bind(match.home_team_id,match.away_team_id).all();
    return json({match,players:players.results});
  }

  if (path === 'team/submissions' && method==='POST') {
    const denied=requireAnyRole(user,'team_manager','referee'); if(denied)return denied; const d=await body(request);
    const match=hasRole(user,'referee')
      ? await env.DB.prepare('SELECT * FROM matches WHERE id=?').bind(Number(d.match_id)).first()
      : await env.DB.prepare('SELECT * FROM matches WHERE id=? AND (home_team_id=? OR away_team_id=?)').bind(Number(d.match_id),user.team_id,user.team_id).first();
    if(!match)return json({error:'Partita non valida'},400);
    const submissionTeamId=hasRole(user,'referee')?match.home_team_id:user.team_id;
    await env.DB.prepare("UPDATE match_submissions SET status='superseded' WHERE match_id=? AND submitted_by_user_id=? AND status IN ('pending','rejected')").bind(match.id,user.id).run();
    const notesPayload=JSON.stringify({text:d.notes||'',mvp_player_id:d.mvp_player_id?Number(d.mvp_player_id):null});
    const result=await env.DB.prepare('INSERT INTO match_submissions(match_id,submitted_by_user_id,team_id,home_score,away_score,events_json,notes) VALUES(?,?,?,?,?,?,?)').bind(match.id,user.id,submissionTeamId,Number(d.home_score),Number(d.away_score),JSON.stringify(d.events||[]),notesPayload).run();
    await audit(env,user.id,'submit','match_submission',result.meta.last_row_id,d); return json({ok:true,id:result.meta.last_row_id},201);
  }


  if (path === 'admin/dashboard' && method==='GET') {
    const denied=requireAnyRole(user,'super_admin','organizer'); if(denied)return denied;

    const season=await env.DB.prepare("SELECT * FROM seasons WHERE is_current=1 ORDER BY id DESC LIMIT 1").first();
    const seasonFilter=season?' AND m.season_id=?':'';
    const bindSeason=season?[season.id]:[];

    const teamStats=await env.DB.prepare(`SELECT COUNT(*) total_teams,
      COALESCE(SUM(CASE WHEN is_active=1 THEN 1 ELSE 0 END),0) active_teams,
      COALESCE(SUM(CASE WHEN logo_url IS NULL OR TRIM(logo_url)='' THEN 1 ELSE 0 END),0) teams_without_logo,
      COALESCE(SUM(CASE WHEN coach_name IS NULL OR TRIM(coach_name)='' THEN 1 ELSE 0 END),0) teams_without_coach
      FROM teams`).first();

    const playerStats=await env.DB.prepare(`SELECT COUNT(*) total_players,
      COALESCE(SUM(CASE WHEN is_active=1 THEN 1 ELSE 0 END),0) active_players,
      COALESCE(SUM(CASE WHEN photo_url IS NULL OR TRIM(photo_url)='' THEN 1 ELSE 0 END),0) players_without_photo
      FROM players`).first();

    const matchStats=await env.DB.prepare(`SELECT
      COALESCE(SUM(CASE WHEN status='published' THEN 1 ELSE 0 END),0) played_matches,
      COALESCE(SUM(CASE WHEN status!='published' AND datetime(match_date)>datetime('now') THEN 1 ELSE 0 END),0) upcoming_matches,
      COALESCE(SUM(CASE WHEN status!='published' AND datetime(match_date)<=datetime('now') THEN 1 ELSE 0 END),0) missing_reports,
      COALESCE(SUM(CASE WHEN venue IS NULL OR TRIM(venue)='' THEN 1 ELSE 0 END),0) matches_without_venue
      FROM matches m WHERE 1=1 ${seasonFilter}`).bind(...bindSeason).first();

    const pendingCount=await env.DB.prepare("SELECT COUNT(*) count FROM match_submissions WHERE status='pending'").first();

    const upcoming=await env.DB.prepare(`SELECT m.id,m.round_name,m.match_date,m.venue,
      ht.name home_name,ht.logo_url home_logo,at.name away_name,at.logo_url away_logo
      FROM matches m JOIN teams ht ON ht.id=m.home_team_id JOIN teams at ON at.id=m.away_team_id
      WHERE m.status!='published' AND datetime(m.match_date)>=datetime('now') ${seasonFilter}
      ORDER BY datetime(m.match_date),m.id LIMIT 5`).bind(...bindSeason).all();

    const recent=await env.DB.prepare(`SELECT m.id,m.round_name,m.match_date,m.venue,m.home_score,m.away_score,
      ht.name home_name,ht.logo_url home_logo,at.name away_name,at.logo_url away_logo
      FROM matches m JOIN teams ht ON ht.id=m.home_team_id JOIN teams at ON at.id=m.away_team_id
      WHERE m.status='published' ${seasonFilter}
      ORDER BY datetime(m.match_date) DESC,m.id DESC LIMIT 4`).bind(...bindSeason).all();

    const pendingReports=await env.DB.prepare(`SELECT m.id,m.round_name,m.match_date,ht.name home_name,at.name away_name,
      CASE WHEN EXISTS(SELECT 1 FROM match_submissions ps WHERE ps.match_id=m.id AND ps.status='pending')
      THEN 'pending_submission' ELSE 'missing_result' END reason
      FROM matches m JOIN teams ht ON ht.id=m.home_team_id JOIN teams at ON at.id=m.away_team_id
      WHERE ((m.status!='published' AND datetime(m.match_date)<=datetime('now'))
      OR EXISTS(SELECT 1 FROM match_submissions ps WHERE ps.match_id=m.id AND ps.status='pending')) ${seasonFilter}
      ORDER BY datetime(m.match_date) DESC LIMIT 6`).bind(...bindSeason).all();

    return json({
      season,
      stats:{
        total_teams:Number(teamStats?.total_teams||0),
        active_teams:Number(teamStats?.active_teams||0),
        total_players:Number(playerStats?.total_players||0),
        active_players:Number(playerStats?.active_players||0),
        played_matches:Number(matchStats?.played_matches||0),
        upcoming_matches:Number(matchStats?.upcoming_matches||0),
        missing_reports:Number(matchStats?.missing_reports||0),
        pending_submissions:Number(pendingCount?.count||0),
        current_round:upcoming.results?.[0]?.round_name||recent.results?.[0]?.round_name||''
      },
      alerts:{
        teams_without_logo:Number(teamStats?.teams_without_logo||0),
        teams_without_coach:Number(teamStats?.teams_without_coach||0),
        players_without_photo:Number(playerStats?.players_without_photo||0),
        matches_without_venue:Number(matchStats?.matches_without_venue||0),
        pending_submissions:Number(pendingCount?.count||0)
      },
      upcoming:upcoming.results||[],
      recent:recent.results||[],
      pending_reports:pendingReports.results||[]
    });
  }

  if (path === 'admin/reports' && method==='GET') {
    const denied=requireAnyRole(user,'super_admin','organizer'); if(denied)return denied;
    const seasonId=new URL(request.url).searchParams.get('season');
    const params=[];
    const seasonWhere=seasonId ? 'WHERE m.season_id=?' : '';
    if(seasonId)params.push(Number(seasonId));

    const rows=await env.DB.prepare(`SELECT
      m.id,m.season_id,m.round_name,m.match_date,m.venue,m.status,m.home_score,m.away_score,m.mvp_player_id,
      ht.id home_team_id,ht.name home_name,ht.logo_url home_logo,
      at.id away_team_id,at.name away_name,at.logo_url away_logo,
      COUNT(DISTINCT e.id) event_rows,
      COALESCE(SUM(CASE WHEN e.event_type='goal' THEN e.quantity ELSE 0 END),0) goals_count,
      COALESCE(SUM(CASE WHEN e.event_type='goal' AND e.assist_player_id IS NOT NULL THEN e.quantity ELSE 0 END),0) assists_count,
      COALESCE(SUM(CASE WHEN e.event_type='yellow' THEN e.quantity ELSE 0 END),0) yellows_count,
      COALESCE(SUM(CASE WHEN e.event_type='red' THEN e.quantity ELSE 0 END),0) reds_count,
      (SELECT COUNT(*) FROM match_submissions ps WHERE ps.match_id=m.id AND ps.status='pending') pending_submissions,
      (SELECT ps.id FROM match_submissions ps WHERE ps.match_id=m.id AND ps.status='pending' ORDER BY ps.created_at DESC LIMIT 1) pending_submission_id,
      (SELECT ps.team_id FROM match_submissions ps WHERE ps.match_id=m.id AND ps.status='pending' ORDER BY ps.created_at DESC LIMIT 1) pending_team_id,
      (SELECT t.name FROM match_submissions ps JOIN teams t ON t.id=ps.team_id WHERE ps.match_id=m.id AND ps.status='pending' ORDER BY ps.created_at DESC LIMIT 1) pending_team_name,
      (SELECT ps.created_at FROM match_submissions ps WHERE ps.match_id=m.id AND ps.status='pending' ORDER BY ps.created_at DESC LIMIT 1) pending_created_at,
      (SELECT ps.home_score FROM match_submissions ps WHERE ps.match_id=m.id AND ps.status='pending' ORDER BY ps.created_at DESC LIMIT 1) pending_home_score,
      (SELECT ps.away_score FROM match_submissions ps WHERE ps.match_id=m.id AND ps.status='pending' ORDER BY ps.created_at DESC LIMIT 1) pending_away_score,
      (SELECT ps.events_json FROM match_submissions ps WHERE ps.match_id=m.id AND ps.status='pending' ORDER BY ps.created_at DESC LIMIT 1) pending_events_json,
      (SELECT ps.notes FROM match_submissions ps WHERE ps.match_id=m.id AND ps.status='pending' ORDER BY ps.created_at DESC LIMIT 1) pending_notes
      FROM matches m
      JOIN teams ht ON ht.id=m.home_team_id
      JOIN teams at ON at.id=m.away_team_id
      LEFT JOIN match_events e ON e.match_id=m.id
      ${seasonWhere}
      GROUP BY m.id
      ORDER BY m.match_date DESC,m.id DESC`).bind(...params).all();

    const seasons=await env.DB.prepare('SELECT id,name,is_current,start_date,end_date FROM seasons ORDER BY is_current DESC,start_date DESC,id DESC').all();
    return json({reports:rows.results,seasons:seasons.results});
  }

  if (path.match(/^admin\/reports\/\d+\/submissions$/) && method==='GET') {
    const denied=requireAnyRole(user,'super_admin','organizer'); if(denied)return denied;
    const matchId=Number(path.split('/')[2]);
    const match=await env.DB.prepare(`SELECT m.*,ht.name home_name,at.name away_name FROM matches m JOIN teams ht ON ht.id=m.home_team_id JOIN teams at ON at.id=m.away_team_id WHERE m.id=?`).bind(matchId).first();
    if(!match)return json({error:'Partita non trovata'},404);
    const rows=await env.DB.prepare(`SELECT s.*,t.name team_name,u.display_name submitted_by,COALESCE(ar.role,u.role) source_role
      FROM match_submissions s
      LEFT JOIN teams t ON t.id=s.team_id
      JOIN users u ON u.id=s.submitted_by_user_id
      LEFT JOIN auth_roles ar ON ar.user_id=u.id
      WHERE s.match_id=? ORDER BY s.created_at DESC`).bind(matchId).all();
    return json({match,submissions:rows.results.map(x=>({...x,source_role:ROLE_ALIASES[x.source_role]||x.source_role}))});
  }

  if (path === 'admin/submissions') {
    const denied=requireAnyRole(user,'super_admin','organizer'); if(denied)return denied; const rows=await env.DB.prepare(`SELECT s.*,t.name team_name,m.round_name,ht.name home_name,at.name away_name,u.display_name submitted_by FROM match_submissions s JOIN teams t ON t.id=s.team_id JOIN users u ON u.id=s.submitted_by_user_id JOIN matches m ON m.id=s.match_id JOIN teams ht ON ht.id=m.home_team_id JOIN teams at ON at.id=m.away_team_id ORDER BY CASE s.status WHEN 'pending' THEN 0 ELSE 1 END,s.created_at DESC`).all(); return json({submissions:rows.results});
  }
  if (path.match(/^admin\/submissions\/\d+\/(approve|reject)$/) && method==='POST') {
    const denied=requireAnyRole(user,'super_admin','organizer'); if(denied)return denied; const parts=path.split('/'); const id=Number(parts[2]); const action=parts[3]; const d=await body(request); const s=await env.DB.prepare('SELECT * FROM match_submissions WHERE id=?').bind(id).first(); if(!s)return json({error:'Invio non trovato'},404);
    if(action==='approve') {
      await env.DB.prepare("UPDATE match_submissions SET status='approved',admin_note=?,reviewed_at=CURRENT_TIMESTAMP WHERE id=?")
        .bind(d.admin_note||'',id).run();

      const approved=(await env.DB.prepare(`SELECT s.*,COALESCE(ar.role,u.role) source_role
        FROM match_submissions s
        JOIN users u ON u.id=s.submitted_by_user_id
        LEFT JOIN auth_roles ar ON ar.user_id=u.id
        WHERE s.match_id=? AND s.status='approved'
        ORDER BY COALESCE(s.reviewed_at,s.created_at),s.created_at,s.id`).bind(s.match_id).all()).results;

      // RESULT:
      // Never sum scores. Use the most frequently reported score.
      // If two scorelines have the same number of votes, the latest approved report wins.
      const resultVotes=new Map();
      approved.forEach((sub,index)=>{
        const key=`${Number(sub.home_score)}:${Number(sub.away_score)}`;
        const current=resultVotes.get(key)||{count:0,lastIndex:-1,home:Number(sub.home_score),away:Number(sub.away_score)};
        current.count++;
        current.lastIndex=index;
        resultVotes.set(key,current);
      });
      const officialResult=[...resultVotes.values()].sort((a,b)=>b.count-a.count||b.lastIndex-a.lastIndex)[0]||{
        home:Number(s.home_score),away:Number(s.away_score)
      };

      // MVP:
      // Use the most frequently proposed MVP. On a tie, use the latest approved proposal.
      const mvpVotes=new Map();
      approved.forEach((sub,index)=>{
        let meta={};
        try{meta=JSON.parse(sub.notes||'{}')||{}}catch{meta={}}
        const playerId=meta.mvp_player_id?Number(meta.mvp_player_id):null;
        if(!playerId)return;
        const current=mvpVotes.get(playerId)||{count:0,lastIndex:-1,playerId};
        current.count++;
        current.lastIndex=index;
        mvpVotes.set(playerId,current);
      });
      const officialMvp=[...mvpVotes.values()].sort((a,b)=>b.count-a.count||b.lastIndex-a.lastIndex)[0]?.playerId||null;

      // EVENTS:
      // Identical reports are not cumulative.
      // A unique event is identified by team + player + event type.
      // Across reports, keep the highest reported quantity, never the sum.
      const eventMap=new Map();
      for(const sub of approved){
        let events=[];
        try{events=JSON.parse(sub.events_json||'[]')||[]}catch{}
        for(const e of events){
          if(!['goal','assist','yellow','red'].includes(e.event_type))continue;
          const teamId=Number(e.team_id);
          const playerId=e.player_id?Number(e.player_id):null;
          if(!teamId||!playerId)continue;
          const key=`${teamId}:${playerId}:${e.event_type}`;
          const quantity=Math.max(1,Number(e.quantity||1));
          const previous=eventMap.get(key);
          if(!previous||quantity>previous.quantity){
            eventMap.set(key,{
              team_id:teamId,
              player_id:playerId,
              event_type:e.event_type,
              quantity
            });
          }
        }
      }

      await env.DB.prepare("UPDATE matches SET home_score=?,away_score=?,status='published',mvp_player_id=?,updated_at=CURRENT_TIMESTAMP WHERE id=?")
        .bind(officialResult.home,officialResult.away,officialMvp,s.match_id).run();

      await env.DB.prepare(`INSERT INTO match_schedule_meta(match_id,phase,schedule_status,manually_modified,notes,updated_at)
        VALUES(?,'regular','completed',1,'Referto approvato',CURRENT_TIMESTAMP)
        ON CONFLICT(match_id) DO UPDATE SET schedule_status='completed',manually_modified=1,updated_at=CURRENT_TIMESTAMP`)
        .bind(s.match_id).run();

      await env.DB.prepare('DELETE FROM match_events WHERE match_id=?').bind(s.match_id).run();

      const officialEvents=[...eventMap.values()];
      const teamIds=[...new Set(officialEvents.map(e=>e.team_id))];

      for(const teamId of teamIds){
        // Goals and assists are stored using the existing DB structure:
        // assist_player_id belongs to a goal row.
        const goalUnits=[];
        officialEvents
          .filter(e=>e.event_type==='goal'&&e.team_id===teamId)
          .forEach(e=>{
            for(let n=0;n<e.quantity;n++){
              goalUnits.push({
                team_id:teamId,
                player_id:e.player_id,
                assist_player_id:null
              });
            }
          });

        const assistUnits=[];
        officialEvents
          .filter(e=>e.event_type==='assist'&&e.team_id===teamId)
          .forEach(e=>{
            for(let n=0;n<e.quantity;n++)assistUnits.push(e.player_id);
          });

        // Pair assists with goals without duplicating them.
        assistUnits.slice(0,goalUnits.length).forEach((playerId,index)=>{
          goalUnits[index].assist_player_id=playerId;
        });

        for(const goal of goalUnits){
          await env.DB.prepare(`INSERT INTO match_events
            (match_id,team_id,player_id,assist_player_id,event_type,quantity)
            VALUES(?,?,?,?, 'goal',1)`)
            .bind(s.match_id,goal.team_id,goal.player_id,goal.assist_player_id).run();
        }

        for(const e of officialEvents.filter(e=>['yellow','red'].includes(e.event_type)&&e.team_id===teamId)){
          await env.DB.prepare(`INSERT INTO match_events
            (match_id,team_id,player_id,assist_player_id,event_type,quantity)
            VALUES(?,?,?,?,?,?)`)
            .bind(s.match_id,e.team_id,e.player_id,null,e.event_type,e.quantity).run();
        }
      }
    }
    else await env.DB.prepare("UPDATE match_submissions SET status='rejected',admin_note=?,reviewed_at=CURRENT_TIMESTAMP WHERE id=?").bind(d.admin_note||'',id).run(); await audit(env,user.id,action,'match_submission',id,d); return json({ok:true});
  }
  if (path === 'admin/users') {
    const denied=requireAnyRole(user,'super_admin','organizer'); if(denied)return denied;
    if(method==='GET') { const rows=(await env.DB.prepare(`SELECT u.id,u.email,u.username,COALESCE(ar.role,u.role) role,u.team_id,u.display_name,u.is_active,u.created_at,
      (SELECT MAX(a.created_at) FROM audit_log a WHERE a.user_id=u.id AND a.action='login') last_login
      FROM users u LEFT JOIN auth_roles ar ON ar.user_id=u.id ORDER BY role,display_name`).all()).results.map(u=>({...u,role:ROLE_ALIASES[u.role]||u.role})); return json({users:rows}); }
    if(method==='POST') {
      const d=await body(request);
      if(!d.email||!d.password||d.password.length<10||!d.display_name)return json({error:'Nome, email e password di almeno 10 caratteri sono obbligatori'},400);
      const role=['organizer','team_manager','referee'].includes(d.role)?d.role:'team_manager';
      if(role==='team_manager'&&!d.team_id)return json({error:'Per un account Squadra devi selezionare una squadra'},400);
      const duplicate=await env.DB.prepare('SELECT id FROM users WHERE lower(email)=lower(?) OR (? IS NOT NULL AND username=?) LIMIT 1').bind(d.email,d.username||null,d.username||null).first();
      if(duplicate)return json({error:'Email o username già utilizzati'},409);
      const hash=await hashPassword(d.password);
      const result=await env.DB.prepare('INSERT INTO users(email,username,password_hash,role,team_id,display_name) VALUES(?,?,?,?,?,?)')
        .bind(d.email.toLowerCase(),safeText(d.username||'')||null,hash,storageRole(role),role==='team_manager'?Number(d.team_id):null,safeText(d.display_name)).run();
      await setExtendedRole(env,result.meta.last_row_id,role);
      await audit(env,user.id,'create','user',result.meta.last_row_id,{role,team_id:d.team_id||null});
      return json({ok:true,id:result.meta.last_row_id},201);
    }
  }

  if (path.match(/^admin\/users\/\d+$/) && method==='PUT') {
    const denied=requireAnyRole(user,'super_admin','organizer'); if(denied)return denied;
    const id=Number(path.split('/').pop()), d=await body(request);
    const existing=await env.DB.prepare(`SELECT u.id,COALESCE(ar.role,u.role) role FROM users u LEFT JOIN auth_roles ar ON ar.user_id=u.id WHERE u.id=?`).bind(id).first();
    if(!existing)return json({error:'Account non trovato'},404);
    const role=['organizer','team_manager','referee'].includes(d.role)?d.role:(ROLE_ALIASES[existing.role]||existing.role);
    if(role==='team_manager'&&!d.team_id)return json({error:'Per un account Squadra devi selezionare una squadra'},400);
    if (id===user.id && d.is_active===0) return json({error:'Non puoi disattivare il tuo account'},400);
    const duplicate=await env.DB.prepare('SELECT id FROM users WHERE id!=? AND (lower(email)=lower(?) OR (? IS NOT NULL AND username=?)) LIMIT 1').bind(id,d.email,d.username||null,d.username||null).first();
    if(duplicate)return json({error:'Email o username già utilizzati'},409);
    await env.DB.prepare('UPDATE users SET display_name=?,email=?,username=?,role=?,team_id=?,is_active=?,updated_at=CURRENT_TIMESTAMP WHERE id=?')
      .bind(safeText(d.display_name),String(d.email||'').toLowerCase(),safeText(d.username||'')||null,storageRole(role),role==='team_manager'?Number(d.team_id):null,d.is_active===0?0:1,id).run();
    await setExtendedRole(env,id,role);
    if(d.is_active===0) await env.DB.prepare('DELETE FROM sessions WHERE user_id=?').bind(id).run();
    await audit(env,user.id,'update','user',id,{role,is_active:d.is_active}); return json({ok:true});
  }

  if (path.match(/^admin\/users\/\d+\/status$/) && method==='POST') {
    const denied=requireAnyRole(user,'super_admin','organizer'); if(denied)return denied;
    const id=Number(path.split('/')[2]), d=await body(request);
    if(id===user.id && Number(d.is_active)===0)return json({error:'Non puoi disattivare il tuo account'},400);
    const found=await env.DB.prepare('SELECT id FROM users WHERE id=?').bind(id).first();
    if(!found)return json({error:'Account non trovato'},404);
    const active=Number(d.is_active)===1?1:0;
    await env.DB.prepare('UPDATE users SET is_active=?,updated_at=CURRENT_TIMESTAMP WHERE id=?').bind(active,id).run();
    if(!active)await env.DB.prepare('DELETE FROM sessions WHERE user_id=?').bind(id).run();
    await audit(env,user.id,active?'activate':'deactivate','user',id);
    return json({ok:true});
  }

  if (path.match(/^admin\/users\/\d+$/) && method==='DELETE') {
    const denied=requireAnyRole(user,'super_admin','organizer'); if(denied)return denied;
    const id=Number(path.split('/').pop());
    if(id===user.id)return json({error:'Non puoi eliminare il tuo account'},400);
    const found=await env.DB.prepare('SELECT id FROM users WHERE id=?').bind(id).first();
    if(!found)return json({error:'Account non trovato'},404);
    await env.DB.batch([
      env.DB.prepare('DELETE FROM sessions WHERE user_id=?').bind(id),
      env.DB.prepare('DELETE FROM password_reset_tokens WHERE user_id=?').bind(id),
      env.DB.prepare('DELETE FROM auth_roles WHERE user_id=?').bind(id),
      env.DB.prepare('DELETE FROM users WHERE id=?').bind(id)
    ]);
    await audit(env,user.id,'delete','user',id);
    return json({ok:true});
  }

  if (path.match(/^admin\/users\/\d+\/reset-link$/) && method==='POST') {
    const denied=requireAnyRole(user,'super_admin','organizer'); if(denied)return denied;
    const id=Number(path.split('/')[2]); const found=await env.DB.prepare('SELECT id FROM users WHERE id=?').bind(id).first();
    if(!found)return json({error:'Account non trovato'},404);
    await env.DB.prepare("DELETE FROM password_reset_tokens WHERE user_id=? OR expires_at <= datetime('now')").bind(id).run();
    const token=crypto.randomUUID().replaceAll('-','')+crypto.randomUUID().replaceAll('-','');
    await env.DB.prepare("INSERT INTO password_reset_tokens(token,user_id,expires_at,created_by_user_id) VALUES(?,?,datetime('now','+30 minutes'),?)").bind(token,id,user.id).run();
    await audit(env,user.id,'create_reset_link','user',id); return json({ok:true,resetUrl:`${new URL(request.url).origin}/#/reset-password/${token}`});
  }

  if (path === 'admin/sponsors' || path === 'team/sponsors') {
    const denied=requireAnyRole(user,'super_admin','organizer','team_manager'); if(denied)return denied;
    if(method==='GET') { const q=hasRole(user,'team_manager')?env.DB.prepare("SELECT * FROM sponsors WHERE team_id=? AND level='team' ORDER BY is_featured DESC,name").bind(user.team_id):env.DB.prepare('SELECT s.*,t.name team_name FROM sponsors s LEFT JOIN teams t ON t.id=s.team_id ORDER BY s.level,s.is_featured DESC,s.name'); return json({sponsors:(await q.all()).results}); }
    if(method==='POST') { const d=await body(request); const level=hasRole(user,'team_manager')?'team':(d.level||'league'); const teamId=hasRole(user,'team_manager')?user.team_id:(level==='team'?Number(d.team_id):null); const result=await env.DB.prepare('INSERT INTO sponsors(name,logo_url,website_url,level,team_id,is_featured) VALUES(?,?,?,?,?,?)').bind(d.name,d.logo_url||'',d.website_url||'',level,teamId,d.is_featured?1:0).run(); await audit(env,user.id,'create','sponsor',result.meta.last_row_id,d); return json({ok:true,id:result.meta.last_row_id},201); }
  }
  if (path.match(/^team\/sponsors\/\d+$/)) {
    const denied=requireAnyRole(user,'team_manager'); if(denied)return denied;
    const id=Number(path.split('/').pop());
    const existing=await env.DB.prepare("SELECT * FROM sponsors WHERE id=? AND team_id=? AND level='team'").bind(id,user.team_id).first();
    if(!existing)return json({error:'Sponsor non trovato'},404);
    if(method==='PUT'){
      const d=await body(request);
      await env.DB.prepare("UPDATE sponsors SET name=?,logo_url=?,website_url=?,is_featured=?,is_active=? WHERE id=? AND team_id=?")
        .bind(safeText(d.name),d.logo_url||'',d.website_url||'',d.is_featured?1:0,d.is_active===0?0:1,id,user.team_id).run();
      await audit(env,user.id,'update','sponsor',id,d);return json({ok:true});
    }
    if(method==='DELETE'){
      await env.DB.prepare("DELETE FROM sponsors WHERE id=? AND team_id=?").bind(id,user.team_id).run();
      await audit(env,user.id,'delete','sponsor',id,{});return json({ok:true});
    }
  }

  if (path === 'admin/news') {
    const denied=requireAnyRole(user,'super_admin','organizer'); if(denied)return denied;
    if(method==='GET') return json({news:(await env.DB.prepare('SELECT * FROM news ORDER BY created_at DESC').all()).results});
    if(method==='POST') { const d=await body(request); const result=await env.DB.prepare('INSERT INTO news(title,slug,excerpt,body,cover_url,is_published,published_at) VALUES(?,?,?,?,?,?,CASE WHEN ?=1 THEN CURRENT_TIMESTAMP ELSE NULL END)').bind(d.title,slugify(d.slug||d.title),d.excerpt||'',d.body||'',d.cover_url||'',d.is_published?1:0,d.is_published?1:0).run(); await audit(env,user.id,'create','news',result.meta.last_row_id,d); return json({ok:true,id:result.meta.last_row_id},201); }
  }
  if (path === 'admin/polls') {
    const denied=requireAnyRole(user,'super_admin','organizer'); if(denied)return denied;
    if(method==='GET') { const polls=(await env.DB.prepare('SELECT * FROM polls ORDER BY created_at DESC').all()).results; for(const p of polls)p.options=(await env.DB.prepare('SELECT * FROM poll_options WHERE poll_id=?').bind(p.id).all()).results; return json({polls}); }
    if(method==='POST') { const d=await body(request); const r=await env.DB.prepare('INSERT INTO polls(title,description,poll_type,starts_at,ends_at,status) VALUES(?,?,?,?,?,?)').bind(d.title,d.description||'',d.poll_type||'custom',d.starts_at,d.ends_at,d.status||'draft').run(); for(const o of (d.options||[])) if(o.label) await env.DB.prepare('INSERT INTO poll_options(poll_id,label,image_url,player_id,team_id) VALUES(?,?,?,?,?)').bind(r.meta.last_row_id,o.label,o.image_url||'',o.player_id?Number(o.player_id):null,o.team_id?Number(o.team_id):null).run(); await audit(env,user.id,'create','poll',r.meta.last_row_id,d); return json({ok:true,id:r.meta.last_row_id},201); }
  }

  // Full Admin CRUD: every platform entity can be created, edited and deleted only by Admin/Organizer.
  if (path.match(/^admin\/seasons\/\d+$/) && method==='DELETE') {
    const denied=requireAnyRole(user,'super_admin','organizer'); if(denied)return denied; const id=Number(path.split('/').pop());
    await env.DB.prepare('DELETE FROM match_submissions WHERE match_id IN (SELECT id FROM matches WHERE season_id=?)').bind(id).run();
    await env.DB.prepare('DELETE FROM match_events WHERE match_id IN (SELECT id FROM matches WHERE season_id=?)').bind(id).run();
    await env.DB.prepare('DELETE FROM match_schedule_meta WHERE match_id IN (SELECT id FROM matches WHERE season_id=?)').bind(id).run();
    await env.DB.prepare('DELETE FROM matches WHERE season_id=?').bind(id).run();
    await env.DB.prepare('DELETE FROM seasons WHERE id=?').bind(id).run(); await audit(env,user.id,'delete','season',id,{}); return json({ok:true});
  }
  if (path.match(/^admin\/matches\/\d+$/) && method==='DELETE') {
    const denied=requireAnyRole(user,'super_admin','organizer'); if(denied)return denied; const id=Number(path.split('/').pop());
    await env.DB.prepare('DELETE FROM match_submissions WHERE match_id=?').bind(id).run(); await env.DB.prepare('DELETE FROM match_events WHERE match_id=?').bind(id).run(); await env.DB.prepare('DELETE FROM match_schedule_meta WHERE match_id=?').bind(id).run(); await env.DB.prepare('DELETE FROM matches WHERE id=?').bind(id).run(); await audit(env,user.id,'delete','match',id,{}); return json({ok:true});
  }
  if (path.match(/^admin\/sponsors\/\d+$/)) {
    const denied=requireAnyRole(user,'super_admin','organizer'); if(denied)return denied; const id=Number(path.split('/').pop()); const d=method==='PUT'?await body(request):{};
    if(method==='PUT'){const level=d.level==='team'?'team':'league';await env.DB.prepare('UPDATE sponsors SET name=?,logo_url=?,website_url=?,level=?,team_id=?,is_featured=?,is_active=? WHERE id=?').bind(safeText(d.name),d.logo_url||'',d.website_url||'',level,level==='team'&&d.team_id?Number(d.team_id):null,d.is_featured?1:0,d.is_active===0?0:1,id).run();await audit(env,user.id,'update','sponsor',id,d);return json({ok:true});}
    if(method==='DELETE'){await env.DB.prepare('DELETE FROM sponsors WHERE id=?').bind(id).run();await audit(env,user.id,'delete','sponsor',id,{});return json({ok:true});}
  }
  if (path.match(/^admin\/news\/\d+$/)) {
    const denied=requireAnyRole(user,'super_admin','organizer'); if(denied)return denied; const id=Number(path.split('/').pop()); const d=method==='PUT'?await body(request):{};
    if(method==='PUT'){await env.DB.prepare(`UPDATE news SET title=?,slug=?,excerpt=?,body=?,cover_url=?,is_published=?,published_at=CASE WHEN ?=1 THEN COALESCE(published_at,CURRENT_TIMESTAMP) ELSE NULL END,updated_at=CURRENT_TIMESTAMP WHERE id=?`).bind(safeText(d.title),slugify(d.slug||d.title),d.excerpt||'',d.body||'',d.cover_url||'',d.is_published?1:0,d.is_published?1:0,id).run();await audit(env,user.id,'update','news',id,d);return json({ok:true});}
    if(method==='DELETE'){await env.DB.prepare('DELETE FROM news WHERE id=?').bind(id).run();await audit(env,user.id,'delete','news',id,{});return json({ok:true});}
  }
  if (path.match(/^admin\/polls\/\d+$/)) {
    const denied=requireAnyRole(user,'super_admin','organizer'); if(denied)return denied; const id=Number(path.split('/').pop()); const d=method==='PUT'?await body(request):{};
    if(method==='PUT'){await env.DB.prepare('UPDATE polls SET title=?,description=?,poll_type=?,starts_at=?,ends_at=?,status=? WHERE id=?').bind(safeText(d.title),d.description||'',d.poll_type||'custom',d.starts_at,d.ends_at,d.status||'draft',id).run();await env.DB.prepare('DELETE FROM votes WHERE poll_id=?').bind(id).run();await env.DB.prepare('DELETE FROM poll_options WHERE poll_id=?').bind(id).run();for(const o of (d.options||[]))if(o.label)await env.DB.prepare('INSERT INTO poll_options(poll_id,label,image_url,player_id,team_id) VALUES(?,?,?,?,?)').bind(id,o.label,o.image_url||'',o.player_id?Number(o.player_id):null,o.team_id?Number(o.team_id):null).run();await audit(env,user.id,'update','poll',id,d);return json({ok:true});}
    if(method==='DELETE'){await env.DB.prepare('DELETE FROM votes WHERE poll_id=?').bind(id).run();await env.DB.prepare('DELETE FROM poll_options WHERE poll_id=?').bind(id).run();await env.DB.prepare('DELETE FROM polls WHERE id=?').bind(id).run();await audit(env,user.id,'delete','poll',id,{});return json({ok:true});}
  }

  return json({ error:'Endpoint non trovato', path },404);
}

export async function onRequest(context) {
  const path = context.params.path ? (Array.isArray(context.params.path) ? context.params.path.join('/') : context.params.path) : '';
  try { await ensureAuthSchema(context.env); await ensureCalendarSchema(context.env); return await route(context.request, context.env, path); }
  catch (error) { console.error(error); return json({ error:'Errore interno', detail:error.message },500); }
}
