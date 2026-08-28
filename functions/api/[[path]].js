function safeJsonParse(v,fallback=[]){try{return JSON.parse(v||'[]')}catch{return fallback}}
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
function shuffleCopy(list){
  const out=[...list];
  for(let i=out.length-1;i>0;i--){
    const j=Math.floor(Math.random()*(i+1));
    [out[i],out[j]]=[out[j],out[i]];
  }
  return out;
}
function mondayOfWeek(value){
  const d=new Date(value);
  const offset=(d.getDay()+6)%7;
  d.setDate(d.getDate()-offset);
  d.setHours(12,0,0,0);
  return d;
}
function firstEligibleCompetitionWeek(referenceDate){
  const reference=new Date(referenceDate);
  reference.setHours(0,0,0,0);
  let monday=mondayOfWeek(reference);
  while(true){
    const candidates=[1,2,3,4].map(offset=>{
      const d=new Date(monday);
      d.setDate(monday.getDate()+offset);
      d.setHours(12,0,0,0);
      return d;
    }).filter(d=>d>=reference);
    if(candidates.length>=3)return monday;
    monday=new Date(monday);
    monday.setDate(monday.getDate()+7);
  }
}
function schedulePrimeLeagueRound(roundPairs, weekReference){
  if(roundPairs.length!==5){
    throw new Error('La distribuzione settimanale 2 + 2 + 1 richiede esattamente 10 squadre (5 partite per giornata).');
  }
  const weekMonday=firstEligibleCompetitionWeek(weekReference);
  const selectedOffsets=shuffleCopy([1,2,3,4]).slice(0,3).sort((a,b)=>a-b);
  const singleDayIndex=Math.floor(Math.random()*3);
  const gamesPerSelectedDay=selectedOffsets.map((_,index)=>index===singleDayIndex?1:2);
  const pairs=shuffleCopy(roundPairs);
  const games=[];
  let pairIndex=0;
  selectedOffsets.forEach((dayOffset,index)=>{
    const matchCount=gamesPerSelectedDay[index];
    const day=new Date(weekMonday);
    day.setDate(weekMonday.getDate()+dayOffset);
    for(let slot=0;slot<matchCount;slot++){
      const dt=new Date(day);
      if(slot===0)dt.setHours(19,0,0,0);
      else dt.setHours(20,30,0,0);
      games.push({pair:pairs[pairIndex++],date:dt});
    }
  });
  games.sort((a,b)=>a.date-b.date);
  const nextWeek=new Date(weekMonday);
  nextWeek.setDate(nextWeek.getDate()+7);
  return {games,weekMonday,nextWeek};
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
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS match_lineups (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      match_id INTEGER NOT NULL,
      team_id INTEGER NOT NULL,
      player_id INTEGER NOT NULL,
      is_called INTEGER NOT NULL DEFAULT 1,
      lineup_role TEXT NOT NULL DEFAULT 'reserve',
      played INTEGER NOT NULL DEFAULT 0,
      source_submission_id INTEGER,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(match_id,team_id,player_id)
    )`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS match_referees (
      match_id INTEGER PRIMARY KEY,
      referee_user_id INTEGER NOT NULL,
      assigned_by_user_id INTEGER,
      assigned_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
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


async function voteHash(value){
  const data=new TextEncoder().encode(String(value||''));
  const digest=await crypto.subtle.digest('SHA-256',data);
  return [...new Uint8Array(digest)].map(x=>x.toString(16).padStart(2,'0')).join('');
}

async function ensureAnonymousVoteSchema(env){
  await env.DB.batch([
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS anonymous_poll_votes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      poll_id INTEGER NOT NULL,
      option_id INTEGER NOT NULL,
      voter_hash TEXT NOT NULL,
      ip_hash TEXT,
      browser_hash TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(poll_id,voter_hash)
    )`),
    env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_anonymous_votes_poll ON anonymous_poll_votes(poll_id)`),
    env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_anonymous_votes_option ON anonymous_poll_votes(option_id)`),
    env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_anonymous_votes_ip ON anonymous_poll_votes(poll_id,ip_hash)`)
  ]);
  try{await env.DB.prepare(`ALTER TABLE polls ADD COLUMN match_id INTEGER`).run()}catch{}
  try{await env.DB.prepare(`ALTER TABLE anonymous_poll_votes ADD COLUMN user_agent_hash TEXT`).run()}catch{}
  try{await env.DB.prepare(`ALTER TABLE anonymous_poll_votes ADD COLUMN browser_hash TEXT`).run()}catch{}
}


async function ensureFaqSchema(env){
  await env.DB.batch([
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS faq_categories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      icon TEXT NOT NULL DEFAULT '❓',
      sort_order INTEGER NOT NULL DEFAULT 100,
      is_active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS faqs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      category_id INTEGER NOT NULL,
      question TEXT NOT NULL,
      answer TEXT NOT NULL,
      sort_order INTEGER NOT NULL DEFAULT 100,
      is_active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`)
  ]);
  const count=await env.DB.prepare('SELECT COUNT(*) c FROM faqs').first();
  if(Number(count?.c||0)===0){
    const seed=[["Iscrizioni e squadre", "📝", "Come si iscrive una squadra?", "Per partecipare è necessario contattare l’organizzazione e completare la procedura di iscrizione entro la data comunicata per la stagione.", 10], ["Iscrizioni e squadre", "📝", "Quante squadre partecipano?", "La Prime League è strutturata per ospitare indicativamente da 10 a 12 squadre, in base alla stagione.", 20], ["Iscrizioni e squadre", "📝", "È possibile iscriversi a campionato iniziato?", "No. Le iscrizioni delle squadre vengono chiuse prima dell’inizio della competizione.", 30], ["Iscrizioni e squadre", "📝", "Cosa comprende la quota di iscrizione?", "La quota copre i servizi organizzativi previsti per la stagione. Tesseramenti, cauzione ed eventuali costi aggiuntivi vengono comunicati separatamente dall’organizzazione.", 40], ["Giocatori e tesseramenti", "👤", "Qual è l’età minima per partecipare?", "La partecipazione è consentita a partire dai 17 anni, nel rispetto della documentazione e delle autorizzazioni richieste.", 10], ["Giocatori e tesseramenti", "👤", "Quanti giocatori deve avere una squadra?", "Ogni squadra deve presentare una rosa di almeno 12 giocatori. Le condizioni definitive sono indicate nei documenti ufficiali della stagione.", 20], ["Giocatori e tesseramenti", "👤", "Possono partecipare giocatori tesserati con altre società?", "Sì, entro il limite massimo previsto dalla Prime League. Attualmente sono ammessi fino a tre tesserati esterni per squadra.", 30], ["Giocatori e tesseramenti", "👤", "È possibile aggiungere giocatori durante la stagione?", "Sì, esclusivamente durante la finestra di mercato stabilita dall’organizzazione e completando il relativo tesseramento.", 40], ["Giocatori e tesseramenti", "👤", "Serve il certificato medico?", "Ogni partecipante deve essere in possesso della documentazione sanitaria e sportiva richiesta per il tesseramento CSI.", 50], ["Partite e calendario", "⚽", "Quanto dura una partita?", "Ogni gara ha una durata complessiva di 60 minuti, suddivisa in due tempi.", 10], ["Partite e calendario", "⚽", "Quando si gioca?", "Le gare vengono programmate principalmente il mercoledì, il giovedì e il venerdì, generalmente nelle fasce orarie serali.", 20], ["Partite e calendario", "⚽", "Una partita può essere spostata?", "Sì. In caso di sospensione, rinvio o necessità organizzative, l’Admin può riprogrammare data, ora e campo.", 30], ["Partite e calendario", "⚽", "Cosa succede se una squadra non si presenta?", "La partita può essere assegnata a tavolino con il risultato di 3-0 e può essere applicata una trattenuta sulla cauzione, secondo le regole della stagione.", 40], ["Classifica e competizioni", "🏆", "Chi vince il campionato?", "La squadra prima classificata al termine della stagione regolare è Campione Prime League e vince la coppa del campionato.", 10], ["Classifica e competizioni", "🏆", "Chi partecipa al mini torneo premio?", "Le squadre classificate dal secondo al quinto posto. Le semifinali sono 2ª contro 5ª e 3ª contro 4ª.", 20], ["Classifica e competizioni", "🏆", "Il mini torneo cambia la classifica?", "No. La classifica finale del campionato resta quella determinata dalla stagione regolare.", 30], ["Classifica e competizioni", "🏆", "Come si aggiorna la classifica?", "Classifica e statistiche vengono aggiornate dopo la pubblicazione del risultato e l’approvazione del referto da parte dell’Admin.", 40], ["Referti e disciplina", "📋", "Chi compila il referto?", "Le due squadre possono inviare il proprio referto, mentre l’arbitro registra gli eventi disciplinari e le informazioni di propria competenza.", 10], ["Referti e disciplina", "📋", "Cosa contiene il referto?", "Risultato, distinta, convocati, titolari, riserve, presenze, gol, assist, ammonizioni, espulsioni, MVP e note.", 20], ["Referti e disciplina", "📋", "Chi rende ufficiali i dati?", "L’Admin confronta i referti ricevuti, risolve eventuali differenze e approva il documento definitivo.", 30], ["Referti e disciplina", "📋", "Come funzionano le squalifiche?", "Tre ammonizioni comportano una giornata di squalifica. Espulsioni e comportamenti gravi vengono valutati secondo le regole disciplinari della lega.", 40], ["Votazioni, sponsor e collaborazioni", "🤝", "Serve registrarsi per votare?", "No. Le votazioni pubbliche non richiedono un account, ma ogni dispositivo può esprimere una sola preferenza per ciascun sondaggio.", 10], ["Votazioni, sponsor e collaborazioni", "🤝", "È possibile sponsorizzare una squadra?", "Sì. Le aziende possono sostenere una singola squadra oppure diventare sponsor della Prime League.", 20], ["Votazioni, sponsor e collaborazioni", "🤝", "Come posso collaborare con la lega?", "La Prime League valuta collaborazioni con arbitri, fotografi, videomaker, speaker, content creator e professionisti del territorio.", 30]];
    const categoryMap=new Map();
    for(const [category,icon,question,answer,sortOrder] of seed){
      let categoryId=categoryMap.get(category);
      if(!categoryId){
        let row=await env.DB.prepare('SELECT id FROM faq_categories WHERE name=?').bind(category).first();
        if(!row){
          const r=await env.DB.prepare('INSERT INTO faq_categories(name,icon,sort_order,is_active) VALUES(?,?,?,1)')
            .bind(category,icon,(categoryMap.size+1)*10).run();
          categoryId=r.meta.last_row_id;
        } else categoryId=row.id;
        categoryMap.set(category,categoryId);
      }
      await env.DB.prepare('INSERT INTO faqs(category_id,question,answer,sort_order,is_active) VALUES(?,?,?,?,1)')
        .bind(categoryId,question,answer,sortOrder).run();
    }
  }
}


async function ensureSponsorProfileSchema(env){
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS sponsors (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    logo_url TEXT,
    website_url TEXT,
    level TEXT NOT NULL DEFAULT 'league',
    team_id INTEGER,
    is_featured INTEGER NOT NULL DEFAULT 0,
    is_active INTEGER NOT NULL DEFAULT 1
  )`).run();

  const cols=(await env.DB.prepare(`PRAGMA table_info(sponsors)`).all()).results.map(x=>x.name);
  const additions=[
    ['slug',`TEXT`],
    ['category',`TEXT NOT NULL DEFAULT ''`],
    ['logo_bg',`TEXT NOT NULL DEFAULT 'light'`],
    ['partner_tier',`TEXT NOT NULL DEFAULT 'partner'`],
    ['cover_url',`TEXT NOT NULL DEFAULT ''`],
    ['description',`TEXT NOT NULL DEFAULT ''`],
    ['phone',`TEXT NOT NULL DEFAULT ''`],
    ['whatsapp',`TEXT NOT NULL DEFAULT ''`],
    ['email',`TEXT NOT NULL DEFAULT ''`],
    ['address',`TEXT NOT NULL DEFAULT ''`],
    ['google_url',`TEXT NOT NULL DEFAULT ''`],
    ['instagram_url',`TEXT NOT NULL DEFAULT ''`],
    ['facebook_url',`TEXT NOT NULL DEFAULT ''`],
    ['tiktok_url',`TEXT NOT NULL DEFAULT ''`],
    ['gallery_json',`TEXT NOT NULL DEFAULT '[]'`],
    ['promo_active',`INTEGER NOT NULL DEFAULT 0`],
    ['promo_title',`TEXT NOT NULL DEFAULT ''`],
    ['promo_description',`TEXT NOT NULL DEFAULT ''`],
    ['promo_code',`TEXT NOT NULL DEFAULT ''`],
    ['promo_terms',`TEXT NOT NULL DEFAULT ''`],
    ['promo_start',`TEXT`],
    ['promo_end',`TEXT`],
    ['sort_order',`INTEGER NOT NULL DEFAULT 100`],
    ['updated_at',`TEXT`]
  ];
  for(const [name,type] of additions){
    if(!cols.includes(name)){
      try{await env.DB.prepare(`ALTER TABLE sponsors ADD COLUMN ${name} ${type}`).run()}catch{}
    }
  }

  const rows=(await env.DB.prepare(`SELECT id,name,slug FROM sponsors`).all()).results;
  for(const row of rows){
    if(!String(row.slug||'').trim()){
      let base=slugify(row.name)||`sponsor-${row.id}`;
      let slug=base;
      let n=2;
      while(await env.DB.prepare(`SELECT id FROM sponsors WHERE slug=? AND id<>?`).bind(slug,row.id).first()){
        slug=`${base}-${n++}`;
      }
      await env.DB.prepare(`UPDATE sponsors SET slug=? WHERE id=?`).bind(slug,row.id).run();
    }
  }
}

function sponsorPromoLive(s){
  if(!Number(s.promo_active||0))return false;
  const now=Date.now();
  const parsePromoDate=(v,endOfDay=false)=>{
    if(!v)return null;
    let str=String(v).trim();
    if(/^\d{4}-\d{2}-\d{2}$/.test(str))str+=endOfDay?'T23:59:59':'T00:00:00';
    const t=new Date(str).getTime();
    return Number.isFinite(t)?t:null;
  };
  const start=parsePromoDate(s.promo_start,false);
  const end=parsePromoDate(s.promo_end,true);
  if(start!==null && start>now)return false;
  if(end!==null && end<now)return false;
  return true;
}
function mapSponsorRow(s){
  return {
    ...s,
    gallery:safeJsonParse(s.gallery_json,[]),
    promo_is_live:sponsorPromoLive(s)
  };
}

async function ensureFormulaSchema(env){
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS formula_sections (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    section_key TEXT NOT NULL UNIQUE,
    kicker TEXT NOT NULL DEFAULT '',
    title TEXT NOT NULL,
    body TEXT NOT NULL DEFAULT '',
    items_json TEXT NOT NULL DEFAULT '[]',
    style TEXT NOT NULL DEFAULT 'cards',
    sort_order INTEGER NOT NULL DEFAULT 100,
    is_active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`).run();

  const count=await env.DB.prepare('SELECT COUNT(*) c FROM formula_sections').first();
  if(Number(count?.c||0)===0){
    const seed=[{"section_key": "overview", "kicker": "01 · Campionato", "title": "Una stagione di circa 5 mesi", "body": "La Prime League è un campionato strutturato con gare di andata e ritorno. Ogni squadra affronta tutte le altre due volte nel corso di una stagione che si sviluppa indicativamente nell’arco di circa cinque mesi. Calendario, risultati e classifica vengono aggiornati durante tutta la competizione.", "items": ["Campionato con gare di andata e ritorno", "Durata indicativa di circa 5 mesi", "Calendario organizzato per giornate", "Classifica aggiornata durante la stagione"], "style": "intro", "sort_order": 10}, {"section_key": "matchday", "kicker": "02 · Giornata di gara", "title": "Ogni partita fa parte di un sistema organizzato", "body": "Le gare non sono eventi isolati: ogni partita è inserita nel calendario ufficiale della stagione e viene gestita attraverso convocazioni, distinta, titolari, riserve, presenze, risultato ed eventi della gara.", "items": ["Convocati e distinta ufficiale", "Titolari e riserve", "Presenze effettive, compresi i subentrati", "Gol e assist", "Ammonizioni ed espulsioni", "MVP e dati della partita"], "style": "cards", "sort_order": 20}, {"section_key": "players", "kicker": "03 · Giocatori", "title": "Tesseramenti e identità ufficiale", "body": "Ogni partecipante viene inserito nella rosa ufficiale della propria squadra. Il giocatore dispone di una scheda personale all’interno della piattaforma e di un cartellino identificativo collegato alla stagione.", "items": ["Tesseramento del giocatore", "Cartellino giocatore", "Numero di maglia e ruolo", "Foto e profilo personale", "Statistiche individuali", "Storico delle presenze e degli eventi"], "style": "cards", "sort_order": 30}, {"section_key": "referees", "kicker": "04 · Arbitraggio", "title": "Arbitri e gestione disciplinare", "body": "Le partite sono dirette da arbitri incaricati per la competizione. L’arbitro dispone di un accesso dedicato per compilare il proprio referto e registrare gli eventi disciplinari della gara.", "items": ["Arbitro designato per la gara", "Referto arbitrale", "Ammonizioni", "Espulsioni", "Segnalazioni disciplinari", "Verifica finale da parte dell’organizzazione"], "style": "cards", "sort_order": 40}, {"section_key": "reports", "kicker": "05 · Referti", "title": "Dati verificati prima della pubblicazione", "body": "Le squadre possono inviare il proprio referto e l’arbitro compila quello di propria competenza. L’organizzazione confronta i dati ricevuti, risolve eventuali differenze e approva il referto definitivo. Solo dopo l’approvazione i dati diventano ufficiali.", "items": ["Referto squadra A", "Referto squadra B", "Referto arbitro", "Confronto automatico degli eventi coincidenti", "Controllo dell’Admin", "Pubblicazione del referto definitivo"], "style": "process", "sort_order": 50}, {"section_key": "statistics", "kicker": "06 · Dati e statistiche", "title": "Il campionato vive anche attraverso i numeri", "body": "Risultati e referti alimentano automaticamente le statistiche della piattaforma. Squadre, giocatori e pubblico possono seguire l’andamento della stagione attraverso dati aggiornati.", "items": ["Classifica", "Gol", "Assist", "Presenze", "Cartellini", "MVP", "Statistiche dei giocatori", "Statistiche delle squadre"], "style": "cards", "sort_order": 60}, {"section_key": "media", "kicker": "07 · Comunicazione", "title": "Interviste, contenuti e racconto social", "body": "Prime League non si limita alle partite. La competizione viene raccontata attraverso contenuti digitali pensati per dare visibilità alle squadre, ai giocatori, agli sponsor e ai protagonisti della stagione.", "items": ["Interviste ai protagonisti", "Foto e video delle giornate", "Highlights e contenuti partita", "Grafiche risultati e classifiche", "Contenuti social", "News e aggiornamenti della lega"], "style": "media", "sort_order": 70}, {"section_key": "engagement", "kicker": "08 · Community", "title": "Il pubblico partecipa alla stagione", "body": "Attraverso la piattaforma ufficiale il pubblico può seguire la competizione e partecipare alle votazioni aperte dalla lega, senza necessità di creare un account.", "items": ["Votazioni MVP", "Sondaggi ufficiali", "Partite e risultati", "Classifica", "Squadre e giocatori", "News della competizione"], "style": "cards", "sort_order": 80}, {"section_key": "champion", "kicker": "09 · Titolo", "title": "Il primo classificato è Campione Prime League", "body": "Al termine della stagione regolare la squadra che occupa il primo posto della classifica viene proclamata Campione Prime League e conquista il titolo della stagione.", "items": ["Primo posto nella classifica finale", "Titolo di Campione Prime League", "Coppa del campionato", "Premio principale della stagione"], "style": "champion", "sort_order": 90}, {"section_key": "mini_tournament", "kicker": "10 · Fase premio", "title": "Mini torneo dal 2º al 5º posto", "body": "Le squadre classificate dal secondo al quinto posto accedono a un mini torneo separato. Le semifinali sono 2ª contro 5ª e 3ª contro 4ª; le due vincenti disputano la finale. Il mini torneo assegna un premio dedicato e non modifica la classifica finale del campionato.", "items": ["Semifinale 1: 2ª vs 5ª", "Semifinale 2: 3ª vs 4ª", "Finale tra le due vincenti", "Premio separato dal titolo di Campione"], "style": "bracket", "sort_order": 100}, {"section_key": "organization", "kicker": "11 · Organizzazione", "title": "Una competizione gestita durante tutta la stagione", "body": "L’organizzazione coordina calendario, account delle squadre, gestione degli arbitri, referti, comunicazioni, statistiche, votazioni e contenuti ufficiali. L’obiettivo è offrire una competizione ordinata e un’esperienza chiara sia dentro che fuori dal campo.", "items": ["Gestione calendario e partite", "Gestione squadre e giocatori", "Coordinamento arbitrale", "Approvazione dei referti", "Aggiornamento della piattaforma", "Comunicazione e contenuti ufficiali"], "style": "organization", "sort_order": 110}];
    for(const s of seed){
      await env.DB.prepare(`INSERT INTO formula_sections
        (section_key,kicker,title,body,items_json,style,sort_order,is_active)
        VALUES(?,?,?,?,?,?,?,1)`)
        .bind(s.section_key,s.kicker,s.title,s.body,JSON.stringify(s.items||[]),s.style,s.sort_order).run();
    }
  }
}


async function ensureCustomCompetitionsSchema(env){
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS custom_competitions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    season_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    slug TEXT NOT NULL UNIQUE,
    competition_type TEXT NOT NULL DEFAULT 'cup',
    format TEXT NOT NULL DEFAULT 'knockout',
    description TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'planned',
    start_date TEXT,
    end_date TEXT,
    participant_count INTEGER,
    prize TEXT NOT NULL DEFAULT '',
    is_public INTEGER NOT NULL DEFAULT 1,
    sort_order INTEGER NOT NULL DEFAULT 100,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`).run();
  await env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_custom_competitions_season
    ON custom_competitions(season_id,sort_order,id)`).run();
}

function mapCustomCompetition(row){
  return {
    ...row,
    is_public:Number(row.is_public||0)===1
  };
}


async function ensureNewsAutomationSchema(env){
  const cols=(await env.DB.prepare(`PRAGMA table_info(news)`).all()).results.map(x=>x.name);
  const additions=[
    ['category',`TEXT NOT NULL DEFAULT 'campionato'`],
    ['source_type',`TEXT NOT NULL DEFAULT 'manual'`],
    ['source_id',`TEXT`],
    ['is_featured',`INTEGER NOT NULL DEFAULT 0`],
    ['auto_generated',`INTEGER NOT NULL DEFAULT 0`]
  ];
  for(const [name,type] of additions){
    if(!cols.includes(name)){
      try{await env.DB.prepare(`ALTER TABLE news ADD COLUMN ${name} ${type}`).run()}catch{}
    }
  }
  try{await env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_news_source ON news(source_type,source_id)`).run()}catch{}
}

async function createNewsDraftIfMissing(env,{title,excerpt,body,category='campionato',source_type='manual',source_id=null,cover_url=''}){
  if(source_type!=='manual' && source_id!==null){
    const existing=await env.DB.prepare(`SELECT id FROM news WHERE source_type=? AND source_id=? LIMIT 1`)
      .bind(source_type,String(source_id)).first();
    if(existing)return existing.id;
  }
  const slugBase=slugify(title)||`news-${Date.now()}`;
  let slug=slugBase,n=2;
  while(await env.DB.prepare(`SELECT id FROM news WHERE slug=?`).bind(slug).first())slug=`${slugBase}-${n++}`;
  const r=await env.DB.prepare(`INSERT INTO news
    (title,slug,excerpt,body,cover_url,is_published,published_at,category,source_type,source_id,is_featured,auto_generated)
    VALUES(?,?,?,?,?,0,NULL,?,?,?,?,1)`)
    .bind(title,slug,excerpt||'',body||'',cover_url||'',category,source_type,source_id===null?null:String(source_id),0).run();
  return r.meta.last_row_id;
}


function editorialPick(seed,variants){
  const s=String(seed??'prime-league');
  let h=2166136261;
  for(let i=0;i<s.length;i++){h^=s.charCodeAt(i);h=Math.imul(h,16777619);}
  return variants[Math.abs(h>>>0)%variants.length];
}
function editorialNumber(seed,max){
  const s=String(seed??'');
  let h=0;
  for(let i=0;i<s.length;i++)h=(Math.imul(h,31)+s.charCodeAt(i))|0;
  return Math.abs(h)%max;
}
function joinNatural(items){
  const a=items.filter(Boolean);
  if(a.length<=1)return a[0]||'';
  return `${a.slice(0,-1).join(', ')} e ${a[a.length-1]}`;
}

async function buildMatchNewsDraft(env,matchId){
  const match=await env.DB.prepare(`SELECT m.*,ht.name home_name,ht.logo_url home_logo,at.name away_name,at.logo_url away_logo,
    p.first_name mvp_first_name,p.last_name mvp_last_name
    FROM matches m
    JOIN teams ht ON ht.id=m.home_team_id
    JOIN teams at ON at.id=m.away_team_id
    LEFT JOIN players p ON p.id=m.mvp_player_id
    WHERE m.id=?`).bind(matchId).first();
  if(!match||match.status!=='published')return null;

  const scorers=(await env.DB.prepare(`SELECT p.first_name,p.last_name,t.name team_name,SUM(e.quantity) goals
    FROM match_events e JOIN players p ON p.id=e.player_id JOIN teams t ON t.id=e.team_id
    WHERE e.match_id=? AND e.event_type='goal'
    GROUP BY p.id,t.id ORDER BY goals DESC,p.last_name`).bind(matchId).all()).results;

  const home=Number(match.home_score||0),away=Number(match.away_score||0);
  const winner=home>away?match.home_name:away>home?match.away_name:null;
  const loser=home>away?match.away_name:away>home?match.home_name:null;
  const winScore=home>away?`${home}-${away}`:`${away}-${home}`;
  const mvp=match.mvp_first_name?`${match.mvp_first_name} ${match.mvp_last_name}`:'';
  const scorerNames=scorers.map(x=>`${x.first_name} ${x.last_name}${Number(x.goals)>1?` (${x.goals})`:''}`);
  const seed=`match:${matchId}:${home}:${away}:${match.round_name}`;

  const title=winner
    ? editorialPick(seed,[
        `${winner}, tre punti contro ${loser}: ${winScore}`,
        `${winner} firma la vittoria: ${winScore} su ${loser}`,
        `${match.round_name||'Prime League'}: sorride ${winner}`,
        `${winner} supera ${loser} nella sfida di Prime League`,
        `Il verdetto è ${winScore}: ${winner} batte ${loser}`,
        `${winner} fa sua la sfida contro ${loser}`
      ])
    : editorialPick(seed,[
        `${match.home_name}-${match.away_name}: finisce ${home}-${away}`,
        `Un punto a testa tra ${match.home_name} e ${match.away_name}`,
        `Equilibrio Prime League: ${home}-${away} tra ${match.home_name} e ${match.away_name}`,
        `${match.home_name} e ${match.away_name} si dividono la posta`
      ]);

  const opening=winner
    ? editorialPick(seed+'open',[
        `${winner} porta a casa la sfida contro ${loser}. Il tabellone dice ${winScore} e consegna tre punti importanti nel percorso di ${match.round_name||'questa fase di campionato'}.`,
        `La sfida tra ${match.home_name} e ${match.away_name} ha un vincitore: ${winner}. Il ${winScore} entra nel quadro ufficiale di ${match.round_name||'questa giornata'} e aggiorna la corsa in campionato.`,
        `Tre punti per ${winner}, che chiude sul ${winScore} il confronto con ${loser}. Un nuovo risultato ufficiale prende posto nella stagione Prime League.`,
        `${match.round_name||'La giornata'} consegna a ${winner} una vittoria contro ${loser}. Il risultato finale, ${winScore}, viene ora registrato ufficialmente sulla piattaforma.`
      ])
    : editorialPick(seed+'open',[
        `${match.home_name} e ${match.away_name} chiudono senza un vincitore. Il ${home}-${away} assegna un punto per parte e aggiorna il quadro di ${match.round_name||'questa giornata'}.`,
        `La sfida resta in equilibrio fino al verdetto ufficiale: ${home}-${away} tra ${match.home_name} e ${match.away_name}.`,
        `Nessuna delle due squadre riesce a prendersi l’intera posta: ${match.home_name} e ${match.away_name} terminano ${home}-${away}.`
      ]);

  const scorerPara=scorerNames.length?editorialPick(seed+'scorers',[
    `Nel tabellino dei marcatori trovano spazio ${joinNatural(scorerNames)}. Sono loro i nomi associati ai gol registrati nel referto ufficiale.`,
    `A costruire il punteggio sono le reti di ${joinNatural(scorerNames)}. Il referto assegna a loro le marcature della gara.`,
    `I protagonisti sotto porta sono ${joinNatural(scorerNames)}: le loro reti compongono il risultato definitivo della partita.`,
    `Sul fronte realizzativo emergono ${joinNatural(scorerNames)}, presenti nel referto tra gli autori dei gol.`
  ]):'';

  const mvpPara=mvp?editorialPick(seed+'mvp',[
    `${mvp} completa il quadro della serata con il riconoscimento di MVP della partita.`,
    `Il premio individuale della gara va a ${mvp}, indicato come MVP.`,
    `Tra i protagonisti c’è anche ${mvp}: per lui arriva il riconoscimento di MVP del match.`,
    `${mvp} viene scelto come MVP e aggiunge il proprio nome ai protagonisti della sfida.`
  ]):'';

  const closing=editorialPick(seed+'close',[
    `Con il referto approvato, il risultato entra ufficialmente negli archivi Prime League e aggiorna automaticamente classifica e statistiche.`,
    `Da questo momento il verdetto è ufficiale: la piattaforma recepisce il referto e aggiorna tutti i dati collegati alla gara.`,
    `L’approvazione definitiva del referto rende disponibili sulla piattaforma risultato e statistiche aggiornate.`,
    `La gara passa così agli archivi ufficiali della lega, con tutti i dati statistici aggiornati in automatico.`
  ]);

  const excerpt=editorialPick(seed+'excerpt',[
    `${match.round_name||'Prime League'}: ${match.home_name} ${home}-${away} ${match.away_name}. Il racconto e i protagonisti della sfida.`,
    `${home}-${away} tra ${match.home_name} e ${match.away_name}: ecco cosa lascia la partita.`,
    `Il verdetto di ${match.home_name}-${match.away_name} e i protagonisti registrati nel referto ufficiale.`
  ]);

  return createNewsDraftIfMissing(env,{
    title,excerpt,body:[opening,scorerPara,mvpPara,closing].filter(Boolean).join('\n\n'),
    category:'risultati',source_type:'match',source_id:matchId,
    cover_url:winner===match.home_name?match.home_logo:winner===match.away_name?match.away_logo:''
  });
}

async function buildRoundNewsDraft(env,seasonId,roundName){
  const matches=(await env.DB.prepare(`SELECT m.*,ht.name home_name,at.name away_name
    FROM matches m JOIN teams ht ON ht.id=m.home_team_id JOIN teams at ON at.id=m.away_team_id
    WHERE m.season_id=? AND m.round_name=? ORDER BY datetime(m.match_date),m.id`)
    .bind(seasonId,roundName).all()).results;

  if(!matches.length || matches.some(m=>m.status!=='published'))return null;

  const results=matches.map(m=>`${m.home_name} ${m.home_score}-${m.away_score} ${m.away_name}`);
  const tableData=await standings(env,seasonId);
  const leader=tableData.standings?.[0];

  const excerpt=`Tutti i risultati di ${roundName}${leader?` e la nuova capolista ${leader.name}`:''}.`;
  const body=[
    `${roundName} va in archivio con cinque risultati ufficiali che ridisegnano il quadro della settimana Prime League. La giornata si chiude dopo l’approvazione di tutti i referti e la classifica può così aggiornarsi in modo definitivo.`,
    `I risultati:\n${results.map(x=>`• ${x}`).join('\n')}`,
    leader?`${leader.name} chiude il turno davanti a tutti con ${leader.points} punti. La corsa al primo posto continua e ogni giornata diventa sempre più importante.`:'',
    `Gol, assist, presenze, MVP e dati disciplinari sono già aggiornati nelle rispettive sezioni della piattaforma.`
  ].filter(Boolean).join('\n\n');

  return createNewsDraftIfMissing(env,{
    title:`${roundName}: risultati e classifica aggiornata`,
    excerpt,body,category:'campionato',
    source_type:'round',source_id:`${seasonId}:${roundName}`
  });
}

async function buildPlayerNewsDraft(env,playerId){
  const current=await env.DB.prepare(`SELECT id FROM seasons WHERE is_current=1 ORDER BY id DESC LIMIT 1`).first();
  const seasonId=current?.id||null;
  const p=await env.DB.prepare(`SELECT p.*,t.name team_name,t.logo_url team_logo
    FROM players p JOIN teams t ON t.id=p.team_id WHERE p.id=?`).bind(playerId).first();
  if(!p)return null;

  let stats={appearances:0,goals:0,assists:0,mvps:0};
  if(seasonId){
    const row=await env.DB.prepare(`SELECT
      (SELECT COUNT(DISTINCT ml.match_id) FROM match_lineups ml JOIN matches m ON m.id=ml.match_id WHERE ml.player_id=? AND ml.played=1 AND m.status='published' AND m.season_id=?) appearances,
      (SELECT COALESCE(SUM(e.quantity),0) FROM match_events e JOIN matches m ON m.id=e.match_id WHERE e.player_id=? AND e.event_type='goal' AND m.status='published' AND m.season_id=?) goals,
      (SELECT COUNT(*) FROM match_events e JOIN matches m ON m.id=e.match_id WHERE e.assist_player_id=? AND e.event_type='goal' AND m.status='published' AND m.season_id=?) assists,
      (SELECT COUNT(*) FROM matches m WHERE m.mvp_player_id=? AND m.status='published' AND m.season_id=?) mvps`)
      .bind(playerId,seasonId,playerId,seasonId,playerId,seasonId,playerId,seasonId).first();
    stats=row||stats;
  }

  const name=`${p.first_name} ${p.last_name}`;
  const appearances=Number(stats.appearances||0),goals=Number(stats.goals||0),assists=Number(stats.assists||0),mvps=Number(stats.mvps||0);
  const seed=`player:${playerId}:${appearances}:${goals}:${assists}:${mvps}`;
  const metrics=[
    {key:'goals',value:goals,score:goals*3},
    {key:'assists',value:assists,score:assists*3},
    {key:'mvps',value:mvps,score:mvps*4},
    {key:'appearances',value:appearances,score:appearances}
  ].sort((a,b)=>b.score-a.score);
  const focus=metrics[0].value>0?metrics[0].key:'profile';

  const titles={
    goals:[
      `${name}, i gol raccontano il suo impatto con ${p.team_name}`,
      `Dentro i numeri di ${name}: il peso offensivo per ${p.team_name}`,
      `${name} e il feeling con il gol in Prime League`,
      `Focus ${p.team_name}: sotto la lente c’è ${name}`
    ],
    assists:[
      `${name}, il valore dell’ultimo passaggio`,
      `Gli assist di ${name} nel percorso di ${p.team_name}`,
      `${name}: quando il contributo passa anche dai compagni`,
      `Prime League, focus su ${name} e la sua produzione offensiva`
    ],
    mvps:[
      `${name}, le prestazioni che valgono il riconoscimento MVP`,
      `Quando la partita lascia il segno: focus su ${name}`,
      `${name} tra i protagonisti di ${p.team_name}`,
      `MVP e rendimento: i numeri di ${name}`
    ],
    appearances:[
      `${name}, presenza dopo presenza con ${p.team_name}`,
      `Il percorso di ${name} nella stagione Prime League`,
      `${name}: continuità e numeri con ${p.team_name}`,
      `Dentro la stagione di ${name}`
    ],
    profile:[
      `${name}: una storia ancora da scrivere con ${p.team_name}`,
      `Conosciamo ${name}, giocatore di ${p.team_name}`,
      `${name} entra nel racconto della Prime League`,
      `Focus giocatore: ${name}`
    ]
  };
  const title=editorialPick(seed+'title',titles[focus]);

  const openings={
    goals:[
      `${goals} gol sono il dato che salta subito all’occhio guardando la stagione di ${name}. Con la maglia di ${p.team_name}, il suo contributo offensivo è già entrato nei numeri della Prime League.`,
      `Per raccontare fin qui il percorso di ${name} si può partire dalla porta avversaria: ${goals} reti registrate con ${p.team_name}. È il dato più evidente della sua stagione.`,
      `${name} sta costruendo la propria stagione anche attraverso i gol. Il conteggio è arrivato a ${goals}, all’interno del percorso di ${p.team_name}.`
    ],
    assists:[
      `Non ci sono soltanto i gol per misurare un giocatore. Nel caso di ${name}, il dato degli assist — ${assists} — racconta una parte importante del contributo dato a ${p.team_name}.`,
      `${name} ha già lasciato ${assists} assist nel percorso di ${p.team_name}. Un numero che mette in evidenza il contributo alla produzione offensiva della squadra.`,
      `L’ultimo passaggio è uno dei numeri da osservare nella stagione di ${name}: sono ${assists} gli assist registrati fin qui.`
    ],
    mvps:[
      `Essere scelto MVP significa emergere all’interno di una singola partita. ${name} ha già raccolto ${mvps} riconoscimenti di questo tipo con ${p.team_name}.`,
      `Nel percorso di ${name} spiccano ${mvps} premi MVP. Un dato individuale che accompagna la sua stagione con ${p.team_name}.`,
      `${mvps} volte MVP: è da qui che parte il focus dedicato a ${name}, protagonista della stagione di ${p.team_name}.`
    ],
    appearances:[
      `La stagione di ${name} passa prima di tutto dalla continuità: ${appearances} presenze registrate con ${p.team_name}.`,
      `${name} ha preso parte a ${appearances} gare di Prime League. Presenza dopo presenza, prende forma il suo percorso con ${p.team_name}.`,
      `Sono ${appearances} le presenze che raccontano fin qui il cammino di ${name} nella rosa di ${p.team_name}.`
    ],
    profile:[
      `Ogni stagione parte da una pagina bianca. Quella di ${name}, nella rosa di ${p.team_name}, è ancora pronta a riempirsi di numeri e partite.`,
      `${name} fa parte del gruppo di ${p.team_name}. Le statistiche inizieranno a raccontare il suo percorso con il procedere della stagione.`,
      `C’è spazio anche per ${name} nel racconto di ${p.team_name}: il suo percorso Prime League è appena all’inizio.`
    ]
  };

  const opening=editorialPick(seed+'open',openings[focus]);
  const statLine=editorialPick(seed+'stats',[
    `Il quadro completo dice ${appearances} presenze, ${goals} gol, ${assists} assist e ${mvps} MVP.`,
    `Guardando tutti i dati insieme: ${appearances} presenze · ${goals} gol · ${assists} assist · ${mvps} MVP.`,
    `Le statistiche ufficiali registrano finora ${appearances} presenze, con ${goals} reti, ${assists} assist e ${mvps} riconoscimenti MVP.`,
    `Il suo bilancio sulla piattaforma comprende ${appearances} presenze, ${goals} gol, ${assists} assist e ${mvps} premi MVP.`
  ]);
  const closing=editorialPick(seed+'close',[
    `Sono numeri destinati a cambiare con il campionato: ogni nuovo referto approvato aggiornerà automaticamente la sua scheda.`,
    `La fotografia è quella di oggi. Con le prossime giornate, la scheda continuerà ad aggiornarsi insieme alla stagione.`,
    `Il resto lo dirà il campo: la piattaforma continuerà a seguire automaticamente l’evoluzione dei suoi numeri.`,
    `Statistiche in movimento, quindi: ogni presenza e ogni evento ufficiale entreranno direttamente nella sua scheda Prime League.`
  ]);

  return {
    title,
    excerpt:editorialPick(seed+'excerpt',[
      `Numeri, rendimento e percorso: il focus Prime League dedicato a ${name}.`,
      `Uno sguardo alla stagione di ${name} con la maglia di ${p.team_name}.`,
      `Le statistiche raccontano il percorso di ${name}: ecco la fotografia attuale.`,
      `${name} sotto la lente: i dati aggiornati della sua stagione.`
    ]),
    body:[opening,statLine,closing].join('\n\n'),
    category:'giocatori',source_type:'player',source_id:playerId,cover_url:p.photo_url||p.team_logo||''
  };
}

async function buildCompetitionNewsDraft(env,competitionId){
  const c=await env.DB.prepare(`SELECT * FROM custom_competitions WHERE id=?`).bind(competitionId).first();
  if(!c)return null;
  const formatMap={knockout:'eliminazione diretta',groups_knockout:'gironi più fase a eliminazione',round_robin:'girone',single_match:'partita secca',custom:'formula personalizzata'};
  return {
    title:`${c.name}: la nuova competizione Prime League`,
    excerpt:c.description||`Scopri la nuova competizione ${c.name}.`,
    body:[
      c.description||`${c.name} entra nel programma ufficiale Prime League e aggiunge un nuovo obiettivo sportivo alla stagione.`,
      `La competizione sarà organizzata con formula ${formatMap[c.format]||c.format}${c.participant_count?` e coinvolgerà ${c.participant_count} partecipanti`:''}.`,
      c.prize?`In palio ci sarà ${c.prize}, un premio dedicato che renderà il percorso ancora più interessante.`:'',
      c.start_date?`L’inizio è previsto per ${c.start_date}. Tutti gli aggiornamenti saranno pubblicati nella sezione Competizioni.`:''
    ].filter(Boolean).join('\n\n'),
    category:'competizioni',source_type:'competition',source_id:competitionId,cover_url:''
  };
}

async function buildSponsorNewsDraft(env,sponsorId){
  const s=await env.DB.prepare(`SELECT * FROM sponsors WHERE id=?`).bind(sponsorId).first();
  if(!s)return null;
  const promoLive=typeof sponsorPromoLive==='function'?sponsorPromoLive(s):Number(s.promo_active||0)===1;
  return {
    title:`${s.name} entra nella community Prime League`,
    excerpt:s.description||`${s.name} è partner di Prime League.`,
    body:[
      `${s.name} entra nel network dei partner Prime League, affiancando il progetto e la community durante la stagione.`,
      s.description||`La collaborazione permette alla community di conoscere più da vicino l’attività attraverso una vetrina dedicata all’interno della piattaforma.`,
      promoLive&&s.promo_title?`Per la community è inoltre disponibile un Vantaggio Prime League: ${s.promo_title}${s.promo_code?`. Il codice da utilizzare è ${s.promo_code}`:''}.`:'',
      `Nella scheda sponsor sono disponibili riferimenti, social, contatti e tutte le informazioni fornite dall’attività.`
    ].filter(Boolean).join('\n\n'),
    category:'partner',source_type:'sponsor',source_id:sponsorId,cover_url:s.cover_url||s.logo_url||''
  };
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


  if (path === 'public/formula' && method==='GET') {
    const rows=(await env.DB.prepare(`SELECT id,section_key,kicker,title,body,items_json,style,sort_order
      FROM formula_sections WHERE is_active=1 ORDER BY sort_order,id`).all()).results;
    return json({sections:rows.map(r=>({...r,items:safeJsonParse(r.items_json,[])}))});
  }

  if (path === 'admin/formula' && method==='GET') {
    const denied=requireAnyRole(user,'super_admin','organizer'); if(denied)return denied;
    const rows=(await env.DB.prepare(`SELECT * FROM formula_sections ORDER BY sort_order,id`).all()).results;
    return json({sections:rows.map(r=>({...r,items:safeJsonParse(r.items_json,[])}))});
  }

  if (path === 'admin/formula' && method==='POST') {
    const denied=requireAnyRole(user,'super_admin','organizer'); if(denied)return denied;
    const d=await body(request);
    if(!String(d.title||'').trim())return json({error:'Inserisci il titolo'},400);
    const key=String(d.section_key||('section_'+Date.now())).trim();
    const items=Array.isArray(d.items)?d.items:[];
    const r=await env.DB.prepare(`INSERT INTO formula_sections
      (section_key,kicker,title,body,items_json,style,sort_order,is_active)
      VALUES(?,?,?,?,?,?,?,?)`)
      .bind(key,String(d.kicker||'').trim(),String(d.title).trim(),String(d.body||'').trim(),
        JSON.stringify(items),String(d.style||'cards'),Number(d.sort_order||100),d.is_active===false?0:1).run();
    return json({ok:true,id:r.meta.last_row_id},201);
  }

  if (path.match(/^admin\/formula\/\d+$/)) {
    const denied=requireAnyRole(user,'super_admin','organizer'); if(denied)return denied;
    const id=Number(path.split('/').pop());

    if(method==='PUT'){
      const d=await body(request);
      if(!String(d.title||'').trim())return json({error:'Inserisci il titolo'},400);
      const items=Array.isArray(d.items)?d.items:[];
      await env.DB.prepare(`UPDATE formula_sections SET
        kicker=?,title=?,body=?,items_json=?,style=?,sort_order=?,is_active=?,updated_at=CURRENT_TIMESTAMP
        WHERE id=?`)
        .bind(String(d.kicker||'').trim(),String(d.title).trim(),String(d.body||'').trim(),
          JSON.stringify(items),String(d.style||'cards'),Number(d.sort_order||100),
          d.is_active===false?0:1,id).run();
      return json({ok:true});
    }

    if(method==='DELETE'){
      await env.DB.prepare('DELETE FROM formula_sections WHERE id=?').bind(id).run();
      return json({ok:true});
    }
  }


  if (path === 'public/faqs' && method==='GET') {
    const categories=(await env.DB.prepare(`SELECT id,name,icon,sort_order FROM faq_categories WHERE is_active=1 ORDER BY sort_order,name`).all()).results;
    for(const category of categories){
      category.items=(await env.DB.prepare(`SELECT id,question,answer,sort_order FROM faqs WHERE category_id=? AND is_active=1 ORDER BY sort_order,id`).bind(category.id).all()).results;
    }
    return json({categories:categories.filter(c=>c.items.length)});
  }

  if (path === 'admin/faqs' && method==='GET') {
    const denied=requireAnyRole(user,'super_admin','organizer'); if(denied)return denied;
    const categories=(await env.DB.prepare(`SELECT * FROM faq_categories ORDER BY sort_order,name`).all()).results;
    const faqs=(await env.DB.prepare(`SELECT f.*,c.name category_name,c.icon category_icon FROM faqs f JOIN faq_categories c ON c.id=f.category_id ORDER BY c.sort_order,f.sort_order,f.id`).all()).results;
    return json({categories,faqs});
  }

  if (path === 'admin/faqs' && method==='POST') {
    const denied=requireAnyRole(user,'super_admin','organizer'); if(denied)return denied;
    const d=await body(request);
    if(!Number(d.category_id))return json({error:'Seleziona una categoria'},400);
    if(!String(d.question||'').trim())return json({error:'Inserisci la domanda'},400);
    if(!String(d.answer||'').trim())return json({error:'Inserisci la risposta'},400);
    const r=await env.DB.prepare(`INSERT INTO faqs(category_id,question,answer,sort_order,is_active) VALUES(?,?,?,?,?)`)
      .bind(Number(d.category_id),String(d.question).trim(),String(d.answer).trim(),Number(d.sort_order||100),d.is_active===false?0:1).run();
    return json({ok:true,id:r.meta.last_row_id},201);
  }

  if (path.match(/^admin\/faqs\/\d+$/)) {
    const denied=requireAnyRole(user,'super_admin','organizer'); if(denied)return denied;
    const id=Number(path.split('/').pop());
    if(method==='PUT'){
      const d=await body(request);
      await env.DB.prepare(`UPDATE faqs SET category_id=?,question=?,answer=?,sort_order=?,is_active=?,updated_at=CURRENT_TIMESTAMP WHERE id=?`)
        .bind(Number(d.category_id),String(d.question||'').trim(),String(d.answer||'').trim(),Number(d.sort_order||100),d.is_active===false?0:1,id).run();
      return json({ok:true});
    }
    if(method==='DELETE'){
      await env.DB.prepare('DELETE FROM faqs WHERE id=?').bind(id).run();
      return json({ok:true});
    }
  }

  if (path === 'admin/faq-categories' && method==='POST') {
    const denied=requireAnyRole(user,'super_admin','organizer'); if(denied)return denied;
    const d=await body(request);
    if(!String(d.name||'').trim())return json({error:'Inserisci il nome della categoria'},400);
    const r=await env.DB.prepare(`INSERT INTO faq_categories(name,icon,sort_order,is_active) VALUES(?,?,?,?)`)
      .bind(String(d.name).trim(),String(d.icon||'❓').trim()||'❓',Number(d.sort_order||100),d.is_active===false?0:1).run();
    return json({ok:true,id:r.meta.last_row_id},201);
  }

  if (path.match(/^admin\/faq-categories\/\d+$/)) {
    const denied=requireAnyRole(user,'super_admin','organizer'); if(denied)return denied;
    const id=Number(path.split('/').pop());
    if(method==='PUT'){
      const d=await body(request);
      await env.DB.prepare(`UPDATE faq_categories SET name=?,icon=?,sort_order=?,is_active=?,updated_at=CURRENT_TIMESTAMP WHERE id=?`)
        .bind(String(d.name||'').trim(),String(d.icon||'❓').trim()||'❓',Number(d.sort_order||100),d.is_active===false?0:1,id).run();
      return json({ok:true});
    }
    if(method==='DELETE'){
      const used=await env.DB.prepare('SELECT COUNT(*) c FROM faqs WHERE category_id=?').bind(id).first();
      if(Number(used?.c||0)>0)return json({error:'La categoria contiene ancora FAQ'},409);
      await env.DB.prepare('DELETE FROM faq_categories WHERE id=?').bind(id).run();
      return json({ok:true});
    }
  }

  if (path === 'public/home') return json(await publicDashboard(env));

  if (path === 'public/competitions' && method==='GET') {
    try{
      const seasonIdParam=new URL(request.url).searchParams.get('season');
      const tableData=await standings(env,seasonIdParam?Number(seasonIdParam):null);
      const season=tableData.selectedSeason;

      if(!season){
        return json({
          season:null,
          seasons:tableData.seasons||[],
          standings:[],
          regular:{total:0,completed:0,finished:false,champion:null},
          mini_tournament:{status:'not_started',semifinals:[],final:null,winner:null,qualified:[]}
        });
      }

      const regularCounts=await env.DB.prepare(`SELECT
        COUNT(*) total,
        COALESCE(SUM(CASE WHEN m.status='published' THEN 1 ELSE 0 END),0) completed
        FROM matches m
        LEFT JOIN match_schedule_meta meta ON meta.match_id=m.id
        WHERE m.season_id=?
          AND COALESCE(meta.phase,'regular')='regular'`)
        .bind(season.id).first();

      const phaseRows=(await env.DB.prepare(`SELECT
        m.*,
        ht.name home_name,ht.logo_url home_logo,
        at.name away_name,at.logo_url away_logo,
        COALESCE(meta.phase,
          CASE
            WHEN lower(COALESCE(m.round_name,'')) LIKE '%semifinale%' THEN 'semifinal'
            WHEN lower(COALESCE(m.round_name,'')) LIKE '%finale%' THEN 'final'
            ELSE 'regular'
          END
        ) phase
        FROM matches m
        JOIN teams ht ON ht.id=m.home_team_id
        JOIN teams at ON at.id=m.away_team_id
        LEFT JOIN match_schedule_meta meta ON meta.match_id=m.id
        WHERE m.season_id=?
        ORDER BY datetime(m.match_date),m.id`).bind(season.id).all()).results;

      const semifinals=phaseRows.filter(row=>row.phase==='semifinal');
      const finalMatch=phaseRows.find(row=>row.phase==='final')||null;

      const total=Number(regularCounts?.total||0);
      const completed=Number(regularCounts?.completed||0);
      const regularFinished=total>0&&total===completed;
      const champion=regularFinished&&tableData.standings?.length
        ? tableData.standings[0]
        : null;

      let miniStatus='not_started';
      if(semifinals.length)miniStatus='semifinals';
      if(semifinals.length>=2&&semifinals.every(match=>match.status==='published'))
        miniStatus='awaiting_final';
      if(finalMatch)
        miniStatus=finalMatch.status==='published'?'completed':'final';

      let miniWinner=null;
      if(
        finalMatch &&
        finalMatch.status==='published' &&
        Number(finalMatch.home_score)!==Number(finalMatch.away_score)
      ){
        const homeWon=Number(finalMatch.home_score)>Number(finalMatch.away_score);
        miniWinner={
          id:homeWon?finalMatch.home_team_id:finalMatch.away_team_id,
          name:homeWon?finalMatch.home_name:finalMatch.away_name,
          logo_url:homeWon?finalMatch.home_logo:finalMatch.away_logo
        };
      }

      const customCompetitions=(await env.DB.prepare(`SELECT *
        FROM custom_competitions
        WHERE season_id=? AND is_public=1
        ORDER BY sort_order,id`).bind(season.id).all()).results;

      return json({
        season,
        seasons:tableData.seasons||[],
        standings:tableData.standings||[],
        regular:{
          total,
          completed,
          finished:regularFinished,
          champion
        },
        mini_tournament:{
          status:miniStatus,
          semifinals,
          final:finalMatch,
          winner:miniWinner,
          qualified:(tableData.standings||[]).slice(1,5)
        },
        custom_competitions:customCompetitions.map(mapCustomCompetition)
      });
    }catch(error){
      console.error('public/competitions failed',error);
      return json({
        error:'Impossibile caricare la sezione Competizioni',
        detail:error?.message||String(error)
      },500);
    }
  }


  if (path === 'admin/competitions' && method==='POST') {
    const denied=requireAnyRole(user,'super_admin','organizer'); if(denied)return denied;
    const d=await body(request);

    if(!Number(d.season_id))return json({error:'Seleziona una stagione'},400);
    if(!String(d.name||'').trim())return json({error:'Inserisci il nome della competizione'},400);

    const allowedTypes=['cup','supercup','tournament','friendly','other'];
    const allowedFormats=['knockout','groups_knockout','round_robin','single_match','custom'];
    const allowedStatus=['planned','open','in_progress','completed','cancelled'];

    let base=slugify(d.name)||`competizione-${Date.now()}`;
    let slug=base,n=2;
    while(await env.DB.prepare('SELECT id FROM custom_competitions WHERE slug=?').bind(slug).first()){
      slug=`${base}-${n++}`;
    }

    const result=await env.DB.prepare(`INSERT INTO custom_competitions(
      season_id,name,slug,competition_type,format,description,status,
      start_date,end_date,participant_count,prize,is_public,sort_order
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(
      Number(d.season_id),
      String(d.name).trim(),
      slug,
      allowedTypes.includes(d.competition_type)?d.competition_type:'cup',
      allowedFormats.includes(d.format)?d.format:'knockout',
      String(d.description||'').trim(),
      allowedStatus.includes(d.status)?d.status:'planned',
      d.start_date||null,
      d.end_date||null,
      d.participant_count?Number(d.participant_count):null,
      String(d.prize||'').trim(),
      d.is_public===false?0:1,
      Number(d.sort_order||100)
    ).run();

    await audit(env,user.id,'create','competition',result.meta.last_row_id,d);
    return json({ok:true,id:result.meta.last_row_id,slug},201);
  }

  if (path.match(/^admin\/competitions\/\d+$/)) {
    const denied=requireAnyRole(user,'super_admin','organizer'); if(denied)return denied;
    const id=Number(path.split('/').pop());

    if(method==='PUT'){
      const d=await body(request);
      if(!Number(d.season_id))return json({error:'Seleziona una stagione'},400);
      if(!String(d.name||'').trim())return json({error:'Inserisci il nome della competizione'},400);

      const existing=await env.DB.prepare('SELECT * FROM custom_competitions WHERE id=?').bind(id).first();
      if(!existing)return json({error:'Competizione non trovata'},404);

      const allowedTypes=['cup','supercup','tournament','friendly','other'];
      const allowedFormats=['knockout','groups_knockout','round_robin','single_match','custom'];
      const allowedStatus=['planned','open','in_progress','completed','cancelled'];

      let base=slugify(d.name)||`competizione-${id}`;
      let slug=base,n=2;
      while(await env.DB.prepare('SELECT id FROM custom_competitions WHERE slug=? AND id<>?')
        .bind(slug,id).first()){
        slug=`${base}-${n++}`;
      }

      await env.DB.prepare(`UPDATE custom_competitions SET
        season_id=?,name=?,slug=?,competition_type=?,format=?,description=?,status=?,
        start_date=?,end_date=?,participant_count=?,prize=?,is_public=?,sort_order=?,
        updated_at=CURRENT_TIMESTAMP
        WHERE id=?`).bind(
          Number(d.season_id),
          String(d.name).trim(),
          slug,
          allowedTypes.includes(d.competition_type)?d.competition_type:'cup',
          allowedFormats.includes(d.format)?d.format:'knockout',
          String(d.description||'').trim(),
          allowedStatus.includes(d.status)?d.status:'planned',
          d.start_date||null,
          d.end_date||null,
          d.participant_count?Number(d.participant_count):null,
          String(d.prize||'').trim(),
          d.is_public===false?0:1,
          Number(d.sort_order||100),
          id
        ).run();

      await audit(env,user.id,'update','competition',id,d);
      return json({ok:true,slug});
    }

    if(method==='DELETE'){
      await env.DB.prepare('DELETE FROM custom_competitions WHERE id=?').bind(id).run();
      await audit(env,user.id,'delete','competition',id,{});
      return json({ok:true});
    }
  }

  if (path === 'admin/competitions' && method==='GET') {
    const denied=requireAnyRole(user,'super_admin','organizer'); if(denied)return denied;

    try{
      const seasonIdParam=new URL(request.url).searchParams.get('season');
      const tableData=await standings(env,seasonIdParam?Number(seasonIdParam):null);
      const season=tableData.selectedSeason;

      if(!season){
        return json({
          season:null,
          seasons:tableData.seasons||[],
          standings:[],
          phases:[],
          mini_matches:[]
        });
      }

      const phases=(await env.DB.prepare(`SELECT
        COALESCE(msm.phase,
          CASE
            WHEN lower(COALESCE(m.round_name,'')) LIKE '%semifinale%' THEN 'semifinal'
            WHEN lower(COALESCE(m.round_name,'')) LIKE '%finale%' THEN 'final'
            ELSE 'regular'
          END
        ) phase,
        COUNT(*) total,
        COALESCE(SUM(CASE WHEN m.status='published' THEN 1 ELSE 0 END),0) completed
        FROM matches m
        LEFT JOIN match_schedule_meta msm ON msm.match_id=m.id
        WHERE m.season_id=?
        GROUP BY COALESCE(msm.phase,
          CASE
            WHEN lower(COALESCE(m.round_name,'')) LIKE '%semifinale%' THEN 'semifinal'
            WHEN lower(COALESCE(m.round_name,'')) LIKE '%finale%' THEN 'final'
            ELSE 'regular'
          END
        )`).bind(season.id).all()).results;

      const miniMatches=(await env.DB.prepare(`SELECT
        m.*,
        ht.name home_name,ht.logo_url home_logo,
        at.name away_name,at.logo_url away_logo,
        COALESCE(msm.phase,
          CASE
            WHEN lower(COALESCE(m.round_name,'')) LIKE '%semifinale%' THEN 'semifinal'
            WHEN lower(COALESCE(m.round_name,'')) LIKE '%finale%' THEN 'final'
            ELSE 'regular'
          END
        ) phase
        FROM matches m
        JOIN teams ht ON ht.id=m.home_team_id
        JOIN teams at ON at.id=m.away_team_id
        LEFT JOIN match_schedule_meta msm ON msm.match_id=m.id
        WHERE m.season_id=?
          AND COALESCE(msm.phase,
            CASE
              WHEN lower(COALESCE(m.round_name,'')) LIKE '%semifinale%' THEN 'semifinal'
              WHEN lower(COALESCE(m.round_name,'')) LIKE '%finale%' THEN 'final'
              ELSE 'regular'
            END
          ) IN ('semifinal','final')
        ORDER BY
          CASE COALESCE(msm.phase,
            CASE
              WHEN lower(COALESCE(m.round_name,'')) LIKE '%semifinale%' THEN 'semifinal'
              WHEN lower(COALESCE(m.round_name,'')) LIKE '%finale%' THEN 'final'
              ELSE 'regular'
            END
          ) WHEN 'semifinal' THEN 1 ELSE 2 END,
          datetime(m.match_date),m.id`).bind(season.id).all()).results;

      const customCompetitions=(await env.DB.prepare(`SELECT *
        FROM custom_competitions WHERE season_id=?
        ORDER BY sort_order,id`).bind(season.id).all()).results;

      return json({
        season,
        seasons:tableData.seasons||[],
        standings:tableData.standings||[],
        phases,
        mini_matches:miniMatches,
        custom_competitions:customCompetitions.map(mapCustomCompetition)
      });
    }catch(error){
      console.error('admin/competitions failed',error);
      return json({
        error:'Impossibile caricare Competizioni nell’Admin',
        detail:error?.message||String(error)
      },500);
    }
  }

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
  if (path === 'public/player-appearances') {
    const seasonId=new URL(request.url).searchParams.get('season');
    const seasonFilter=seasonId?'AND m.season_id=?':'';
    const params=seasonId?[Number(seasonId)]:[];
    const rows=await env.DB.prepare(`SELECT
      p.id,p.first_name,p.last_name,p.slug,p.photo_url,p.shirt_number,p.role,
      t.name team_name,t.logo_url team_logo,
      COALESCE(SUM(CASE WHEN ml.is_called=1 THEN 1 ELSE 0 END),0) callups,
      COALESCE(SUM(CASE WHEN ml.played=1 THEN 1 ELSE 0 END),0) appearances,
      COALESCE(SUM(CASE WHEN ml.played=1 AND ml.lineup_role='starter' THEN 1 ELSE 0 END),0) starts,
      COALESCE(SUM(CASE WHEN ml.played=1 AND ml.lineup_role='reserve' THEN 1 ELSE 0 END),0) substitute_appearances,
      COALESCE(SUM(CASE WHEN ml.played=0 AND ml.lineup_role='reserve' AND ml.is_called=1 THEN 1 ELSE 0 END),0) unused_bench
      FROM players p
      JOIN teams t ON t.id=p.team_id
      LEFT JOIN match_lineups ml ON ml.player_id=p.id
      LEFT JOIN matches m ON m.id=ml.match_id ${seasonFilter}
      GROUP BY p.id
      ORDER BY appearances DESC,starts DESC,p.last_name`).bind(...params).all();
    return json({players:rows.results});
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
    const rows = await env.DB.prepare('SELECT * FROM news WHERE is_published=1 ORDER BY is_featured DESC,published_at DESC').all();
    return json({news:rows.results});
  }

  if (path.startsWith('public/news/') && method==='GET') {
    const slug=decodeURIComponent(path.split('/').pop());
    const article=await env.DB.prepare(`SELECT * FROM news WHERE slug=? AND is_published=1 LIMIT 1`).bind(slug).first();
    if(!article)return json({error:'Articolo non trovato'},404);

    const related=(await env.DB.prepare(`SELECT id,title,slug,excerpt,cover_url,published_at,category
      FROM news
      WHERE is_published=1 AND id<>?
      ORDER BY
        CASE WHEN category=? THEN 0 ELSE 1 END,
        published_at DESC
      LIMIT 3`).bind(article.id,article.category||'campionato').all()).results;

    return json({article,related});
  }
  if (path === 'public/polls' && method==='GET') {
    const rawToken=String(request.headers.get('x-prime-voter')||'').trim();
    const voterHash=rawToken.length>=32?await voteHash(`pl-voter:${rawToken}`):'';

    const polls=(await env.DB.prepare(`SELECT p.*,
      (SELECT COUNT(*) FROM anonymous_poll_votes v WHERE v.poll_id=p.id) votes_count
      FROM polls p
      WHERE p.status IN ('open','closed')
        AND datetime(p.starts_at)<=datetime('now')
      ORDER BY
        CASE WHEN p.status='open' AND datetime(p.ends_at)>=datetime('now') THEN 0 ELSE 1 END,
        datetime(p.ends_at) DESC`).all()).results;

    for(const poll of polls){
      poll.is_open=poll.status==='open' && new Date(poll.ends_at).getTime()>=Date.now();
      poll.options=(await env.DB.prepare(`SELECT o.*,
        (SELECT COUNT(*) FROM anonymous_poll_votes v WHERE v.option_id=o.id) votes
        FROM poll_options o WHERE o.poll_id=? ORDER BY o.id`).bind(poll.id).all()).results;

      poll.user_voted=false;
      poll.selected_option_id=null;
      if(voterHash){
        const previous=await env.DB.prepare(`SELECT option_id FROM anonymous_poll_votes
          WHERE poll_id=? AND voter_hash=? LIMIT 1`).bind(poll.id,voterHash).first();
        if(previous){
          poll.user_voted=true;
          poll.selected_option_id=previous.option_id;
        }
      }
    }
    return json({polls});
  }

  if (path === 'public/vote' && method==='POST') {
    const data=await body(request);
    const rawToken=String(data.voter_token||request.headers.get('x-prime-voter')||'').trim();
    if(rawToken.length<32)return json({error:'Sessione di voto non valida. Ricarica la pagina.'},400);

    const option=await env.DB.prepare(`SELECT o.id,o.poll_id,p.status,p.starts_at,p.ends_at
      FROM poll_options o JOIN polls p ON p.id=o.poll_id WHERE o.id=?`)
      .bind(Number(data.option_id)).first();

    if(!option)return json({error:'Opzione non valida'},400);
    const now=Date.now();
    if(option.status!=='open'||new Date(option.starts_at).getTime()>now||new Date(option.ends_at).getTime()<now)
      return json({error:'Questa votazione non è disponibile'},400);

    const ip=request.headers.get('CF-Connecting-IP')||request.headers.get('X-Forwarded-For')||'unknown';
    const browser=[
      request.headers.get('User-Agent')||'',
      request.headers.get('Accept-Language')||'',
      request.headers.get('Sec-CH-UA-Platform')||''
    ].join('|');

    const voterHash=await voteHash(`pl-voter:${rawToken}`);
    const ipHash=await voteHash(`pl-ip:${ip}`);
    const browserHash=await voteHash(`pl-browser:${browser}`);

    // Protezione contro votazioni automatizzate, senza penalizzare facilmente
    // utenti diversi collegati alla stessa rete di casa o del campo.
    const networkVotes=await env.DB.prepare(`SELECT COUNT(*) c FROM anonymous_poll_votes
      WHERE poll_id=? AND ip_hash=?`).bind(option.poll_id,ipHash).first();
    if(Number(networkVotes?.c||0)>=100)
      return json({error:'Limite di sicurezza raggiunto per questa rete'},429);

    const existingVote=await env.DB.prepare(`SELECT id FROM anonymous_poll_votes
      WHERE poll_id=? AND voter_hash=? LIMIT 1`).bind(option.poll_id,voterHash).first();
    if(existingVote)return json({error:'Hai già votato in questa votazione'},409);

    try{
      await env.DB.prepare(`INSERT INTO anonymous_poll_votes
        (poll_id,option_id,voter_hash,ip_hash,user_agent_hash,browser_hash)
        VALUES(?,?,?,?,?,?)`)
        .bind(option.poll_id,option.id,voterHash,ipHash,browserHash,browserHash).run();
    }catch(error){
      console.error('Anonymous vote insert failed',error);
      return json({
        error:'Impossibile registrare il voto. Riprova tra qualche secondo.',
        detail:error?.message||String(error)
      },500);
    }
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
    if(teamIds.length!==10){
      return json({error:'Il calendario automatico 2 + 2 + 1 è configurato per 10 squadre. Seleziona esattamente 10 squadre.'},400);
    }
    const marketBreakDays=Math.max(0,Number(d.market_break_days||20));
    const rounds=roundRobin(teamIds);
    const returnRounds=rounds.map(r=>r.map(([h,a])=>[a,h]));
    const all=[];
    let cursor=parseLocalDate(d.start_date);
    let lastFirstLegMatch=null;

    for(let i=0;i<rounds.length;i++){
      const sch=schedulePrimeLeagueRound(rounds[i],cursor);
      sch.games.forEach(g=>all.push({round_name:`${i+1}ª Giornata`,home:g.pair[0],away:g.pair[1],date:g.date,phase:'regular'}));
      lastFirstLegMatch=sch.games[sch.games.length-1].date;
      cursor=sch.nextWeek;
    }

    // Pausa mercato calcolata dall'ultima partita del girone di andata.
    const restartBase=new Date(lastFirstLegMatch || cursor);
    restartBase.setDate(restartBase.getDate()+marketBreakDays+1);
    cursor=restartBase;

    for(let i=0;i<returnRounds.length;i++){
      const sch=schedulePrimeLeagueRound(returnRounds[i],cursor);
      sch.games.forEach(g=>all.push({round_name:`${rounds.length+i+1}ª Giornata`,home:g.pair[0],away:g.pair[1],date:g.date,phase:'regular'}));
      cursor=sch.nextWeek;
    }
    if(d.end_date){ const end=parseLocalDate(d.end_date); if(all.some(x=>x.date>end)) return json({error:'Il periodo indicato è troppo breve per completare il campionato con una giornata a settimana. Estendi la data finale.'},400); }
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
    if(method==='GET') {
      const matches=(await env.DB.prepare(`SELECT m.*,ht.name home_name,ht.logo_url home_logo,at.name away_name,at.logo_url away_logo,
        COALESCE(msm.phase,'regular') phase,
        COALESCE(msm.schedule_status,CASE WHEN m.status='published' THEN 'completed' WHEN m.status='postponed' THEN 'postponed' ELSE 'scheduled' END) schedule_status,
        COALESCE(msm.manually_modified,0) manually_modified,msm.notes schedule_notes,
        mr.referee_user_id,u.display_name referee_name,u.email referee_email
        FROM matches m
        JOIN teams ht ON ht.id=m.home_team_id
        JOIN teams at ON at.id=m.away_team_id
        LEFT JOIN match_schedule_meta msm ON msm.match_id=m.id
        LEFT JOIN match_referees mr ON mr.match_id=m.id
        LEFT JOIN users u ON u.id=mr.referee_user_id
        ORDER BY m.match_date DESC`).all()).results;
      const seasons=(await env.DB.prepare('SELECT * FROM seasons ORDER BY is_current DESC,start_date DESC,id DESC').all()).results;
      const referees=(await env.DB.prepare(`SELECT u.id,u.display_name,u.email
        FROM users u LEFT JOIN auth_roles ar ON ar.user_id=u.id
        WHERE u.is_active=1 AND COALESCE(ar.role,u.role)='referee'
        ORDER BY u.display_name`).all()).results;
      return json({matches,seasons,referees});
    }
    if(method==='POST') {
      const d=await body(request);
      const result=await env.DB.prepare('INSERT INTO matches(season_id,round_name,home_team_id,away_team_id,match_date,venue,status) VALUES(?,?,?,?,?,?,?)')
        .bind(Number(d.season_id||1),d.round_name||'',Number(d.home_team_id),Number(d.away_team_id),d.match_date,d.venue||'',d.status||'scheduled').run();
      if(d.referee_user_id){
        await env.DB.prepare(`INSERT INTO match_referees(match_id,referee_user_id,assigned_by_user_id,updated_at)
          VALUES(?,?,?,CURRENT_TIMESTAMP)
          ON CONFLICT(match_id) DO UPDATE SET referee_user_id=excluded.referee_user_id,assigned_by_user_id=excluded.assigned_by_user_id,updated_at=CURRENT_TIMESTAMP`)
          .bind(result.meta.last_row_id,Number(d.referee_user_id),user.id).run();
      }
      await audit(env,user.id,'create','match',result.meta.last_row_id,d);
      return json({ok:true,id:result.meta.last_row_id},201);
    }
  }
  if (path.match(/^admin\/matches\/\d+$/) && method==='PUT') {
    const denied=requireAnyRole(user,'super_admin','organizer'); if(denied)return denied; const id=Number(path.split('/').pop()); const d=await body(request);
    await env.DB.prepare('UPDATE matches SET round_name=?,home_team_id=?,away_team_id=?,match_date=?,venue=?,status=?,home_score=?,away_score=?,highlights_url=?,mvp_player_id=?,updated_at=CURRENT_TIMESTAMP WHERE id=?').bind(d.round_name||'',Number(d.home_team_id),Number(d.away_team_id),d.match_date,d.venue||'',d.status||'scheduled',d.home_score===''?null:Number(d.home_score),d.away_score===''?null:Number(d.away_score),d.highlights_url||'',d.mvp_player_id?Number(d.mvp_player_id):null,id).run();
    const scheduleStatus=['scheduled','postponed','suspended','recovery','cancelled','completed'].includes(d.schedule_status)?d.schedule_status:(d.status==='published'?'completed':d.status==='postponed'?'postponed':'scheduled');
    const phase=['regular','playoff','semifinal','final'].includes(d.phase)?d.phase:'regular';
    await env.DB.prepare(`INSERT INTO match_schedule_meta(match_id,phase,schedule_status,manually_modified,notes,updated_at) VALUES(?,?,?,1,?,CURRENT_TIMESTAMP) ON CONFLICT(match_id) DO UPDATE SET phase=excluded.phase,schedule_status=excluded.schedule_status,manually_modified=1,notes=excluded.notes,updated_at=CURRENT_TIMESTAMP`).bind(id,phase,scheduleStatus,d.schedule_notes||'').run();
    if(d.referee_user_id){
      await env.DB.prepare(`INSERT INTO match_referees(match_id,referee_user_id,assigned_by_user_id,updated_at)
        VALUES(?,?,?,CURRENT_TIMESTAMP)
        ON CONFLICT(match_id) DO UPDATE SET referee_user_id=excluded.referee_user_id,assigned_by_user_id=excluded.assigned_by_user_id,updated_at=CURRENT_TIMESTAMP`)
        .bind(id,Number(d.referee_user_id),user.id).run();
    }else{
      await env.DB.prepare('DELETE FROM match_referees WHERE match_id=?').bind(id).run();
    }
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
        (SELECT s.admin_note FROM match_submissions s WHERE s.match_id=m.id AND s.submitted_by_user_id=? ORDER BY s.created_at DESC LIMIT 1) admin_note,
        (SELECT json_extract(s.notes,'$.lineup') FROM match_submissions s WHERE s.match_id=m.id AND s.submitted_by_user_id=? ORDER BY s.created_at DESC LIMIT 1) submission_lineup_json
        FROM matches m
        JOIN teams ht ON ht.id=m.home_team_id
        JOIN teams at ON at.id=m.away_team_id
        JOIN match_referees mr ON mr.match_id=m.id
        WHERE mr.referee_user_id=?
        ORDER BY m.match_date DESC`).bind(user.id,user.id,user.id,user.id,user.id,user.id,user.id)
      : env.DB.prepare(`SELECT m.*,ht.name home_name,ht.logo_url home_logo,at.name away_name,at.logo_url away_logo,
        (SELECT s.status FROM match_submissions s WHERE s.match_id=m.id AND s.team_id=? ORDER BY s.created_at DESC LIMIT 1) submission_status,
        (SELECT s.home_score FROM match_submissions s WHERE s.match_id=m.id AND s.team_id=? ORDER BY s.created_at DESC LIMIT 1) submission_home_score,
        (SELECT s.away_score FROM match_submissions s WHERE s.match_id=m.id AND s.team_id=? ORDER BY s.created_at DESC LIMIT 1) submission_away_score,
        (SELECT s.events_json FROM match_submissions s WHERE s.match_id=m.id AND s.team_id=? ORDER BY s.created_at DESC LIMIT 1) submission_events_json,
        (SELECT s.notes FROM match_submissions s WHERE s.match_id=m.id AND s.team_id=? ORDER BY s.created_at DESC LIMIT 1) submission_notes,
        (SELECT s.admin_note FROM match_submissions s WHERE s.match_id=m.id AND s.team_id=? ORDER BY s.created_at DESC LIMIT 1) admin_note,
        (SELECT json_extract(s.notes,'$.lineup') FROM match_submissions s WHERE s.match_id=m.id AND s.team_id=? ORDER BY s.created_at DESC LIMIT 1) submission_lineup_json
        FROM matches m JOIN teams ht ON ht.id=m.home_team_id JOIN teams at ON at.id=m.away_team_id
        WHERE m.home_team_id=? OR m.away_team_id=? ORDER BY m.match_date DESC`)
        .bind(user.team_id,user.team_id,user.team_id,user.team_id,user.team_id,user.team_id,user.team_id,user.team_id,user.team_id);
    const rows=await q.all(); return json({matches:rows.results});
  }
  if (path.match(/^referee\/matches\/\d+\/report-data$/) && method==='GET') {
    const denied=requireAnyRole(user,'referee'); if(denied)return denied;
    const id=Number(path.split('/')[2]);
    const match=await env.DB.prepare(`SELECT m.* FROM matches m
      JOIN match_referees mr ON mr.match_id=m.id
      WHERE m.id=? AND mr.referee_user_id=?`).bind(id,user.id).first();
    if(!match)return json({error:'Partita non trovata'},404);
    const players=await env.DB.prepare(`SELECT id,team_id,first_name,last_name,shirt_number,role FROM players WHERE team_id IN (?,?) AND is_active=1 ORDER BY team_id,last_name`).bind(match.home_team_id,match.away_team_id).all();
    return json({match,players:players.results});
  }

  if (path === 'team/submissions' && method==='POST') {
    const denied=requireAnyRole(user,'team_manager','referee'); if(denied)return denied; const d=await body(request);
    const match=hasRole(user,'referee')
      ? await env.DB.prepare(`SELECT m.* FROM matches m JOIN match_referees mr ON mr.match_id=m.id
          WHERE m.id=? AND mr.referee_user_id=?`).bind(Number(d.match_id),user.id).first()
      : await env.DB.prepare('SELECT * FROM matches WHERE id=? AND (home_team_id=? OR away_team_id=?)').bind(Number(d.match_id),user.team_id,user.team_id).first();
    if(!match)return json({error:'Partita non valida'},400);
    const submissionTeamId=hasRole(user,'referee')?match.home_team_id:user.team_id;
    await env.DB.prepare("UPDATE match_submissions SET status='superseded' WHERE match_id=? AND submitted_by_user_id=? AND status IN ('pending','rejected')").bind(match.id,user.id).run();
    const normalizedLineup=Array.isArray(d.lineup)?d.lineup.map(x=>({
      team_id:Number(x.team_id),
      player_id:Number(x.player_id),
      is_called:x.is_called===false?0:1,
      lineup_role:x.lineup_role==='starter'?'starter':'reserve',
      played:x.played?1:0
    })).filter(x=>x.team_id&&x.player_id):[];
    const notesPayload=JSON.stringify({
      text:d.notes||'',
      mvp_player_id:d.mvp_player_id?Number(d.mvp_player_id):null,
      lineup:normalizedLineup
    });
    const result=await env.DB.prepare('INSERT INTO match_submissions(match_id,submitted_by_user_id,team_id,home_score,away_score,events_json,notes) VALUES(?,?,?,?,?,?,?)').bind(match.id,user.id,submissionTeamId,Number(d.home_score),Number(d.away_score),JSON.stringify(d.events||[]),notesPayload).run();
    await audit(env,user.id,'submit','match_submission',result.meta.last_row_id,d); return json({ok:true,id:result.meta.last_row_id},201);
  }


  if (path === 'referee/dashboard' && method==='GET') {
    const denied=requireAnyRole(user,'referee'); if(denied)return denied;
    const [nextMatch,counts,recent] = await Promise.all([
      env.DB.prepare(`SELECT m.*,ht.name home_name,ht.logo_url home_logo,at.name away_name,at.logo_url away_logo
        FROM matches m JOIN match_referees mr ON mr.match_id=m.id
        JOIN teams ht ON ht.id=m.home_team_id JOIN teams at ON at.id=m.away_team_id
        WHERE mr.referee_user_id=? AND m.status!='published' AND datetime(m.match_date)>=datetime('now')
        ORDER BY datetime(m.match_date) LIMIT 1`).bind(user.id).first(),
      env.DB.prepare(`SELECT
        COUNT(*) assigned,
        COALESCE(SUM(CASE WHEN m.status='published' THEN 1 ELSE 0 END),0) completed,
        COALESCE(SUM(CASE WHEN m.status!='published' AND datetime(m.match_date)>=datetime('now') THEN 1 ELSE 0 END),0) upcoming,
        COALESCE(SUM(CASE WHEN s.status='pending' THEN 1 ELSE 0 END),0) pending
        FROM match_referees mr
        JOIN matches m ON m.id=mr.match_id
        LEFT JOIN match_submissions s ON s.match_id=m.id AND s.submitted_by_user_id=?
        WHERE mr.referee_user_id=?`).bind(user.id,user.id).first(),
      env.DB.prepare(`SELECT m.*,ht.name home_name,at.name away_name
        FROM matches m JOIN match_referees mr ON mr.match_id=m.id
        JOIN teams ht ON ht.id=m.home_team_id JOIN teams at ON at.id=m.away_team_id
        WHERE mr.referee_user_id=? AND m.status='published'
        ORDER BY datetime(m.match_date) DESC LIMIT 5`).bind(user.id).all()
    ]);
    return json({next_match:nextMatch,counts:counts||{},recent:recent.results||[]});
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

  if (path.match(/^admin\/matches\/\d+\/official-lineup$/) && method==='GET') {
    const denied=requireAnyRole(user,'super_admin','organizer'); if(denied)return denied;
    const matchId=Number(path.split('/')[2]);
    const rows=await env.DB.prepare(`SELECT ml.*,p.first_name,p.last_name,p.shirt_number,p.role,t.name team_name
      FROM match_lineups ml
      JOIN players p ON p.id=ml.player_id
      JOIN teams t ON t.id=ml.team_id
      WHERE ml.match_id=?
      ORDER BY ml.team_id,CASE ml.lineup_role WHEN 'starter' THEN 0 ELSE 1 END,p.shirt_number,p.last_name`).bind(matchId).all();
    return json({lineup:rows.results});
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

      // LINEUP / DISTINTA:
      // same player across multiple reports is not duplicated.
      // called/played use OR logic; starter prevails over reserve.
      const lineupMap=new Map();
      for(const sub of approved){
        let meta={};
        try{meta=JSON.parse(sub.notes||'{}')||{}}catch{meta={}}
        const rows=Array.isArray(meta.lineup)?meta.lineup:[];
        for(const row of rows){
          const teamId=Number(row.team_id);
          const playerId=Number(row.player_id);
          if(!teamId||!playerId)continue;
          const key=`${teamId}:${playerId}`;
          const current=lineupMap.get(key)||{
            team_id:teamId,
            player_id:playerId,
            is_called:0,
            lineup_role:'reserve',
            played:0,
            source_submission_id:sub.id
          };
          current.is_called=Math.max(current.is_called,row.is_called===false?0:1);
          if(row.lineup_role==='starter')current.lineup_role='starter';
          current.played=Math.max(current.played,row.played?1:0);
          current.source_submission_id=sub.id;
          lineupMap.set(key,current);
        }
      }

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
      await env.DB.prepare('DELETE FROM match_lineups WHERE match_id=?').bind(s.match_id).run();

      for(const row of lineupMap.values()){
        await env.DB.prepare(`INSERT INTO match_lineups
          (match_id,team_id,player_id,is_called,lineup_role,played,source_submission_id,updated_at)
          VALUES(?,?,?,?,?,?,?,CURRENT_TIMESTAMP)`)
          .bind(s.match_id,row.team_id,row.player_id,row.is_called,row.lineup_role,row.played,row.source_submission_id).run();
      }

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

      // NEWS AUTOMATION:
      // match draft is created only once; if all matches of the round are complete,
      // a round-summary draft is also created.
      try{
        await buildMatchNewsDraft(env,s.match_id);
        const officialMatch=await env.DB.prepare(`SELECT season_id,round_name FROM matches WHERE id=?`).bind(s.match_id).first();
        if(officialMatch?.round_name){
          await buildRoundNewsDraft(env,officialMatch.season_id,officialMatch.round_name);
        }
      }catch(newsError){
        console.error('automatic news draft failed',newsError);
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


  if (path === 'public/sponsors' && method==='GET') {
    const rows=(await env.DB.prepare(`SELECT s.*,t.name team_name
      FROM sponsors s LEFT JOIN teams t ON t.id=s.team_id
      WHERE s.is_active=1
      ORDER BY s.is_featured DESC,s.sort_order,s.name`).all()).results;
    return json({sponsors:rows.map(mapSponsorRow)});
  }

  if (path.startsWith('public/sponsor/') && method==='GET') {
    const slug=decodeURIComponent(path.split('/').pop());
    const row=await env.DB.prepare(`SELECT s.*,t.name team_name
      FROM sponsors s LEFT JOIN teams t ON t.id=s.team_id
      WHERE s.slug=? AND s.is_active=1`).bind(slug).first();
    if(!row)return json({error:'Sponsor non trovato'},404);
    return json({sponsor:mapSponsorRow(row)});
  }

  if (path === 'admin/sponsors' && method==='GET') {
    const denied=requireAnyRole(user,'super_admin','organizer'); if(denied)return denied;
    const rows=(await env.DB.prepare(`SELECT s.*,t.name team_name
      FROM sponsors s LEFT JOIN teams t ON t.id=s.team_id
      ORDER BY s.is_featured DESC,s.sort_order,s.name`).all()).results;
    return json({sponsors:rows.map(mapSponsorRow)});
  }

  if (path === 'admin/sponsors' && method==='POST') {
    const denied=requireAnyRole(user,'super_admin','organizer'); if(denied)return denied;
    const d=await body(request);
    if(!String(d.name||'').trim())return json({error:'Inserisci il nome dello sponsor'},400);

    let base=slugify(d.slug||d.name)||`sponsor-${Date.now()}`;
    let slug=base,n=2;
    while(await env.DB.prepare('SELECT id FROM sponsors WHERE slug=?').bind(slug).first())slug=`${base}-${n++}`;

    const result=await env.DB.prepare(`INSERT INTO sponsors(
      name,slug,logo_url,cover_url,category,logo_bg,partner_tier,description,
      phone,whatsapp,email,address,website_url,google_url,
      instagram_url,facebook_url,tiktok_url,gallery_json,
      promo_active,promo_title,promo_description,promo_code,promo_terms,promo_start,promo_end,
      level,team_id,is_featured,is_active,sort_order,updated_at
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,CURRENT_TIMESTAMP)`)
      .bind(
        String(d.name).trim(),slug,d.logo_url||'',d.cover_url||'',d.category||'',d.logo_bg||'light',
        d.partner_tier||'partner',d.description||'',d.phone||'',d.whatsapp||'',d.email||'',
        d.address||'',d.website_url||'',d.google_url||'',d.instagram_url||'',d.facebook_url||'',
        d.tiktok_url||'',JSON.stringify(Array.isArray(d.gallery)?d.gallery:[]),
        d.promo_active?1:0,d.promo_title||'',d.promo_description||'',d.promo_code||'',d.promo_terms||'',
        d.promo_start||null,d.promo_end||null,
        d.level==='team'?'team':'league',
        d.level==='team'&&d.team_id?Number(d.team_id):null,
        d.is_featured?1:0,d.is_active===false?0:1,Number(d.sort_order||100)
      ).run();
    await audit(env,user.id,'create','sponsor',result.meta.last_row_id,d);
    return json({ok:true,id:result.meta.last_row_id,slug},201);
  }

  if (path.match(/^admin\/sponsors\/\d+$/)) {
    const denied=requireAnyRole(user,'super_admin','organizer'); if(denied)return denied;
    const id=Number(path.split('/').pop());

    if(method==='PUT'){
      const d=await body(request);
      if(!String(d.name||'').trim())return json({error:'Inserisci il nome dello sponsor'},400);
      const existing=await env.DB.prepare('SELECT * FROM sponsors WHERE id=?').bind(id).first();
      if(!existing)return json({error:'Sponsor non trovato'},404);

      let base=slugify(d.slug||d.name)||`sponsor-${id}`;
      let slug=base,n=2;
      while(await env.DB.prepare('SELECT id FROM sponsors WHERE slug=? AND id<>?').bind(slug,id).first())slug=`${base}-${n++}`;

      await env.DB.prepare(`UPDATE sponsors SET
        name=?,slug=?,logo_url=?,cover_url=?,category=?,logo_bg=?,partner_tier=?,description=?,
        phone=?,whatsapp=?,email=?,address=?,website_url=?,google_url=?,
        instagram_url=?,facebook_url=?,tiktok_url=?,gallery_json=?,
        promo_active=?,promo_title=?,promo_description=?,promo_code=?,promo_terms=?,promo_start=?,promo_end=?,
        level=?,team_id=?,is_featured=?,is_active=?,sort_order=?,updated_at=CURRENT_TIMESTAMP
        WHERE id=?`)
        .bind(
          String(d.name).trim(),slug,d.logo_url||'',d.cover_url||'',d.category||'',d.logo_bg||'light',
          d.partner_tier||'partner',d.description||'',d.phone||'',d.whatsapp||'',d.email||'',
          d.address||'',d.website_url||'',d.google_url||'',d.instagram_url||'',d.facebook_url||'',
          d.tiktok_url||'',JSON.stringify(Array.isArray(d.gallery)?d.gallery:[]),
          d.promo_active?1:0,d.promo_title||'',d.promo_description||'',d.promo_code||'',d.promo_terms||'',
          d.promo_start||null,d.promo_end||null,
          d.level==='team'?'team':'league',
          d.level==='team'&&d.team_id?Number(d.team_id):null,
          d.is_featured?1:0,d.is_active===false?0:1,Number(d.sort_order||100),id
        ).run();
      await audit(env,user.id,'update','sponsor',id,d);
      return json({ok:true,slug});
    }

    if(method==='DELETE'){
      await env.DB.prepare('DELETE FROM sponsors WHERE id=?').bind(id).run();
      await audit(env,user.id,'delete','sponsor',id,{});
      return json({ok:true});
    }
  }

  if (path === 'team/sponsors' || path.match(/^team\/sponsors\/\d+$/)) {
    return json({error:'La gestione sponsor è riservata all’Admin'},403);
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


  if (path === 'admin/news/setup-data' && method==='GET') {
    const denied=requireAnyRole(user,'super_admin','organizer'); if(denied)return denied;

    const [matches,players,competitions,sponsors,seasons]=await Promise.all([
      env.DB.prepare(`SELECT m.id,m.season_id,m.round_name,m.match_date,m.home_score,m.away_score,
        ht.name home_name,at.name away_name
        FROM matches m JOIN teams ht ON ht.id=m.home_team_id JOIN teams at ON at.id=m.away_team_id
        WHERE m.status='published'
        ORDER BY datetime(m.match_date) DESC LIMIT 100`).all(),
      env.DB.prepare(`SELECT p.id,p.first_name,p.last_name,t.name team_name
        FROM players p JOIN teams t ON t.id=p.team_id
        WHERE p.is_active=1 ORDER BY p.last_name,p.first_name`).all(),
      env.DB.prepare(`SELECT id,season_id,name,status,competition_type,format
        FROM custom_competitions ORDER BY id DESC`).all(),
      env.DB.prepare(`SELECT id,name,category,promo_active,promo_title
        FROM sponsors WHERE is_active=1 ORDER BY name`).all(),
      env.DB.prepare(`SELECT * FROM seasons ORDER BY is_current DESC,start_date DESC,id DESC`).all()
    ]);

    const rounds=[...new Map(matches.results.map(m=>[
      `${m.season_id}:${m.round_name}`,
      {id:`${m.season_id}:${m.round_name}`,season_id:m.season_id,round_name:m.round_name}
    ])).values()];

    return json({
      matches:matches.results,
      rounds,
      players:players.results,
      competitions:competitions.results,
      sponsors:sponsors.results,
      seasons:seasons.results
    });
  }

  if (path === 'admin/news/generate-draft' && method==='POST') {
    const denied=requireAnyRole(user,'super_admin','organizer'); if(denied)return denied;
    const d=await body(request);
    const type=String(d.source_type||'').trim();
    let draft=null;

    if(type==='match'){
      const id=await buildMatchNewsDraft(env,Number(d.source_id));
      if(!id)return json({error:'La partita deve essere conclusa e pubblicata'},400);
      return json({ok:true,id,created:true});
    }

    if(type==='round'){
      const [seasonId,...roundParts]=String(d.source_id||'').split(':');
      const roundName=roundParts.join(':');
      if(!seasonId||!roundName)return json({error:'Giornata non valida'},400);
      const id=await buildRoundNewsDraft(env,Number(seasonId),roundName);
      if(!id)return json({error:'La giornata non è ancora completamente conclusa'},400);
      return json({ok:true,id,created:true});
    }

    if(type==='player')draft=await buildPlayerNewsDraft(env,Number(d.source_id));
    if(type==='competition')draft=await buildCompetitionNewsDraft(env,Number(d.source_id));
    if(type==='sponsor')draft=await buildSponsorNewsDraft(env,Number(d.source_id));
    if(!draft)return json({error:'Impossibile generare la bozza dalla fonte selezionata'},400);

    const id=await createNewsDraftIfMissing(env,draft);
    return json({ok:true,id,created:true});
  }

  if (path === 'admin/news') {
    const denied=requireAnyRole(user,'super_admin','organizer'); if(denied)return denied;
    if(method==='GET') return json({news:(await env.DB.prepare(`SELECT * FROM news ORDER BY is_published ASC,created_at DESC`).all()).results});
    if(method==='POST') {
      const d=await body(request);
      const result=await env.DB.prepare(`INSERT INTO news
        (title,slug,excerpt,body,cover_url,is_published,published_at,category,source_type,source_id,is_featured,auto_generated)
        VALUES(?,?,?,?,?,?,CASE WHEN ?=1 THEN CURRENT_TIMESTAMP ELSE NULL END,?,?,?,?,?)`)
        .bind(d.title,slugify(d.slug||d.title),d.excerpt||'',d.body||'',d.cover_url||'',
          d.is_published?1:0,d.is_published?1:0,d.category||'campionato',d.source_type||'manual',
          d.source_id||null,d.is_featured?1:0,d.auto_generated?1:0).run();
      await audit(env,user.id,'create','news',result.meta.last_row_id,d);
      return json({ok:true,id:result.meta.last_row_id},201);
    }
  }
  if (path === 'admin/polls/setup-data' && method==='GET') {
    const denied=requireAnyRole(user,'super_admin','organizer'); if(denied)return denied;
    const matches=(await env.DB.prepare(`SELECT m.id,m.match_date,m.round_name,m.status,m.home_score,m.away_score,
      ht.name home_name,at.name away_name,
      (SELECT COUNT(*) FROM match_lineups ml WHERE ml.match_id=m.id AND ml.played=1) played_count
      FROM matches m
      JOIN teams ht ON ht.id=m.home_team_id
      JOIN teams at ON at.id=m.away_team_id
      WHERE m.status='published'
      ORDER BY datetime(m.match_date) DESC`).all()).results;
    return json({matches});
  }

  if (path.match(/^admin\/polls\/matches\/\d+\/players$/) && method==='GET') {
    const denied=requireAnyRole(user,'super_admin','organizer'); if(denied)return denied;
    const matchId=Number(path.split('/')[3]);
    const match=await env.DB.prepare(`SELECT m.id,m.home_team_id,m.away_team_id,m.match_date,m.round_name,
      ht.name home_name,at.name away_name
      FROM matches m JOIN teams ht ON ht.id=m.home_team_id JOIN teams at ON at.id=m.away_team_id
      WHERE m.id=?`).bind(matchId).first();
    if(!match)return json({error:'Partita non trovata'},404);
    const players=(await env.DB.prepare(`SELECT p.id,p.first_name,p.last_name,p.photo_url,p.shirt_number,p.role,
      p.team_id,t.name team_name,t.logo_url team_logo,ml.lineup_role
      FROM match_lineups ml
      JOIN players p ON p.id=ml.player_id
      JOIN teams t ON t.id=ml.team_id
      WHERE ml.match_id=? AND ml.played=1
      ORDER BY ml.team_id,p.last_name,p.first_name`).bind(matchId).all()).results;
    return json({match,players});
  }

  if (path === 'admin/polls') {
    const denied=requireAnyRole(user,'super_admin','organizer'); if(denied)return denied;
    if(method==='GET') {
      const polls=(await env.DB.prepare(`SELECT p.*,
        m.home_score,m.away_score,ht.name home_name,at.name away_name,m.match_date,
        (SELECT COUNT(*) FROM anonymous_poll_votes v WHERE v.poll_id=p.id) votes_count
        FROM polls p
        LEFT JOIN matches m ON m.id=p.match_id
        LEFT JOIN teams ht ON ht.id=m.home_team_id
        LEFT JOIN teams at ON at.id=m.away_team_id
        ORDER BY p.created_at DESC`).all()).results;
      for(const p of polls)p.options=(await env.DB.prepare(`SELECT o.*,
        (SELECT COUNT(*) FROM anonymous_poll_votes v WHERE v.option_id=o.id) votes
        FROM poll_options o WHERE o.poll_id=? ORDER BY o.id`).bind(p.id).all()).results;
      return json({polls});
    }
    if(method==='POST') {
      const d=await body(request);
      const type=['mvp','custom','goal','save'].includes(d.poll_type)?d.poll_type:'custom';
      const matchId=d.match_id?Number(d.match_id):null;
      let options=Array.isArray(d.options)?d.options:[];
      let title=String(d.title||'').trim();
      let description=String(d.description||'').trim();

      if(type==='mvp'){
        if(!matchId)return json({error:'Seleziona la partita per la votazione MVP'},400);
        const match=await env.DB.prepare(`SELECT m.*,ht.name home_name,at.name away_name
          FROM matches m JOIN teams ht ON ht.id=m.home_team_id JOIN teams at ON at.id=m.away_team_id
          WHERE m.id=? AND m.status='published'`).bind(matchId).first();
        if(!match)return json({error:'La partita selezionata non è conclusa'},400);
        const eligible=(await env.DB.prepare(`SELECT p.id,p.first_name,p.last_name,p.photo_url,p.team_id
          FROM match_lineups ml JOIN players p ON p.id=ml.player_id
          WHERE ml.match_id=? AND ml.played=1 ORDER BY p.last_name`).bind(matchId).all()).results;
        const selectedIds=new Set(options.map(o=>Number(o.player_id)).filter(Boolean));
        const selected=eligible.filter(p=>selectedIds.has(Number(p.id)));
        if(selected.length<2)return json({error:'Seleziona almeno due giocatori che hanno partecipato alla partita'},400);
        options=selected.map(p=>({
          label:`${p.first_name} ${p.last_name}`,
          player_id:p.id,team_id:p.team_id,image_url:p.photo_url||''
        }));
        title=title||`MVP · ${match.home_name} - ${match.away_name}`;
        description=description||'Scegli il miglior giocatore della partita.';
      }else{
        if(!title)return json({error:'Inserisci il titolo della votazione'},400);
        options=options.filter(o=>String(o.label||'').trim());
        if(options.length<2)return json({error:'Inserisci almeno due opzioni'},400);
      }

      const status=['draft','open','closed'].includes(d.status)?d.status:'open';
      const startsAt=d.starts_at||new Date().toISOString().slice(0,19);
      const endsAt=d.ends_at;
      if(!endsAt)return json({error:'Inserisci la data di chiusura'},400);

      const r=await env.DB.prepare(`INSERT INTO polls
        (title,description,poll_type,starts_at,ends_at,status,match_id)
        VALUES(?,?,?,?,?,?,?)`)
        .bind(title,description,type,startsAt,endsAt,status,matchId).run();

      for(const o of options)await env.DB.prepare(`INSERT INTO poll_options
        (poll_id,label,image_url,player_id,team_id) VALUES(?,?,?,?,?)`)
        .bind(r.meta.last_row_id,String(o.label).trim(),o.image_url||'',o.player_id?Number(o.player_id):null,o.team_id?Number(o.team_id):null).run();

      await audit(env,user.id,'create','poll',r.meta.last_row_id,d);
      return json({ok:true,id:r.meta.last_row_id},201);
    }
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
    if(method==='PUT'){
      await env.DB.prepare(`UPDATE news SET
        title=?,slug=?,excerpt=?,body=?,cover_url=?,is_published=?,
        published_at=CASE WHEN ?=1 THEN COALESCE(published_at,CURRENT_TIMESTAMP) ELSE NULL END,
        category=?,is_featured=?,updated_at=CURRENT_TIMESTAMP
        WHERE id=?`)
        .bind(safeText(d.title),slugify(d.slug||d.title),d.excerpt||'',d.body||'',d.cover_url||'',
          d.is_published?1:0,d.is_published?1:0,d.category||'campionato',d.is_featured?1:0,id).run();
      await audit(env,user.id,'update','news',id,d);return json({ok:true});
    }
    if(method==='DELETE'){await env.DB.prepare('DELETE FROM news WHERE id=?').bind(id).run();await audit(env,user.id,'delete','news',id,{});return json({ok:true});}
  }
  if (path.match(/^admin\/polls\/\d+$/)) {
    const denied=requireAnyRole(user,'super_admin','organizer'); if(denied)return denied; const id=Number(path.split('/').pop()); const d=method==='PUT'?await body(request):{};
    if(method==='PUT'){
      const type=['mvp','custom','goal','save'].includes(d.poll_type)?d.poll_type:'custom';
      const matchId=d.match_id?Number(d.match_id):null;
      let options=Array.isArray(d.options)?d.options:[];
      let title=String(d.title||'').trim();
      let description=String(d.description||'').trim();

      if(type==='mvp'){
        if(!matchId)return json({error:'Seleziona una partita'},400);
        const match=await env.DB.prepare(`SELECT m.*,ht.name home_name,at.name away_name
          FROM matches m JOIN teams ht ON ht.id=m.home_team_id JOIN teams at ON at.id=m.away_team_id
          WHERE m.id=? AND m.status='published'`).bind(matchId).first();
        if(!match)return json({error:'Partita non valida'},400);
        const eligible=(await env.DB.prepare(`SELECT p.id,p.first_name,p.last_name,p.photo_url,p.team_id
          FROM match_lineups ml JOIN players p ON p.id=ml.player_id
          WHERE ml.match_id=? AND ml.played=1`).bind(matchId).all()).results;
        const selectedIds=new Set(options.map(o=>Number(o.player_id)).filter(Boolean));
        const selected=eligible.filter(p=>selectedIds.has(Number(p.id)));
        if(selected.length<2)return json({error:'Seleziona almeno due giocatori'},400);
        options=selected.map(p=>({label:`${p.first_name} ${p.last_name}`,player_id:p.id,team_id:p.team_id,image_url:p.photo_url||''}));
        title=title||`MVP · ${match.home_name} - ${match.away_name}`;
        description=description||'Scegli il miglior giocatore della partita.';
      }else{
        if(!title)return json({error:'Inserisci il titolo'},400);
        options=options.filter(o=>String(o.label||'').trim());
        if(options.length<2)return json({error:'Inserisci almeno due opzioni'},400);
      }

      await env.DB.prepare(`UPDATE polls SET title=?,description=?,poll_type=?,starts_at=?,ends_at=?,status=?,match_id=? WHERE id=?`)
        .bind(title,description,type,d.starts_at,d.ends_at,d.status||'open',matchId,id).run();
      await env.DB.prepare('DELETE FROM votes WHERE poll_id=?').bind(id).run();
      await env.DB.prepare('DELETE FROM anonymous_poll_votes WHERE poll_id=?').bind(id).run();
      await env.DB.prepare('DELETE FROM poll_options WHERE poll_id=?').bind(id).run();
      for(const o of options)await env.DB.prepare(`INSERT INTO poll_options
        (poll_id,label,image_url,player_id,team_id) VALUES(?,?,?,?,?)`)
        .bind(id,String(o.label).trim(),o.image_url||'',o.player_id?Number(o.player_id):null,o.team_id?Number(o.team_id):null).run();
      await audit(env,user.id,'update','poll',id,d);
      return json({ok:true});
    }
    if(method==='DELETE'){await env.DB.prepare('DELETE FROM votes WHERE poll_id=?').bind(id).run();await env.DB.prepare('DELETE FROM anonymous_poll_votes WHERE poll_id=?').bind(id).run();await env.DB.prepare('DELETE FROM poll_options WHERE poll_id=?').bind(id).run();await env.DB.prepare('DELETE FROM polls WHERE id=?').bind(id).run();await audit(env,user.id,'delete','poll',id,{});return json({ok:true});}
  }

  return json({ error:'Endpoint non trovato', path },404);
}

export async function onRequest(context) {
  const path = context.params.path ? (Array.isArray(context.params.path) ? context.params.path.join('/') : context.params.path) : '';
  try { await ensureAuthSchema(context.env); await ensureCalendarSchema(context.env); await ensureAnonymousVoteSchema(context.env); await ensureFaqSchema(context.env); await ensureSponsorProfileSchema(context.env); await ensureFormulaSchema(context.env); await ensureCustomCompetitionsSchema(context.env); await ensureNewsAutomationSchema(context.env); return await route(context.request, context.env, path); }
  catch (error) { console.error(error); return json({ error:'Errore interno', detail:error.message },500); }
}
