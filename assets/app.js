const app = document.querySelector('#app');
ensureMediaStyles();
const state = { user:null, teams:[], players:[] };

const esc = (v='') => String(v ?? '').replace(/[&<>'"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]));
const fmtDate = (v) => v ? new Intl.DateTimeFormat('it-IT',{day:'2-digit',month:'short',year:'numeric',hour:'2-digit',minute:'2-digit'}).format(new Date(v)) : 'Da definire';
const api = async (path, options={}) => {
  const res = await fetch(`/api/${path}`, {headers:{'content-type':'application/json',...(options.headers||{})},...options});
  const data = await res.json().catch(()=>({}));
  if(!res.ok) throw new Error(data.error || 'Errore');
  return data;
};

async function prepareImageFile(file,maxDimension=1400){
  if(!file)return null;
  if(!['image/jpeg','image/png','image/webp'].includes(file.type))throw new Error('Sono ammessi solo file PNG, JPG o WEBP');
  if(file.size>5*1024*1024)throw new Error('Il file supera il limite di 5 MB');
  const bitmap=await createImageBitmap(file);
  const scale=Math.min(1,maxDimension/Math.max(bitmap.width,bitmap.height));
  const width=Math.max(1,Math.round(bitmap.width*scale));
  const height=Math.max(1,Math.round(bitmap.height*scale));
  const canvas=document.createElement('canvas');
  canvas.width=width;canvas.height=height;
  const ctx=canvas.getContext('2d',{alpha:true});
  ctx.drawImage(bitmap,0,0,width,height);
  bitmap.close?.();
  const blob=await new Promise((resolve,reject)=>canvas.toBlob(b=>b?resolve(b):reject(new Error('Impossibile elaborare l’immagine')),'image/webp',0.86));
  const clean=(file.name||'immagine').replace(/\.[^.]+$/,'').replace(/[^a-zA-Z0-9_-]+/g,'-');
  return new File([blob],`${clean||'immagine'}.webp`,{type:'image/webp'});
}
async function uploadMediaFile(file,category,oldUrl='',maxDimension=1400){
  if(!file)return oldUrl||'';
  const prepared=await prepareImageFile(file,maxDimension);
  const form=new FormData();
  form.append('file',prepared);
  form.append('category',category);
  if(oldUrl)form.append('old_url',oldUrl);
  const res=await fetch('/api/admin/media/upload',{method:'POST',body:form});
  const data=await res.json().catch(()=>({}));
  if(!res.ok)throw new Error(data.error||'Errore durante il caricamento');
  return data.url;
}
function mediaPicker({name='media_file',current='',label='Immagine',shape='square'}={}){
  return `<div class="pl-upload-block">
    <div class="pl-upload-title">
      <div>
        <strong>${esc(label)}</strong>
        <span>Carica un file direttamente dal dispositivo.</span>
      </div>
      <em>PNG · JPG · WEBP</em>
    </div>
    <div class="pl-upload-body ${shape}">
      <div class="pl-upload-preview">${current?`<img src="${esc(current)}" alt="Anteprima">`:`<div class="pl-upload-empty"><b>+</b><span>Nessuna immagine</span></div>`}</div>
      <div class="pl-upload-info">
        <h4>${current?'Immagine attuale':'Nessuna immagine caricata'}</h4>
        <p>${shape==='logo'?'Per lo stemma usa preferibilmente un file quadrato con sfondo trasparente.':'Usa una foto nitida e ben centrata.'}</p>
        <div class="pl-upload-actions">
          <label class="btn pl-file-button">Scegli file<input type="file" name="${esc(name)}" accept=".png,.jpg,.jpeg,.webp,image/png,image/jpeg,image/webp"></label>
          ${current?'<button class="btn small danger remove-media" type="button">Rimuovi immagine</button>':''}
        </div>
        <small>Massimo 5 MB. Il file verrà ottimizzato automaticamente.</small>
      </div>
    </div>
    <input type="hidden" name="existing_media_url" value="${esc(current)}">
    <input type="hidden" name="remove_media" value="0">
  </div>`;
}
function bindMediaPicker(form){
  form.querySelectorAll('.pl-upload-block').forEach(field=>{
    const input=field.querySelector('input[type="file"]');
    const preview=field.querySelector('.pl-upload-preview');
    const remove=field.querySelector('.remove-media');
    const removeFlag=field.querySelector('[name="remove_media"]');
    input?.addEventListener('change',()=>{
      const file=input.files?.[0];if(!file)return;
      if(!['image/jpeg','image/png','image/webp'].includes(file.type)){input.value='';return alert('Seleziona un file PNG, JPG o WEBP')}
      if(file.size>5*1024*1024){input.value='';return alert('Il file supera il limite di 5 MB')}
      const url=URL.createObjectURL(file);
      preview.innerHTML=`<img src="${url}" alt="Anteprima">`;
      removeFlag.value='0';
    });
    remove?.addEventListener('click',()=>{
      input.value='';removeFlag.value='1';
      preview.innerHTML='<div class="media-placeholder"><b>+</b><span>Nessuna immagine</span></div>';
      remove.remove();
    });
  });
}

const initials = (name='PL') => name.split(' ').slice(0,2).map(x=>x[0]).join('').toUpperCase();
const logo = (url,name) => url ? `<img class="logo" src="${esc(url)}" alt="${esc(name)}">` : `<div class="logo">${esc(initials(name))}</div>`;
const avatar = (url,name) => url ? `<img class="avatar" src="${esc(url)}" alt="${esc(name)}">` : `<div class="avatar">${esc(initials(name))}</div>`;

function ensureMediaStyles(){if(!document.querySelector('link[data-prime-media]')){const l=document.createElement('link');l.rel='stylesheet';l.href='/assets/media-admin.css';l.dataset.primeMedia='1';document.head.appendChild(l)}}
function layout(content, active='home'){
  const nav = [['home','Home'],['partite','Partite'],['classifica','Classifica'],['squadre','Squadre'],['giocatori','Giocatori'],['statistiche','Statistiche'],['vota','Vota'],['news','News']];
  const mobile = [['home','⌂','Home'],['partite','⚽','Partite'],['classifica','🏆','Classifica'],['squadre','◫','Squadre'],[state.user?'dashboard':'login','◉',state.user?'Area':'Accedi']];
  return `<div class="shell">
    <div class="league-strip" id="live-strip"><div><span>PRIME LEAGUE</span><span>Stagione 2026/27</span></div><div><a href="#/news">News</a><a href="#/vota">Votazioni</a></div></div>
    <header class="topbar"><a class="brand" href="#/home"><img class="brand-crest" src="/assets/prime-league-crest.png" alt="Logo Prime League"><span>PRIME LEAGUE<small>IL CALCIO DEL TERRITORIO</small></span></a>
    <nav class="nav">${nav.map(([r,l])=>`<a class="${active===r?'active':''}" href="#/${r}">${l}</a>`).join('')}<a class="nav-login" href="#/${state.user?'dashboard':'login'}">${state.user?'Dashboard':'Accedi'}</a></nav></header>
    <main class="container">${content}</main>
    <nav class="mobile-nav">${mobile.map(([r,i,l])=>`<a class="${active===r?'active':''}" href="#/${r}"><b>${i}</b>${l}</a>`).join('')}</nav>
    <div class="brand-marquee" aria-hidden="true"><div class="brand-marquee-track">${Array.from({length:10},()=>`<span><img src="/assets/prime-league-crest.png" alt=""> PRIME LEAGUE</span>`).join('')}</div></div>
    <footer class="footer mega-footer"><div class="footer-grid">
      <div class="footer-brand"><div class="footer-logo-lockup"><img src="/assets/prime-league-crest.png" alt="Prime League"><strong>PRIME LEAGUE</strong></div><p>Il calcio del territorio, in una nuova dimensione.</p><div class="social-row">
        <a href="#" aria-label="Instagram" title="Instagram"><svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="5"></rect><circle cx="12" cy="12" r="4.2"></circle><circle class="social-fill" cx="17.5" cy="6.5" r="1.15"></circle></svg></a>
        <a href="#" aria-label="Facebook" title="Facebook"><svg viewBox="0 0 24 24" aria-hidden="true"><path class="social-fill" d="M13.6 21v-8h2.7l.4-3h-3.1V8.1c0-.9.3-1.6 1.6-1.6H17V3.8c-.5-.1-1.4-.2-2.5-.2-2.5 0-4.2 1.5-4.2 4.3V10H7.5v3h2.8v8h3.3Z"></path></svg></a>
        <a href="#" aria-label="TikTok" title="TikTok"><svg viewBox="0 0 24 24" aria-hidden="true"><path class="social-fill" d="M15 3c.4 2.2 1.7 3.5 4 3.7v3.1a8.3 8.3 0 0 1-4-1.2v6.1a6 6 0 1 1-5.2-5.9v3.2a2.9 2.9 0 1 0 2 2.7V3H15Z"></path></svg></a>
        <a href="#" aria-label="YouTube" title="YouTube"><svg viewBox="0 0 24 24" aria-hidden="true"><path class="social-fill" d="M21 8.1a3 3 0 0 0-2.1-2.2C17.1 5.4 12 5.4 12 5.4s-5.1 0-6.9.5A3 3 0 0 0 3 8.1a31 31 0 0 0-.5 3.9c0 1.3.2 2.6.5 3.9a3 3 0 0 0 2.1 2.2c1.8.5 6.9.5 6.9.5s5.1 0 6.9-.5a3 3 0 0 0 2.1-2.2c.3-1.3.5-2.6.5-3.9s-.2-2.6-.5-3.9ZM10 15.2V8.8l5.5 3.2-5.5 3.2Z"></path></svg></a>
      </div></div>
      <div><h4>Campionato</h4><a href="#/squadre">Squadre</a><a href="#/giocatori">Giocatori</a><a href="#/partite">Partite</a><a href="#/classifica">Classifica</a></div>
      <div><h4>Prime League</h4><a href="#/statistiche">Statistiche</a><a href="#/vota">Votazioni</a><a href="#/news">Notizie</a><a href="#/home">Sponsor</a></div>
      <div><h4>Informazioni</h4><a href="#/home">Regolamento</a><a href="#/home">Come si gioca</a><a href="#/home">Contatti</a><a href="#/login">Area riservata</a></div>
    </div><div class="footer-bottom"><span>© 2026 Prime League. Tutti i diritti riservati.</span><div><a href="#/home">Avviso legale</a><a href="#/home">Privacy e cookie</a><a href="#/home">Segnalazioni</a></div></div></footer>
  </div>`;
}
function set(content,active){app.innerHTML=layout(content,active);window.scrollTo(0,0)}
function loading(){app.innerHTML='<div class="loader"></div>'}
function message(text,type='notice'){return `<div class="notice ${type}">${esc(text)}</div>`}

function matchCard(m){
  const score = m.status==='published' ? `${m.home_score} - ${m.away_score}` : 'VS';
  return `<a class="card match-card-link" href="#/partita/${m.id}"><div class="match"><div class="team-side">${logo(m.home_logo,m.home_name)}<span>${esc(m.home_name)}</span></div><div class="score">${score}</div><div class="team-side away"><span>${esc(m.away_name)}</span>${logo(m.away_logo,m.away_name)}</div></div><div class="meta">${esc(m.round_name||'')} · ${fmtDate(m.match_date)}${m.venue?' · '+esc(m.venue):''}</div><div class="match-card-cta">Apri scheda partita →</div></a>`;
}
function standingsTable(rows){return `<div class="table-wrap"><table class="table"><thead><tr><th>#</th><th>Squadra</th><th>PG</th><th>V</th><th>N</th><th>P</th><th>GF</th><th>GS</th><th>DR</th><th>Pt</th></tr></thead><tbody>${rows.map((t,i)=>`<tr><td class="rank">${i+1}</td><td><a href="#/squadra/${t.slug}"><b>${esc(t.name)}</b></a></td><td>${t.played}</td><td>${t.won}</td><td>${t.drawn}</td><td>${t.lost}</td><td>${t.gf}</td><td>${t.ga}</td><td>${t.gd}</td><td><b>${t.points}</b></td></tr>`).join('')}</tbody></table></div>`}

async function home(){loading();const [d,statsData,teamsData]=await Promise.all([api('public/home'),api('public/stats'),api('public/teams')]);
  const homeTeams = teamsData.teams || [];
  const next=d.next?.[0];
  const recent=d.recent?.[0];
  const compactStandings=d.standings.slice(0,6);
  const quickMatches=[...(d.next||[]).slice(0,3),...(d.recent||[]).slice(0,2)];
  const statRows=(rows=[])=>rows.slice(0,3);
  const emptyPlayer={first_name:'Giocatore',last_name:'',team_name:'Squadra',photo_url:'',team_logo:'',slug:'',value:0};
  const padRows=(rows=[])=>[...rows,...Array(Math.max(0,3-rows.length)).fill(emptyPlayer)].slice(0,3);
  const statPanel=(type,title,rows,unit,extra='')=>{
    const safe=padRows(rows);
    const lead=safe[0];
    return `<article class="stat-feature ${type}">
      <div class="stat-visual">
        <div class="stat-title">${extra}<span>${esc(title)}</span></div>
        <div class="stat-lead-photo">${lead.photo_url?`<img src="${esc(lead.photo_url)}" alt="${esc(lead.first_name+' '+lead.last_name)}">`:`<div class="player-silhouette"><span>${esc(initials(lead.first_name+' '+lead.last_name))}</span></div>`}</div>
        <div class="stat-lead-meta"><span>${esc(lead.team_name)}</span><strong>${esc(lead.first_name)} ${esc(lead.last_name)}</strong></div>
      </div>
      <div class="stat-ranking">${safe.map((p,i)=>`<a class="stat-row" href="${p.slug?`#/giocatore/${p.slug}`:'#/statistiche'}">
        <span class="stat-rank">${i+1}</span>${logo(p.team_logo,p.team_name)}
        <strong>${esc(p.first_name)} ${esc(p.last_name)}</strong><b>${p.value||0}</b>${unit==='cards'?`<span class="card-dots"><i></i><em></em></span>`:`<small>${unit}</small>`}
      </a>`).join('')}</div><a class="stat-more" href="#/statistiche">Vedi altro</a>
    </article>`;
  };
  set(`<section class="season-hero">
    <div class="season-copy"><img class="hero-crest" src="/assets/prime-league-crest.png" alt=""><span class="eyebrow light">Stagione ufficiale 2026/27</span><h1>Prime League</h1><p>Partite, risultati, classifiche e protagonisti. Tutto il campionato in un unico posto.</p><div class="hero-actions"><a class="btn white" href="#/partite">Calendario</a><a class="btn glass" href="#/classifica">Classifica</a></div></div>
    ${next?`<article class="hero-match"><div class="hero-match-top"><span>${esc(next.round_name||'Prossima giornata')}</span><span>${fmtDate(next.match_date)}</span></div><div class="hero-clubs"><div>${logo(next.home_logo,next.home_name)}<strong>${esc(next.home_name)}</strong></div><div class="hero-vs"><b>VS</b><small>${esc(next.venue||'Campo da definire')}</small></div><div>${logo(next.away_logo,next.away_name)}<strong>${esc(next.away_name)}</strong></div></div><a href="#/partita/${next.id}">Dettagli partita →</a></article>`:'<article class="hero-match empty">Nessuna partita programmata.</article>'}
  </section>

  ${next?`<section class="countdown-section" data-kickoff="${esc(next.match_date)}"><div class="countdown-overlay"></div><div class="countdown-content"><span>${esc(next.round_name||'Prossima giornata')}</span><h2>Prossima giornata</h2><div class="countdown-grid"><div><b id="cd-days">00</b><small>Giorni</small></div><div><b id="cd-hours">00</b><small>Ore</small></div><div><b id="cd-minutes">00</b><small>Minuti</small></div><div><b id="cd-seconds">00</b><small>Secondi</small></div></div></div></section>`:''}

  <section class="score-ribbon">
    <div class="score-ribbon-head"><strong>Partite</strong><a href="#/partite">Vedi calendario completo</a></div>
    <div class="score-scroll">${quickMatches.length?quickMatches.map(m=>`<article class="mini-match"><div><span>${esc(m.round_name||'Prime League')}</span><small>${fmtDate(m.match_date)}</small></div><div class="mini-score"><b>${esc(initials(m.home_name))}</b><strong>${m.status==='published'?m.home_score:'-'}</strong><span>${esc(m.home_name)}</span></div><div class="mini-score"><b>${esc(initials(m.away_name))}</b><strong>${m.status==='published'?m.away_score:'-'}</strong><span>${esc(m.away_name)}</span></div></article>`).join(''):'<div class="empty">Nessuna partita disponibile.</div>'}</div>
  </section>

  <section class="dashboard-grid">
    <div class="panel standings-panel"><div class="panel-head"><div><span class="eyebrow">Campionato</span><h2>Classifica</h2></div><a href="#/classifica">Classifica completa →</a></div>
      <div class="league-table">${compactStandings.length?compactStandings.map((t,i)=>`<a class="league-row" href="#/squadra/${t.slug}"><span class="position ${i<3?'top':''}">${i+1}</span>${logo(t.logo_url,t.name)}<strong>${esc(t.name)}</strong><span class="form-pill">${t.played} PG</span><b>${t.points}</b></a>`).join(''):'<div class="empty">Classifica non disponibile.</div>'}</div>
    </div>
    <div class="side-stack">
      <div class="panel"><div class="panel-head"><div><span class="eyebrow">In evidenza</span><h2>Ultimo risultato</h2></div></div>${recent?`<div class="result-focus"><div>${logo(recent.home_logo,recent.home_name)}<span>${esc(recent.home_name)}</span></div><strong>${recent.home_score} <i>-</i> ${recent.away_score}</strong><div>${logo(recent.away_logo,recent.away_name)}<span>${esc(recent.away_name)}</span></div></div><div class="result-meta">${esc(recent.round_name||'')} · ${fmtDate(recent.match_date)}</div>`:'<div class="empty">Nessun risultato.</div>'}</div>
      <a class="panel fan-panel" href="#/vota"><div><span class="eyebrow light">Community</span><h2>Vota il protagonista</h2><p>Partecipa alle votazioni ufficiali della Prime League.</p></div><span class="fan-arrow">→</span></a>
    </div>
  </section>

  <section class="stats-showcase"><div class="stats-showcase-head"><h2>Statistiche</h2><a href="#/statistiche">Vedi altro</a></div>
    <div class="stats-showcase-grid">
      ${statPanel('mvp','MVP',statsData.mvps,'MVP','<small>Partita</small>')}
      ${statPanel('goals','Miglior marcatore',statsData.scorers,'Gol')}
      ${statPanel('assists','Top uomo-assist',statsData.assists,'Assist')}
      ${statPanel('cards','Cartellini',statsData.yellows,'cards')}
    </div>
  </section>

  <div class="brand-marquee home-marquee" aria-hidden="true"><div class="brand-marquee-track">${Array.from({length:10},()=>`<span><img src="/assets/prime-league-crest.png" alt=""> PRIME LEAGUE</span>`).join('')}</div></div>

  <section class="section"><div class="section-head"><div><span class="eyebrow">Club</span><h2>Le squadre</h2></div><a class="text-link" href="#/squadre">Tutte le squadre →</a></div>
    <div class="clubs-strip">${homeTeams.slice(0,10).map(t=>`<a class="club-badge" href="#/squadra/${t.slug}" title="${esc(t.name)}" aria-label="${esc(t.name)}">${logo(t.logo_url,t.name)}</a>`).join('')||'<div class="panel empty">Inserisci le squadre dall’area Admin.</div>'}</div>
  </section>

  <section class="section"><div class="section-head"><div><span class="eyebrow">Aggiornamenti</span><h2>Ultime notizie</h2></div><a class="text-link" href="#/news">Tutte le news →</a></div><div class="news-grid">${d.news.slice(0,3).map((n,i)=>`<article class="news-feature ${i===0?'main':''} ${n.cover_url?'has-cover':''}" style="${n.cover_url?`--news-cover:url('${esc(n.cover_url)}')`:''}"><div class="news-overlay"></div><div class="news-content"><span>Prime League</span><h3>${esc(n.title)}</h3><p>${esc(n.excerpt||'')}</p><a href="#/news">Leggi la notizia →</a></div></article>`).join('')||'<div class="panel empty">Nessuna notizia.</div>'}</div></section>

  ${d.sponsors.length?`<section class="section sponsors-block"><div class="section-head sponsor-head"><div><span class="eyebrow light">Partner</span><h2>Sponsor ufficiali</h2></div></div><div class="sponsor-wall">${d.sponsors.map(s=>`<a class="sponsor-logo" href="${esc(s.website_url||'#')}" ${s.website_url?'target="_blank" rel="noopener"':''} aria-label="${esc(s.name)}">${s.logo_url?`<img src="${esc(s.logo_url)}" alt="${esc(s.name)}">`:`<strong>${esc(s.name)}</strong>`}</a>`).join('')}</div></section>`:''}`,'home');
  if(next){
    const kickoff=new Date(next.match_date).getTime();
    const tick=()=>{const left=Math.max(0,kickoff-Date.now());const total=Math.floor(left/1000);const days=Math.floor(total/86400);const hours=Math.floor((total%86400)/3600);const mins=Math.floor((total%3600)/60);const secs=total%60;const put=(id,v)=>{const el=document.getElementById(id);if(el)el.textContent=String(v).padStart(2,'0')};put('cd-days',days);put('cd-hours',hours);put('cd-minutes',mins);put('cd-seconds',secs)};
    tick();window.__primeCountdown&&clearInterval(window.__primeCountdown);window.__primeCountdown=setInterval(tick,1000);
  }
}
async function matches(){
  loading();
  const d=await api('public/matches');
  const all=[...(d.matches||[])].sort((a,b)=>new Date(a.match_date)-new Date(b.match_date));
  const now=Date.now();
  const upcoming=all.filter(m=>m.status!=='published'&&new Date(m.match_date).getTime()>=now);
  const results=all.filter(m=>m.status==='published').sort((a,b)=>new Date(b.match_date)-new Date(a.match_date));
  const featured=upcoming[0]||results[0]||all[0];
  const rounds=[...new Set(all.map(m=>m.round_name).filter(Boolean))];
  const teams=[...new Map(all.flatMap(m=>[[m.home_team_id,{id:m.home_team_id,name:m.home_name}],[m.away_team_id,{id:m.away_team_id,name:m.away_name}]]).filter(([id])=>id).map(([id,v])=>[id,v])).values()].sort((a,b)=>a.name.localeCompare(b.name));
  const featureHtml=featured?`<section class="matches-feature">
    <div class="matches-feature-copy"><span class="eyebrow light">${featured.status==='published'?'Ultimo risultato':'Prossima partita'}</span><h1>${esc(featured.round_name||'Prime League')}</h1><p>${fmtDate(featured.match_date)}${featured.venue?' · '+esc(featured.venue):''}</p><a class="btn white" href="#/partita/${featured.id}">Apri la partita →</a></div>
    <a class="featured-match-card" href="#/partita/${featured.id}"><div class="featured-status">${featured.status==='published'?'RISULTATO FINALE':'IN PROGRAMMA'}</div><div class="featured-clubs"><div>${logo(featured.home_logo,featured.home_name)}<strong>${esc(featured.home_name)}</strong></div><div class="featured-score">${featured.status==='published'?`${featured.home_score}<i>-</i>${featured.away_score}`:'VS'}<small>${featured.status==='published'?'Finale':new Intl.DateTimeFormat('it-IT',{hour:'2-digit',minute:'2-digit'}).format(new Date(featured.match_date))}</small></div><div>${logo(featured.away_logo,featured.away_name)}<strong>${esc(featured.away_name)}</strong></div></div><span class="featured-link">Dettagli partita →</span></a>
  </section>`:'';
  const card=(m)=>`<a class="fixture-card" data-status="${m.status==='published'?'results':'upcoming'}" data-round="${esc(m.round_name||'')}" data-teams="${m.home_team_id},${m.away_team_id}" href="#/partita/${m.id}"><div class="fixture-top"><span>${esc(m.round_name||'Prime League')}</span><span class="fixture-state ${m.status==='published'?'done':'scheduled'}">${m.status==='published'?'FINALE':'IN PROGRAMMA'}</span></div><div class="fixture-body"><div class="fixture-team">${logo(m.home_logo,m.home_name)}<strong>${esc(m.home_name)}</strong></div><div class="fixture-score">${m.status==='published'?`${m.home_score}<i>-</i>${m.away_score}`:'VS'}<small>${new Intl.DateTimeFormat('it-IT',{day:'2-digit',month:'short',hour:'2-digit',minute:'2-digit'}).format(new Date(m.match_date))}</small></div><div class="fixture-team">${logo(m.away_logo,m.away_name)}<strong>${esc(m.away_name)}</strong></div></div><div class="fixture-bottom"><span>${esc(m.venue||'Campo da definire')}</span><b>Apri scheda →</b></div></a>`;
  set(`${featureHtml}<section class="matches-shell"><div class="matches-heading"><div><span class="eyebrow">Calendario ufficiale</span><h2>Tutte le partite</h2><p>Consulta le prossime gare, i risultati e il calendario completo della stagione.</p></div><div class="matches-summary"><b>${all.length}</b><span>Partite</span></div></div>
    <div class="matches-controls"><div class="matches-tabs"><button class="match-tab active" data-tab="upcoming">Prossime <span>${upcoming.length}</span></button><button class="match-tab" data-tab="results">Risultati <span>${results.length}</span></button><button class="match-tab" data-tab="all">Calendario <span>${all.length}</span></button></div><div class="matches-filters"><select id="round-filter"><option value="">Tutte le giornate</option>${rounds.map(r=>`<option value="${esc(r)}">${esc(r)}</option>`).join('')}</select><select id="team-filter"><option value="">Tutte le squadre</option>${teams.map(t=>`<option value="${t.id}">${esc(t.name)}</option>`).join('')}</select></div></div>
    <div class="fixtures-grid" id="fixtures-grid">${all.map(card).join('')||'<div class="panel empty">Nessuna partita disponibile.</div>'}</div><div class="matches-empty" id="matches-empty" hidden>Nessuna partita corrisponde ai filtri selezionati.</div>
  </section>`,'partite');
  let tab=upcoming.length?'upcoming':(results.length?'results':'all');
  const apply=()=>{const round=document.querySelector('#round-filter')?.value||'';const team=document.querySelector('#team-filter')?.value||'';let visible=0;document.querySelectorAll('.fixture-card').forEach(el=>{const okTab=tab==='all'||el.dataset.status===tab;const okRound=!round||el.dataset.round===round;const okTeam=!team||el.dataset.teams.split(',').includes(team);const show=okTab&&okRound&&okTeam;el.hidden=!show;if(show)visible++});const empty=document.querySelector('#matches-empty');if(empty)empty.hidden=visible>0};
  document.querySelectorAll('.match-tab').forEach(btn=>btn.onclick=()=>{document.querySelectorAll('.match-tab').forEach(x=>x.classList.remove('active'));btn.classList.add('active');tab=btn.dataset.tab;apply()});
  const initial=document.querySelector(`.match-tab[data-tab="${tab}"]`);if(initial){document.querySelectorAll('.match-tab').forEach(x=>x.classList.remove('active'));initial.classList.add('active')}
  document.querySelector('#round-filter')?.addEventListener('change',apply);document.querySelector('#team-filter')?.addEventListener('change',apply);apply();
}

async function matchDetail(id){
  loading();
  const d=await api(`public/match/${id}`);
  const m=d.match;
  const published=m.status==='published';
  const scheduled=!published;
  const events=d.events||[];
  const goals=events.filter(e=>e.event_type==='goal');
  const assists=goals.filter(e=>e.assist_player_id && e.assist_name);
  const yellows=events.filter(e=>e.event_type==='yellow');
  const reds=events.filter(e=>e.event_type==='red');
  const homeGoals=goals.filter(e=>e.team_id===m.home_team_id);
  const awayGoals=goals.filter(e=>e.team_id===m.away_team_id);
  const teamForm=d.team_form||{home:[],away:[]};
  const timeOnly=new Intl.DateTimeFormat('it-IT',{hour:'2-digit',minute:'2-digit'}).format(new Date(m.match_date));
  const dateOnly=new Intl.DateTimeFormat('it-IT',{weekday:'long',day:'2-digit',month:'long',year:'numeric'}).format(new Date(m.match_date));
  const statusLabel=published?'RISULTATO FINALE':'IN PROGRAMMA';
  const formDots=(items)=>items.length?items.map(x=>`<span class="form-dot ${x}">${x.toUpperCase()}</span>`).join(''):'<span class="muted">Nessun dato</span>';
  const person=(e,label='')=>`<a class="match-person" href="${e.player_slug?`#/giocatore/${esc(e.player_slug)}`:'#'}"><span class="match-person-icon">${e.event_type==='goal'?'⚽':e.event_type==='yellow'?'🟨':'🟥'}</span><div><strong>${esc(e.player_name||'Giocatore')}</strong><small>${esc(e.team_name||'')}</small>${label?`<small>${esc(label)}</small>`:''}${e.assist_name?`<small>Assist: ${esc(e.assist_name)}</small>`:''}</div><b>${e.quantity>1?'×'+e.quantity:''}</b></a>`;
  const assistPerson=(e)=>`<a class="match-person" href="${e.assist_slug?`#/giocatore/${esc(e.assist_slug)}`:'#'}"><span class="match-person-icon">🎯</span><div><strong>${esc(e.assist_name||'Giocatore')}</strong><small>${esc(e.team_name||'')}</small><small>Assist per ${esc(e.player_name||'gol')}</small></div><b>${e.quantity>1?'×'+e.quantity:''}</b></a>`;
  const eventGroup=(title,rows,empty,renderer=person)=>`<article class="match-data-card"><div class="match-data-head"><span>${title}</span><b>${rows.reduce((sum,e)=>sum+(Number(e.quantity)||1),0)}</b></div><div class="match-data-list">${rows.length?rows.map(e=>renderer(e)).join(''):`<div class="match-data-empty">${empty}</div>`}</div></article>`;
  const scorerList=(rows,side)=>rows.length?rows.map(e=>`<div class="score-event ${side}"><span>${esc(e.player_name||'Giocatore')}${e.quantity>1?` ×${e.quantity}`:''}</span><i>⚽</i></div>`).join(''):'';

  set(`<section class="single-match-hero">
    <div class="single-match-nav"><a href="#/partite">← Torna alle partite</a><span>${esc(m.round_name||'Prime League')}</span></div>
    <div class="single-match-status"><span class="status-pill ${published?'finished':'scheduled'}">${statusLabel}</span><p>${esc(dateOnly)} · ${timeOnly}${m.venue?' · '+esc(m.venue):''}</p></div>
    <div class="single-scoreboard">
      <a class="single-team" href="#/squadra/${esc(m.home_slug)}">${logo(m.home_logo,m.home_name)}<strong>${esc(m.home_name)}</strong><small>Casa</small></a>
      <div class="single-score"><span>${published?`${m.home_score}<i>-</i>${m.away_score}`:'VS'}</span><small>${published?'Finale':timeOnly}</small></div>
      <a class="single-team" href="#/squadra/${esc(m.away_slug)}">${logo(m.away_logo,m.away_name)}<strong>${esc(m.away_name)}</strong><small>Trasferta</small></a>
    </div>
    ${published&&(homeGoals.length||awayGoals.length)?`<div class="score-events"><div>${scorerList(homeGoals,'home')}</div><div>${scorerList(awayGoals,'away')}</div></div>`:''}
    ${scheduled?`<div class="single-countdown" data-kickoff="${esc(m.match_date)}"><span>Al calcio d’inizio mancano</span><div><b id="match-days">00<small>giorni</small></b><b id="match-hours">00<small>ore</small></b><b id="match-minutes">00<small>minuti</small></b><b id="match-seconds">00<small>secondi</small></b></div></div>`:''}
  </section>

  <section class="match-facts">
    <div><span>Competizione</span><strong>Prime League</strong></div>
    <div><span>Giornata</span><strong>${esc(m.round_name||'Da definire')}</strong></div>
    <div><span>Data e ora</span><strong>${esc(dateOnly)} · ${timeOnly}</strong></div>
    <div><span>Campo</span><strong>${esc(m.venue||'Da definire')}</strong></div>
  </section>

  ${published?`<section class="single-match-section"><div class="section-head"><div><span class="eyebrow">Dati ufficiali</span><h2>Protagonisti della partita</h2></div></div>
    <div class="match-data-grid four">
      ${eventGroup('Marcatori',goals,'Nessun marcatore registrato.')}
      ${eventGroup('Assist',assists,'Nessun assist registrato.',assistPerson)}
      ${eventGroup('Ammoniti',yellows,'Nessuna ammonizione.')}
      ${eventGroup('Espulsi',reds,'Nessuna espulsione.')}
    </div>
  </section>`:''}

  <section class="single-match-layout">
    <div class="single-match-main">
      ${m.mvp_player_id?`<article class="match-mvp-premium"><div class="mvp-copy"><span>⭐ MVP DELLA PARTITA</span><h2>${esc(m.mvp_name)}</h2><p>${esc(m.mvp_team_name||'')}</p><a href="#/giocatore/${esc(m.mvp_slug)}">Apri profilo giocatore →</a></div><div class="mvp-photo">${m.mvp_photo?`<img src="${esc(m.mvp_photo)}" alt="${esc(m.mvp_name)}">`:`<div>${esc(initials(m.mvp_name))}</div>`}</div></article>`:`<article class="panel match-no-mvp"><span class="eyebrow">MVP</span><h2>${published?'Da assegnare':'Sarà scelto dopo la gara'}</h2><p>Il miglior giocatore apparirà qui quando il dato sarà ufficiale.</p></article>`}
    </div>
    <aside class="single-match-side">
      <article class="panel form-panel"><span class="eyebrow">Forma recente</span><h3>Ultime 5 partite</h3><div class="form-team"><span>${esc(m.home_name)}</span><div>${formDots(teamForm.home)}</div></div><div class="form-team"><span>${esc(m.away_name)}</span><div>${formDots(teamForm.away)}</div></div></article>
      ${m.highlights_url?`<a class="highlights-card" href="${esc(m.highlights_url)}" target="_blank" rel="noopener"><span>▶</span><div><small>VIDEO</small><strong>Guarda gli highlights</strong></div></a>`:''}
      <article class="panel share-panel"><span class="eyebrow">Condividi</span><h3>Invia la scheda della partita</h3><button class="btn primary" id="share-match">Condividi partita</button></article>
    </aside>
  </section>

  <section class="section related-matches"><div class="section-head"><div><span class="eyebrow">Stessa giornata</span><h2>Altre partite</h2></div><a href="#/partite">Calendario completo →</a></div><div class="grid two">${(d.related||[]).map(matchCard).join('')||'<div class="card empty">Nessun’altra partita disponibile.</div>'}</div></section>`,'partite');

  if(scheduled){
    const kickoff=new Date(m.match_date).getTime();
    const tick=()=>{const diff=Math.max(0,kickoff-Date.now());const values={days:Math.floor(diff/86400000),hours:Math.floor(diff/3600000)%24,minutes:Math.floor(diff/60000)%60,seconds:Math.floor(diff/1000)%60};for(const [k,v] of Object.entries(values)){const el=document.querySelector(`#match-${k}`);if(el)el.firstChild.textContent=String(v).padStart(2,'0')}};tick();const timer=setInterval(()=>{if(!document.querySelector('.single-countdown'))return clearInterval(timer);tick()},1000);
  }
  const share=document.querySelector('#share-match');
  if(share)share.onclick=async()=>{const data={title:`${m.home_name} - ${m.away_name}`,text:`Prime League: ${m.home_name} ${published?m.home_score+'-'+m.away_score:'vs'} ${m.away_name}`,url:location.href};if(navigator.share)await navigator.share(data);else{await navigator.clipboard.writeText(location.href);share.textContent='Link copiato'}};
}
function qualificationLabel(index){
  if(index===0)return '<span class="qualification-badge finalist">Finalista diretta</span>';
  if(index>=1&&index<=4)return '<span class="qualification-badge playoff">Playoff</span>';
  return '';
}
function gdClass(value){return Number(value)>0?'positive':Number(value)<0?'negative':'neutral'}
function premiumStandings(rows){
  return `<div class="standings-desktop"><div class="premium-table-wrap"><table class="premium-table"><thead><tr><th>Pos.</th><th>Squadra</th><th>PG</th><th>V</th><th>N</th><th>P</th><th>GF</th><th>GS</th><th>DR</th><th>PT</th></tr></thead><tbody>${rows.map((t,i)=>`<tr class="standing-row ${i===0?'direct-finalist':i<=4?'playoff-zone':''}" data-href="#/squadra/${t.slug}" tabindex="0"><td><span class="position-number">${i+1}</span></td><td><div class="standing-team">${logo(t.logo_url,t.name)}<div><strong>${esc(t.name)}</strong>${qualificationLabel(i)}</div></div></td><td>${t.played}</td><td>${t.won}</td><td>${t.drawn}</td><td>${t.lost}</td><td>${t.gf}</td><td>${t.ga}</td><td><span class="goal-difference ${gdClass(t.gd)}">${Number(t.gd)>0?'+':''}${t.gd}</span></td><td><span class="points-value">${t.points}</span></td></tr>`).join('')}</tbody></table></div></div>
  <div class="standings-mobile">${rows.map((t,i)=>`<a class="standing-mobile-card ${i===0?'direct-finalist':i<=4?'playoff-zone':''}" href="#/squadra/${t.slug}"><div class="standing-mobile-head"><span class="position-number">${i+1}</span>${logo(t.logo_url,t.name)}<div class="standing-mobile-name"><strong>${esc(t.name)}</strong>${qualificationLabel(i)}</div><span class="mobile-points"><b>${t.points}</b><small>PT</small></span></div><div class="standing-mobile-stats"><span><b>${t.played}</b><small>PG</small></span><span><b>${t.won}</b><small>V</small></span><span><b>${t.drawn}</b><small>N</small></span><span><b>${t.lost}</b><small>P</small></span><span><b>${t.gf}</b><small>GF</small></span><span><b>${t.ga}</b><small>GS</small></span><span class="${gdClass(t.gd)}"><b>${Number(t.gd)>0?'+':''}${t.gd}</b><small>DR</small></span></div></a>`).join('')}</div>`;
}
async function table(seasonId=''){
  loading();
  const d=await api(`public/standings${seasonId?`?season=${encodeURIComponent(seasonId)}`:''}`);
  const season=d.selectedSeason||{};
  const options=(d.seasons||[]).map(s=>`<option value="${s.id}" ${Number(s.id)===Number(season.id)?'selected':''}>${esc(s.name)}</option>`).join('');
  set(`<section class="standings-hero"><div><span class="eyebrow light">Classifica ufficiale</span><h1>Prime League</h1><p>Posizioni e risultati aggiornati automaticamente dopo la pubblicazione di ogni partita.</p></div><div class="season-selector-card"><label for="standings-season">Stagione</label><select id="standings-season" class="input">${options}</select><small>Consulta anche le classifiche delle stagioni precedenti.</small></div></section>
  <section class="standings-content"><div class="standings-title-row"><div><span class="eyebrow">${esc(season.competition_name||'Prime League')}</span><h2>Classifica ${esc(season.name||'')}</h2></div><div class="qualification-legend"><span><i class="legend-finalist"></i>Finalista diretta</span><span><i class="legend-playoff"></i>Qualificazione playoff</span></div></div>
  ${d.standings?.length?premiumStandings(d.standings):'<div class="card empty">Nessun risultato disponibile per questa stagione.</div>'}</section>`,'classifica');
  const selector=document.querySelector('#standings-season'); if(selector)selector.onchange=()=>table(selector.value);
  document.querySelectorAll('.standing-row').forEach(row=>{const open=()=>location.hash=row.dataset.href;row.onclick=open;row.onkeydown=e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();open()}}});
}
function teamSeasonOptions(seasons=[],selectedId){return seasons.map(s=>`<option value="${s.id}" ${Number(s.id)===Number(selectedId)?'selected':''}>${esc(s.name)}</option>`).join('')}
function teamFormDots(form=''){return String(form||'').split('').slice(-5).map(v=>`<span class="form-dot ${v==='V'?'win':v==='N'?'draw':'loss'}">${esc(v)}</span>`).join('')||'<span class="muted">—</span>'}
async function teams(seasonId=''){loading();const d=await api(`public/teams${seasonId?`?season=${encodeURIComponent(seasonId)}`:''}`);const season=d.selectedSeason||{};set(`<section class="teams-hero"><div><span class="eyebrow light">I club della competizione</span><h1>Squadre Prime League</h1><p>Scopri i club, la loro posizione e il rendimento nella stagione selezionata.</p></div><div class="season-selector-card"><label for="teams-season">Stagione</label><select id="teams-season" class="input">${teamSeasonOptions(d.seasons,season.id)}</select><small>Consulta anche le squadre e i risultati delle annate precedenti.</small></div></section>
<section class="teams-content"><div class="standings-title-row"><div><span class="eyebrow">${esc(season.competition_name||'Prime League')}</span><h2>Club ${esc(season.name||'')}</h2></div><span class="teams-count">${d.teams.length} squadre</span></div><div class="teams-premium-grid">${d.teams.map((t,i)=>`<a class="team-premium-card" href="#/squadra/${t.slug}?season=${season.id}"><div class="team-card-top"><span class="team-position">${t.position?`${t.position}°`:'—'}</span>${logo(t.logo_url,t.name)}<span class="team-points"><b>${t.points||0}</b><small>PT</small></span></div><div class="team-card-copy"><h3>${esc(t.name)}</h3><p>${t.position===1?'Finalista diretta':t.position>=2&&t.position<=5?'Zona playoff':'Prime League'}</p></div><div class="team-card-stats"><span><b>${t.played||0}</b><small>PG</small></span><span><b>${t.won||0}</b><small>V</small></span><span><b>${t.drawn||0}</b><small>N</small></span><span><b>${t.lost||0}</b><small>P</small></span><span><b>${t.gf||0}</b><small>GF</small></span><span><b>${t.ga||0}</b><small>GS</small></span></div><div class="team-card-bottom"><div class="team-form">${teamFormDots(t.form)}</div><span>Apri squadra →</span></div></a>`).join('')||'<div class="card empty">Nessuna squadra presente in questa stagione.</div>'}</div></section>`,'squadre');const selector=document.querySelector('#teams-season');if(selector)selector.onchange=()=>teams(selector.value)}
async function team(slug,seasonId=''){loading();const cleanSlug=String(slug||'').split('?')[0];const querySeason=seasonId||new URLSearchParams(String(slug||'').split('?')[1]||'').get('season')||'';const d=await api(`public/team/${cleanSlug}${querySeason?`?season=${encodeURIComponent(querySeason)}`:''}`);const t=d.team,s=d.stats||{},season=d.selectedSeason||{};set(`<section class="team-profile-hero" style="--team-color:${esc(t.primary_color||'#155eef')}"><div class="team-profile-main">${logo(t.logo_url,t.name)}<div><span class="eyebrow light">Scheda squadra</span><h1>${esc(t.name)}</h1><p>${t.coach_name?`Allenatore: ${esc(t.coach_name)}`:'Allenatore da definire'}${t.manager_name?` · Responsabile: ${esc(t.manager_name)}`:''}</p></div></div><div class="season-selector-card dark-card"><label for="team-season">Stagione</label><select id="team-season" class="input">${teamSeasonOptions(d.seasons,season.id)}</select><small>Storico completo della squadra.</small></div></section>
<section class="team-overview"><div class="team-rank-card"><small>Posizione</small><strong>${s.position?`${s.position}°`:'—'}</strong><span>${s.position===1?'Finalista diretta':s.position>=2&&s.position<=5?'Zona playoff':'Classifica stagione'}</span></div>${[['Punti',s.points],['Partite',s.played],['Vittorie',s.won],['Pareggi',s.drawn],['Sconfitte',s.lost],['Gol fatti',s.gf],['Gol subiti',s.ga]].map(([l,v])=>`<div class="team-stat-card"><small>${l}</small><strong>${v||0}</strong></div>`).join('')}</section>
<section class="section team-section"><div class="section-head"><div><span class="eyebrow">Organico</span><h2>Rosa ${esc(season.name||'')}</h2></div><span class="muted">${d.players.length} giocatori</span></div><div class="roster-grid">${d.players.map(p=>`<a class="roster-card" href="#/giocatore/${p.slug}">${avatar(p.photo_url,`${p.first_name} ${p.last_name}`)}<div class="roster-copy"><strong>${esc(p.first_name)} ${esc(p.last_name)}</strong><span>#${p.shirt_number||'—'} · ${esc(p.role||'Giocatore')}</span></div><div class="roster-numbers"><span><b>${p.goals||0}</b><small>Gol</small></span><span><b>${p.assists||0}</b><small>Assist</small></span></div></a>`).join('')||'<div class="card empty">Nessun giocatore associato a questa stagione.</div>'}</div></section>
<section class="section team-section"><div class="team-matches-grid"><div><div class="section-head"><div><span class="eyebrow">Calendario</span><h2>Prossime partite</h2></div></div><div class="team-match-stack">${d.upcoming.map(matchCard).join('')||'<div class="card empty">Nessuna partita in programma.</div>'}</div></div><div><div class="section-head"><div><span class="eyebrow">Risultati</span><h2>Ultime partite</h2></div></div><div class="team-match-stack">${d.recent.map(matchCard).join('')||'<div class="card empty">Nessun risultato disponibile.</div>'}</div></div></div></section>
${d.sponsors.length?`<section class="section team-section"><div class="section-head"><div><span class="eyebrow">Partner</span><h2>Sponsor della squadra</h2></div></div><div class="team-sponsor-grid">${d.sponsors.map(s=>`<div class="team-sponsor-card">${s.logo_url?`<img src="${esc(s.logo_url)}" alt="${esc(s.name)}">`:`<strong>${esc(s.name)}</strong>`}</div>`).join('')}</div></section>`:''}`,'squadre');const selector=document.querySelector('#team-season');if(selector)selector.onchange=()=>team(cleanSlug,selector.value)}
function roleOrder(role=''){const r=String(role).toLowerCase();if(r.includes('port'))return 1;if(r.includes('dif'))return 2;if(r.includes('centr'))return 3;if(r.includes('att'))return 4;return 5}
function roleLabel(role=''){const r=String(role).toLowerCase();if(r.includes('port'))return 'Portieri';if(r.includes('dif'))return 'Difensori';if(r.includes('centr'))return 'Centrocampisti';if(r.includes('att'))return 'Attaccanti';return 'Altri giocatori'}
function seasonOptions(seasons=[],selectedId){return seasons.map(s=>`<option value="${s.id}" ${Number(s.id)===Number(selectedId)?'selected':''}>${esc(s.name)}</option>`).join('')}
async function players(seasonId=''){loading();const d=await api(`public/players${seasonId?`?season=${encodeURIComponent(seasonId)}`:''}`);const season=d.selectedSeason||{};const teams=[...new Map((d.players||[]).map(p=>[p.team_id,{id:p.team_id,name:p.team_name,slug:p.team_slug,logo_url:p.team_logo,primary_color:p.team_color}])).values()].sort((a,b)=>a.name.localeCompare(b.name));
const renderTeam=t=>{const roster=(d.players||[]).filter(p=>Number(p.team_id)===Number(t.id)).sort((a,b)=>roleOrder(a.role)-roleOrder(b.role)||(Number(a.shirt_number)||999)-(Number(b.shirt_number)||999)||a.last_name.localeCompare(b.last_name));const groups=[...new Set(roster.map(p=>roleLabel(p.role)))];return `<section class="players-team-block" data-team="${t.id}"><div class="players-team-head"><div class="players-team-identity">${logo(t.logo_url,t.name)}<div><span class="eyebrow">Rosa ufficiale</span><h2>${esc(t.name)}</h2><p>${roster.length} giocatori nella stagione selezionata</p></div></div><a href="#/squadra/${esc(t.slug)}?season=${season.id}">Scheda squadra →</a></div>${groups.map(group=>{const rows=roster.filter(p=>roleLabel(p.role)===group);return `<div class="role-group" data-role="${esc(group)}"><div class="role-group-title"><h3>${esc(group)}</h3><span>${rows.length}</span></div><div class="role-player-grid">${rows.map(p=>`<a class="premium-player-card" data-name="${esc((p.first_name+' '+p.last_name).toLowerCase())}" data-role-name="${esc(roleLabel(p.role))}" href="#/giocatore/${esc(p.slug)}?season=${season.id}"><div class="premium-player-photo">${p.photo_url?`<img src="${esc(p.photo_url)}" alt="${esc(p.first_name+' '+p.last_name)}">`:`<div class="player-fallback">${esc(initials(p.first_name+' '+p.last_name))}</div>`}<span class="shirt-number">${p.shirt_number||'—'}</span></div><div class="premium-player-copy"><small>${esc(p.role||'Giocatore')}</small><strong>${esc(p.first_name)} ${esc(p.last_name)}</strong><div><span><b>${p.appearances||0}</b> PG</span><span><b>${p.goals||0}</b> G</span><span><b>${p.assists||0}</b> A</span></div></div></a>`).join('')}</div></div>`}).join('')}</section>`};
set(`<section class="players-hero"><div><span class="eyebrow light">I protagonisti della competizione</span><h1>Giocatori Prime League</h1><p>Ogni rosa è ordinata per squadra e ruolo. Cerca un atleta senza perdere la struttura ufficiale del campionato.</p></div><div class="season-selector-card dark-card"><label for="players-season">Stagione</label><select id="players-season" class="input">${seasonOptions(d.seasons,season.id)}</select><small>Consulta anche rose e statistiche delle stagioni precedenti.</small></div></section><section class="players-toolbar"><div class="players-search"><span>⌕</span><input id="player-search" type="search" placeholder="Cerca giocatore…"></div><select id="player-team-filter" class="input"><option value="">Tutte le squadre</option>${teams.map(t=>`<option value="${t.id}">${esc(t.name)}</option>`).join('')}</select><select id="player-role-filter" class="input"><option value="">Tutti i ruoli</option><option>Portieri</option><option>Difensori</option><option>Centrocampisti</option><option>Attaccanti</option></select><span class="players-total">${d.players.length} giocatori</span></section><div id="players-directory">${teams.map(renderTeam).join('')||'<div class="card empty">Nessun giocatore presente nella stagione selezionata.</div>'}</div><div id="players-empty" class="card empty" hidden>Nessun giocatore corrisponde ai filtri selezionati.</div>`,'giocatori');
const seasonSelect=document.querySelector('#players-season');if(seasonSelect)seasonSelect.onchange=()=>players(seasonSelect.value);const apply=()=>{const q=(document.querySelector('#player-search')?.value||'').trim().toLowerCase();const team=document.querySelector('#player-team-filter')?.value||'';const role=document.querySelector('#player-role-filter')?.value||'';let visible=0;document.querySelectorAll('.players-team-block').forEach(block=>{let teamVisible=0;block.querySelectorAll('.premium-player-card').forEach(card=>{const show=(!q||card.dataset.name.includes(q))&&(!role||card.dataset.roleName===role);card.hidden=!show;if(show){teamVisible++;visible++}});block.hidden=!!team&&block.dataset.team!==team||teamVisible===0;block.querySelectorAll('.role-group').forEach(group=>group.hidden=[...group.querySelectorAll('.premium-player-card')].every(c=>c.hidden))});document.querySelector('#players-empty').hidden=visible>0};document.querySelector('#player-search')?.addEventListener('input',apply);document.querySelector('#player-team-filter')?.addEventListener('change',apply);document.querySelector('#player-role-filter')?.addEventListener('change',apply)}
async function player(slug,seasonId=''){loading();const cleanSlug=String(slug||'').split('?')[0];const querySeason=seasonId||new URLSearchParams(String(slug||'').split('?')[1]||'').get('season')||'';const d=await api(`public/player/${cleanSlug}${querySeason?`?season=${encodeURIComponent(querySeason)}`:''}`);const p=d.player,s=d.stats||{},season=d.selectedSeason||{};const fullName=`${p.first_name} ${p.last_name}`;const involvement=(Number(s.goals)||0)+(Number(s.assists)||0);const perGame=Number(s.appearances)?(Number(s.goals)/Number(s.appearances)).toFixed(2):'0.00';const recent=d.recent||[];
set(`<section class="player-profile-hero" style="--player-team:${esc(p.primary_color||'#155eef')}"><div class="player-watermark">${p.shirt_number||'PL'}</div><div class="player-profile-copy"><div class="player-profile-kicker">${logo(p.team_logo,p.team_name)}<span>${esc(p.team_name)} · ${esc(season.name||'')}</span></div><span class="eyebrow light">Profilo ufficiale</span><h1>${esc(p.first_name)}<br><strong>${esc(p.last_name)}</strong></h1><div class="player-profile-meta"><span>#${p.shirt_number||'—'}</span><span>${esc(p.role||'Giocatore')}</span><a href="#/squadra/${esc(p.team_slug)}?season=${season.id}">Apri squadra →</a></div></div><div class="player-profile-image">${p.photo_url?`<img src="${esc(p.photo_url)}" alt="${esc(fullName)}">`:`<div class="player-profile-fallback">${esc(initials(fullName))}</div>`}</div><div class="player-season-switch"><label for="player-season">Stagione</label><select id="player-season" class="input">${seasonOptions(d.seasons,season.id)}</select><small>Statistiche e partite dell'annata scelta.</small></div></section>
<section class="player-main-stats">${[['Presenze',s.appearances,'PG'],['Gol',s.goals,'GOL'],['Assist',s.assists,'AST'],['MVP',s.mvps,'MVP'],['Gialli',s.yellows,'YC'],['Rossi',s.reds,'RC']].map(([l,v,u])=>`<article><small>${l}</small><strong>${v||0}</strong><span>${u}</span></article>`).join('')}</section>
<section class="player-performance-grid"><article class="player-performance-card"><span class="eyebrow">Rendimento</span><h2>Impatto nella stagione</h2><div class="performance-numbers"><div><strong>${perGame}</strong><span>Gol per partita</span></div><div><strong>${involvement}</strong><span>Partecipazioni ai gol</span></div><div><strong>${s.rank_scorers?`${s.rank_scorers}°`:'—'}</strong><span>Classifica marcatori</span></div><div><strong>${s.rank_assists?`${s.rank_assists}°`:'—'}</strong><span>Classifica assist</span></div></div></article><article class="player-share-card"><span>PRIME LEAGUE PLAYER</span><h2>${esc(fullName)}</h2><p>Condividi il profilo ufficiale del giocatore.</p><div><button id="share-player" class="btn white">Condividi</button><button id="copy-player" class="btn glass">Copia link</button></div></article></section>
<section class="section player-section"><div class="section-head"><div><span class="eyebrow">Match log</span><h2>Partite recenti</h2></div></div><div class="player-match-list">${recent.map(m=>`<a href="#/partita/${m.id}" class="player-match-row"><div><small>${esc(m.round_name||'Prime League')}</small><strong>${esc(m.home_name)} <b>${m.status==='published'?`${m.home_score} - ${m.away_score}`:'VS'}</b> ${esc(m.away_name)}</strong><span>${fmtDate(m.match_date)}</span></div><div class="player-match-output"><span><b>${m.player_goals||0}</b> Gol</span><span><b>${m.player_assists||0}</b> Assist</span>${m.player_yellows?'<i class="yellow-card"></i>':''}${m.player_reds?'<i class="red-card"></i>':''}${m.is_mvp?'<em>★ MVP</em>':''}</div></a>`).join('')||'<div class="card empty">Nessuna presenza registrata in questa stagione.</div>'}</div></section>
<section class="section player-section"><div class="section-head"><div><span class="eyebrow">Prime League</span><h2>Storico carriera</h2></div></div><div class="career-table-wrap"><table class="career-table"><thead><tr><th>Stagione</th><th>Squadra</th><th>PG</th><th>Gol</th><th>Assist</th><th>Gialli</th><th>Rossi</th><th>MVP</th></tr></thead><tbody>${(d.career||[]).map(c=>`<tr class="${Number(c.season_id)===Number(season.id)?'active':''}" data-season="${c.season_id}"><td><b>${esc(c.season_name)}</b></td><td>${esc(c.team_name||p.team_name)}</td><td>${c.appearances||0}</td><td>${c.goals||0}</td><td>${c.assists||0}</td><td>${c.yellows||0}</td><td>${c.reds||0}</td><td>${c.mvps||0}</td></tr>`).join('')}</tbody></table></div></section>`,'giocatori');
const selector=document.querySelector('#player-season');if(selector)selector.onchange=()=>player(cleanSlug,selector.value);document.querySelectorAll('.career-table tbody tr').forEach(r=>r.onclick=()=>player(cleanSlug,r.dataset.season));document.querySelector('#share-player')?.addEventListener('click',async()=>{const data={title:`${fullName} | Prime League`,text:`Guarda il profilo di ${fullName} su Prime League`,url:location.href};if(navigator.share)await navigator.share(data).catch(()=>{});else await navigator.clipboard.writeText(location.href)});document.querySelector('#copy-player')?.addEventListener('click',async e=>{await navigator.clipboard.writeText(location.href);e.currentTarget.textContent='Link copiato'})}

function statSeasonOptions(seasons=[],selectedId){return seasons.map(s=>`<option value="${s.id}" ${Number(s.id)===Number(selectedId)?'selected':''}>${esc(s.name)}</option>`).join('')}
function rankingList(title,subtitle,rows=[],unit,kind='default'){
  const top=rows.slice(0,3), rest=rows.slice(3);
  const topCard=(p,i)=>`<a class="stats-podium-card place-${i+1}" href="#/giocatore/${p.slug}"><span class="podium-place">${i+1}</span><div class="podium-avatar">${avatar(p.photo_url,`${p.first_name} ${p.last_name}`)}</div><div class="podium-copy"><small>${esc(p.team_name)}</small><strong>${esc(p.first_name)} ${esc(p.last_name)}</strong><span>${esc(p.role||'Giocatore')}</span></div><b>${p.value||0}<small>${unit}</small></b></a>`;
  return `<section class="stats-ranking-panel ${kind}"><div class="stats-panel-head"><div><span class="eyebrow">${esc(subtitle)}</span><h2>${esc(title)}</h2></div><span>${rows.length} giocatori</span></div>${rows.length?`<div class="stats-podium">${top.map(topCard).join('')}</div><div class="stats-full-list">${rest.map((p,i)=>`<a href="#/giocatore/${p.slug}"><span class="stats-list-rank">${i+4}</span>${avatar(p.photo_url,`${p.first_name} ${p.last_name}`)}<div><strong>${esc(p.first_name)} ${esc(p.last_name)}</strong><small>${esc(p.team_name)} · ${esc(p.role||'')}</small></div><b>${p.value||0}<small>${unit}</small></b></a>`).join('')}</div>`:'<div class="stats-empty">Nessun dato disponibile per i filtri selezionati.</div>'}</section>`;
}
function teamRanking(title,rows=[],metric,label,invert=false){
  const max=Math.max(1,...rows.map(t=>Number(t[metric]||0)));
  return `<article class="team-stat-ranking"><div class="stats-panel-head compact"><div><span class="eyebrow">Squadre</span><h3>${esc(title)}</h3></div></div><div class="team-ranking-list">${rows.slice(0,10).map((t,i)=>`<a href="#/squadra/${t.slug}"><span>${i+1}</span>${logo(t.logo_url,t.name)}<div><strong>${esc(t.name)}</strong><i><em style="width:${Math.max(5,Number(t[metric]||0)/max*100)}%"></em></i></div><b>${t[metric]||0}<small>${label}</small></b></a>`).join('')||'<div class="stats-empty">Nessun dato.</div>'}</div></article>`;
}
async function stats(seasonId='',teamId='',role=''){
  loading();
  const q=new URLSearchParams();if(seasonId)q.set('season',seasonId);if(teamId)q.set('team',teamId);if(role)q.set('role',role);
  const d=await api(`public/stats${q.toString()?`?${q}`:''}`),season=d.selectedSeason||{},o=d.overview||{};
  const maxRound=Math.max(1,...(d.roundGoals||[]).map(r=>Number(r.goals||0)));
  set(`<section class="statistics-hero"><div><span class="eyebrow light">Numeri ufficiali</span><h1>Statistiche Prime League</h1><p>Scopri protagonisti, rendimento delle squadre e andamento del campionato. Tutti i dati provengono esclusivamente dalle partite pubblicate.</p></div><div class="season-selector-card dark-card"><label for="stats-season">Stagione</label><select id="stats-season" class="input">${statSeasonOptions(d.seasons,season.id)}</select><small>Consulta lo storico completo delle annate precedenti.</small></div></section>
  <section class="stats-toolbar"><select id="stats-team" class="input"><option value="">Tutte le squadre</option>${(d.teams||[]).map(t=>`<option value="${t.id}" ${Number(teamId)===Number(t.id)?'selected':''}>${esc(t.name)}</option>`).join('')}</select><select id="stats-role" class="input"><option value="">Tutti i ruoli</option>${['Portiere','Difensore','Centrocampista','Attaccante'].map(r=>`<option value="${r}" ${role===r?'selected':''}>${r}</option>`).join('')}</select><button class="btn stats-reset" id="stats-reset">Azzera filtri</button></section>
  <section class="stats-overview">${[['Partite giocate',o.matches||0,'MATCH'],['Gol segnati',o.goals||0,'GOL'],['Media gol',Number(o.goals_per_match||0).toFixed(2),'MEDIA'],['Ammonizioni',o.yellows||0,'GIALLI'],['Espulsioni',o.reds||0,'ROSSI'],['Squadre',o.teams||0,'CLUB']].map(([l,v,u])=>`<article data-unit="${u}"><small>${l}</small><strong>${v}</strong><span>${esc(season.name||'')}</span></article>`).join('')}</section>
  <section class="stats-section-title"><div><span class="eyebrow">Classifiche individuali</span><h2>I protagonisti della stagione</h2></div></section>
  <div class="statistics-rankings">${rankingList('Classifica marcatori','Gol',d.scorers,'gol','goals')}${rankingList('Classifica assist','Passaggi decisivi',d.assists,'assist','assists')}${rankingList('Premi MVP','Migliori in campo',d.mvps,'MVP','mvp')}${rankingList('Ammonizioni','Cartellini gialli',d.yellows,'gialli','yellow')}${rankingList('Espulsioni','Cartellini rossi',d.reds,'rossi','red')}</div>
  <section class="stats-section-title"><div><span class="eyebrow">Rendimento dei club</span><h2>Statistiche di squadra</h2></div></section>
  <div class="team-stat-grid">${teamRanking('Migliori attacchi',d.teamRankings?.attack||[],'gf','GF')}${teamRanking('Migliori difese',d.teamRankings?.defense||[],'ga','GS')}${teamRanking('Più vittorie',d.teamRankings?.wins||[],'won','V')}</div>
  <section class="round-goals-section"><div class="stats-panel-head"><div><span class="eyebrow">Andamento stagionale</span><h2>Gol per giornata</h2></div></div><div class="round-goals-chart">${(d.roundGoals||[]).map(r=>`<div class="round-goal-column"><span>${r.goals}</span><div><i style="height:${Math.max(7,Number(r.goals||0)/maxRound*100)}%"></i></div><small>${esc(r.round_name)}</small></div>`).join('')||'<div class="stats-empty">I dati appariranno dopo la pubblicazione delle prime partite.</div>'}</div></section>`,'statistiche');
  const reload=()=>stats(document.querySelector('#stats-season')?.value||'',document.querySelector('#stats-team')?.value||'',document.querySelector('#stats-role')?.value||'');
  document.querySelector('#stats-season').onchange=reload;document.querySelector('#stats-team').onchange=reload;document.querySelector('#stats-role').onchange=reload;document.querySelector('#stats-reset').onclick=()=>stats(document.querySelector('#stats-season').value,'','');
}
async function news(){loading();const d=await api('public/news');set(`<div class="section-head"><div><span class="eyebrow">Comunicazioni</span><h2>News</h2></div></div><div class="grid three">${d.news.map(n=>`<article class="card"><span class="eyebrow">${fmtDate(n.published_at)}</span><h3>${esc(n.title)}</h3><p class="muted">${esc(n.excerpt||'')}</p><p>${esc(n.body)}</p></article>`).join('')||'<div class="card empty">Nessuna news.</div>'}</div>`,'news')}

async function login(){set(`<div class="auth-shell"><div class="auth-brand-panel"><span class="eyebrow light">Prime League Control Center</span><h1>Gestisci il campionato.<br><strong>In sicurezza.</strong></h1><p>Accesso riservato a organizzazione, team manager e arbitri autorizzati.</p><div class="auth-security-list"><span>✓ Sessione protetta</span><span>✓ Permessi per ruolo</span><span>✓ Registro attività</span></div></div><div class="auth-card card"><span class="eyebrow">Area riservata</span><h2>Accedi</h2><p class="muted">Inserisci le credenziali assegnate dalla Prime League.</p><form id="login-form" class="form-grid"><div class="field full"><label>Email o username</label><input class="input" name="login" autocomplete="username" required></div><div class="field full"><label>Password</label><input class="input" type="password" name="password" autocomplete="current-password" required></div><div class="field full"><button class="btn primary">Accedi al pannello</button></div><div id="form-msg" class="field full"></div></form><div class="auth-links"><a href="#/recupera-password">Password dimenticata?</a><a href="#/home">Torna al sito</a></div></div></div>`,'');document.querySelector('#login-form').onsubmit=async e=>{e.preventDefault();const button=e.target.querySelector('button');button.disabled=true;button.textContent='Accesso…';const f=new FormData(e.target);try{await api('auth/login',{method:'POST',body:JSON.stringify(Object.fromEntries(f))});await loadUser();location.hash='#/dashboard'}catch(err){document.querySelector('#form-msg').innerHTML=message(err.message,'error');button.disabled=false;button.textContent='Accedi al pannello'}}}
async function forgotPassword(){set(`<div class="auth-card card"><span class="eyebrow">Recupero accesso</span><h2>Password dimenticata</h2><p class="muted">Inserisci email o username. Per ora il link viene generato dal Super Admin e condiviso in modo riservato.</p><form id="forgot-form" class="form-grid"><div class="field full"><label>Email o username</label><input class="input" name="login" required></div><div class="field full"><button class="btn primary">Avvia recupero</button></div><div id="form-msg" class="field full"></div></form><a class="btn ghost" href="#/login">Torna al login</a></div>`,'');document.querySelector('#forgot-form').onsubmit=async e=>{e.preventDefault();const d=Object.fromEntries(new FormData(e.target));const r=await api('auth/request-reset',{method:'POST',body:JSON.stringify(d)});document.querySelector('#form-msg').innerHTML=message(r.message,'success')+(r.resetUrl?`<div class="reset-link-box"><a href="${esc(r.resetUrl)}">Apri link di ripristino</a></div>`:'')}}
async function resetPassword(token){set(`<div class="auth-card card"><span class="eyebrow">Nuova password</span><h2>Ripristina accesso</h2><form id="reset-form" class="form-grid"><div class="field full"><label>Nuova password</label><input class="input" type="password" name="password" minlength="10" autocomplete="new-password" required><small>Almeno 10 caratteri.</small></div><div class="field full"><label>Ripeti password</label><input class="input" type="password" name="confirm" minlength="10" autocomplete="new-password" required></div><div class="field full"><button class="btn primary">Salva nuova password</button></div><div id="form-msg" class="field full"></div></form></div>`,'');document.querySelector('#reset-form').onsubmit=async e=>{e.preventDefault();const d=Object.fromEntries(new FormData(e.target));if(d.password!==d.confirm){document.querySelector('#form-msg').innerHTML=message('Le password non coincidono','error');return}try{await api('auth/reset-password',{method:'POST',body:JSON.stringify({token,password:d.password})});document.querySelector('#form-msg').innerHTML=message('Password aggiornata. Ora puoi accedere.','success')+`<a class="btn primary" href="#/login">Vai al login</a>`}catch(err){document.querySelector('#form-msg').innerHTML=message(err.message,'error')}}}
async function register(){set(`<div class="auth-card card"><span class="eyebrow">Tifosi</span><h2>Crea account</h2><form id="reg-form" class="form-grid"><div class="field full"><label>Nome visualizzato</label><input class="input" name="displayName" required></div><div class="field full"><label>Email</label><input class="input" type="email" name="email" required></div><div class="field full"><label>Password</label><input class="input" type="password" name="password" minlength="8" required></div><div class="field full"><button class="btn primary">Registrati</button></div><div id="form-msg" class="field full"></div></form></div>`,'');document.querySelector('#reg-form').onsubmit=async e=>{e.preventDefault();const f=new FormData(e.target);try{await api('auth/register-fan',{method:'POST',body:JSON.stringify(Object.fromEntries(f))});document.querySelector('#form-msg').innerHTML=message('Registrazione completata. Ora puoi accedere.','success')}catch(err){document.querySelector('#form-msg').innerHTML=message(err.message,'error')}}}
async function setup(){set(`<div class="auth-card card"><span class="eyebrow">Prima configurazione</span><h2>Crea il Super Admin</h2><form id="setup-form" class="form-grid"><div class="field full"><label>Token SETUP_TOKEN</label><input class="input" type="password" name="setupToken" required></div><div class="field full"><label>Nome</label><input class="input" name="displayName" value="Super Admin" required></div><div class="field full"><label>Username</label><input class="input" name="username" value="admin" required></div><div class="field full"><label>Email</label><input class="input" type="email" name="email" required></div><div class="field full"><label>Password</label><input class="input" type="password" name="password" minlength="8" required></div><button class="btn primary">Configura</button><div id="form-msg" class="field full"></div></form></div>`,'');document.querySelector('#setup-form').onsubmit=async e=>{e.preventDefault();const d=Object.fromEntries(new FormData(e.target));try{await api('setup',{method:'POST',body:JSON.stringify(d)});document.querySelector('#form-msg').innerHTML=message('Super Admin creato. Vai alla pagina di accesso.','success')}catch(err){document.querySelector('#form-msg').innerHTML=message(err.message,'error')}}}

function adminRoleLabel(role){return ({super_admin:'Super Admin',organizer:'Organizzatore',team_manager:'Team Manager',referee:'Arbitro',fan:'Tifoso'})[role]||role}
function dashLayout(body,section='overview'){
  const league=[['overview','Panoramica'],['seasons','Stagioni'],['calendar','Calendario'],['matches','Partite'],['teams','Squadre'],['players','Giocatori'],['submissions','Referti'],['media','Media'],['sponsors','Sponsor'],['news','News'],['polls','Votazioni']];
  if(['super_admin','organizer'].includes(state.user.role)) league.splice(6,0,['users','Account']);
  const teamNav=[['overview','Panoramica'],['profile','Profilo squadra'],['players','Rosa'],['matches','Partite e referti'],['sponsors','Sponsor']];
  const refereeNav=[['overview','Panoramica'],['matches','Partite e referti']];
  const items=['super_admin','organizer'].includes(state.user.role)?league:state.user.role==='referee'?refereeNav:teamNav;
  return `<div class="dashboard"><aside class="card sidebar"><div class="admin-user-chip"><b>${esc(state.user.display_name)}</b><span>${esc(adminRoleLabel(state.user.role))}</span></div>${items.map(([r,l])=>`<a class="${section===r?'active':''}" href="#/dashboard/${r}">${l}</a>`).join('')}<button id="logout" class="btn danger" style="width:100%;margin-top:12px">Esci</button></aside><section>${body}</section></div>`;
}
function bindLogout(){const b=document.querySelector('#logout');if(b)b.onclick=async()=>{await api('auth/logout',{method:'POST'});state.user=null;location.hash='#/home'}}
async function dashboard(section='overview'){
  if(!state.user){location.hash='#/login';return} loading();

  if(section==='overview'){
    const isLeagueAdmin=['super_admin','organizer'].includes(state.user.role);

    if(!isLeagueAdmin){
      const d=await api('dashboard');

      if(!document.querySelector('link[data-prime-dashboard]')){
        const link=document.createElement('link');
        link.rel='stylesheet';
        link.href='/assets/dashboard-admin.css';
        link.dataset.primeDashboard='1';
        document.head.appendChild(link);
      }

      if(state.user.role==='team_manager'){
        const team=d.team||{};
        const counts=d.counts||{};
        set(dashLayout(`<div class="admin-page-head dashboard-admin-head">
          <div><span class="eyebrow">Area squadra</span><h2>${esc(team.name||state.user.display_name)}</h2><p>Gestisci la tua rosa, le partite, gli sponsor e gli invii della squadra.</p></div>
          <span class="dashboard-season-pill">Account squadra</span>
        </div>

        <section class="dashboard-kpis team-dashboard-kpis">
          <a href="#/dashboard/players"><span>Giocatori attivi</span><b>${counts.players||0}</b><small>presenti nella rosa</small></a>
          <a href="#/dashboard/matches"><span>Partite</span><b>→</b><small>calendario e risultati</small></a>
          <a href="#/dashboard/sponsors"><span>Sponsor squadra</span><b>${counts.sponsors||0}</b><small>partner inseriti</small></a>
          <a href="#/dashboard/matches" class="${Number(counts.pending||0)>0?'warning':''}"><span>Invii in attesa</span><b>${counts.pending||0}</b><small>referti inviati</small></a>
        </section>

        <section class="dashboard-panel dashboard-actions-panel">
          <div class="dashboard-panel-head"><div><span>Gestione squadra</span><h3>Azioni rapide</h3></div></div>
          <div class="dashboard-actions team-dashboard-actions">
            <a href="#/dashboard/profile"><span>◫</span><strong>Profilo squadra</strong><small>Aggiorna logo, colori e contatti</small></a>
            <a href="#/dashboard/players"><span>◎</span><strong>Gestisci rosa</strong><small>Aggiungi e modifica i giocatori</small></a>
            <a href="#/dashboard/matches"><span>⚽</span><strong>Partite</strong><small>Consulta calendario e risultati</small></a>
            <a href="#/dashboard/sponsors"><span>★</span><strong>Sponsor</strong><small>Gestisci i partner della squadra</small></a>
          </div>
        </section>

        <section class="dashboard-panel team-profile-panel">
          <div class="dashboard-panel-head"><div><span>Profilo</span><h3>Dati della squadra</h3></div></div>
          <div class="team-dashboard-profile">
            ${logo(team.logo_url,team.name||'Squadra')}
            <div><strong>${esc(team.name||'Squadra non collegata')}</strong><span>${esc(team.short_name||'')}</span><small>${esc(team.venue||team.city||'')}</small></div>
          </div>
        </section>`,section),'');
        bindLogout();
        return;
      }

      if(state.user.role==='referee'){
        set(dashLayout(`<div class="admin-page-head dashboard-admin-head">
          <div><span class="eyebrow">Area arbitro</span><h2>Ciao, ${esc(state.user.display_name)}</h2><p>Consulta le partite assegnate e compila i referti.</p></div>
          <span class="dashboard-season-pill">Account arbitro</span>
        </div>

        <section class="dashboard-panel dashboard-actions-panel">
          <div class="dashboard-panel-head"><div><span>Operazioni</span><h3>Le tue attività</h3></div></div>
          <div class="dashboard-actions referee-dashboard-actions">
            <a href="#/dashboard/matches"><span>⚽</span><strong>Partite assegnate</strong><small>Visualizza le gare da dirigere</small></a>
            <a href="#/dashboard/matches"><span>✓</span><strong>Compila referto</strong><small>Inserisci risultato, eventi e MVP</small></a>
          </div>
        </section>`,section),'');
        bindLogout();
        return;
      }
    }

    const d=await api('admin/dashboard');

    if(!document.querySelector('link[data-prime-dashboard]')){
      const link=document.createElement('link');
      link.rel='stylesheet';
      link.href='/assets/dashboard-admin.css';
      link.dataset.primeDashboard='1';
      document.head.appendChild(link);
    }

    const upcoming=d.upcoming||[];
    const recent=d.recent||[];
    const pending=d.pending_reports||[];
    const stats=d.stats||{};
    const alerts=d.alerts||{};
    const season=d.season||null;

    const matchMini=(m,mode='upcoming')=>`<article class="dashboard-match-card">
      <div class="dashboard-match-top"><span>${esc(m.round_name||'Prime League')}</span><strong>${fmtDate(m.match_date)}</strong></div>
      <div class="dashboard-match-teams">
        <div>${logo(m.home_logo,m.home_name)}<span>${esc(m.home_name)}</span></div>
        <b>${mode==='recent'?`${m.home_score??0} – ${m.away_score??0}`:'VS'}</b>
        <div>${logo(m.away_logo,m.away_name)}<span>${esc(m.away_name)}</span></div>
      </div>
      <div class="dashboard-match-bottom">
        <span>${esc(m.venue||'Campo da definire')}</span>
        <button class="btn small dashboard-open-match" data-id="${m.id}">${mode==='recent'?'Apri':'Gestisci'}</button>
      </div>
    </article>`;

    const alertItems=[
      {count:Number(alerts.teams_without_logo||0),label:'Squadre senza stemma',route:'teams'},
      {count:Number(alerts.teams_without_coach||0),label:'Squadre senza allenatore',route:'teams'},
      {count:Number(alerts.players_without_photo||0),label:'Giocatori senza foto',route:'players'},
      {count:Number(alerts.matches_without_venue||0),label:'Partite senza campo',route:'matches'},
      {count:Number(alerts.pending_submissions||0),label:'Invii squadra da verificare',route:'submissions'}
    ];

    set(dashLayout(`<div class="admin-page-head dashboard-admin-head">
      <div><span class="eyebrow">Centro di controllo</span><h2>Panoramica</h2><p>${season?`Stagione attiva: ${esc(season.name)}`:'Nessuna stagione attiva configurata'}</p></div>
      <div class="dashboard-season-pill">${season?esc(stats.current_round||'Giornata da definire'):'Configura stagione'}</div>
    </div>

    <section class="dashboard-kpis">
      <a href="#/dashboard/teams"><span>Squadre attive</span><b>${stats.active_teams||0}</b><small>su ${stats.total_teams||0} totali</small></a>
      <a href="#/dashboard/players"><span>Giocatori attivi</span><b>${stats.active_players||0}</b><small>tesserati disponibili</small></a>
      <a href="#/dashboard/matches"><span>Partite disputate</span><b>${stats.played_matches||0}</b><small>${stats.upcoming_matches||0} ancora da giocare</small></a>
      <a href="#/dashboard/submissions" class="${Number(stats.missing_reports||0)>0?'warning':''}"><span>Referti mancanti</span><b>${stats.missing_reports||0}</b><small>${stats.pending_submissions||0} invii in attesa</small></a>
    </section>

    <section class="dashboard-main-grid">
      <div class="dashboard-panel">
        <div class="dashboard-panel-head"><div><span>Calendario</span><h3>Prossime partite</h3></div><a class="btn small" href="#/dashboard/matches">Vedi tutte</a></div>
        <div class="dashboard-match-list">${upcoming.map(m=>matchMini(m)).join('')||'<div class="dashboard-empty">Nessuna partita in programma.</div>'}</div>
      </div>

      <div class="dashboard-panel">
        <div class="dashboard-panel-head"><div><span>Controlli</span><h3>Referti da completare</h3></div><a class="btn small" href="#/dashboard/submissions">Apri referti</a></div>
        <div class="dashboard-report-list">${pending.map(r=>`<article>
          <div><span>${esc(r.round_name||'Prime League')}</span><strong>${esc(r.home_name)} – ${esc(r.away_name)}</strong><small>${r.reason==='pending_submission'?'Invio squadra da verificare':'Risultato ancora da inserire'}</small></div>
          <button class="btn small dashboard-report" data-id="${r.id}">Compila</button>
        </article>`).join('')||'<div class="dashboard-empty success">Tutti i referti sono aggiornati.</div>'}</div>
      </div>
    </section>

    <section class="dashboard-secondary-grid">
      <div class="dashboard-panel">
        <div class="dashboard-panel-head"><div><span>Risultati</span><h3>Ultime partite</h3></div><a class="btn small" href="#/dashboard/matches">Archivio</a></div>
        <div class="dashboard-match-list">${recent.map(m=>matchMini(m,'recent')).join('')||'<div class="dashboard-empty">Nessun risultato pubblicato.</div>'}</div>
      </div>

      <div class="dashboard-panel">
        <div class="dashboard-panel-head"><div><span>Qualità dati</span><h3>Avvisi</h3></div></div>
        <div class="dashboard-alert-list">${alertItems.map(a=>`<a class="dashboard-alert ${a.count===0?'ok':''}" href="#/dashboard/${a.route}">
          <span>${a.count===0?'✓':'!'}</span><div><strong>${a.label}</strong><small>${a.count===0?'Nessuna anomalia':`${a.count} elementi da controllare`}</small></div><b>›</b>
        </a>`).join('')}</div>
      </div>
    </section>

    <section class="dashboard-panel dashboard-actions-panel">
      <div class="dashboard-panel-head"><div><span>Operazioni</span><h3>Azioni rapide</h3></div></div>
      <div class="dashboard-actions">
        <a href="#/dashboard/teams"><span>＋</span><strong>Nuova squadra</strong><small>Gestisci identità e rosa</small></a>
        <a href="#/dashboard/players"><span>＋</span><strong>Nuovo giocatore</strong><small>Aggiungi alla rosa</small></a>
        <a href="#/dashboard/matches"><span>＋</span><strong>Nuova partita</strong><small>Crea o modifica una gara</small></a>
        <a href="#/dashboard/calendar"><span>▦</span><strong>Calendario</strong><small>Genera o modifica giornate</small></a>
        <a href="#/dashboard/submissions"><span>✓</span><strong>Compila referto</strong><small>Risultati ed eventi</small></a>
        <a href="#/dashboard/news"><span>✎</span><strong>Nuova news</strong><small>Pubblica un aggiornamento</small></a>
        <a href="#/dashboard/sponsors"><span>★</span><strong>Aggiungi sponsor</strong><small>Gestisci partner e loghi</small></a>
      </div>
    </section>`,section),'');
    bindLogout();

    document.querySelectorAll('.dashboard-open-match,.dashboard-report').forEach(btn=>btn.onclick=()=>{
      state.pendingReportMatchId=Number(btn.dataset.id);
      manageMatches();
    });
    return;
  }

  if(section==='seasons') return manageSeasons();
  if(section==='calendar') return manageCalendar();
  if(section==='teams') return adminTeams();
  if(section==='profile') return teamProfile();
  if(section==='players') return managePlayers();
  if(section==='matches') return manageMatches();
  if(section==='submissions') return submissions();
  if(section==='media') return manageMedia();
  if(section==='users') return users();
  if(section==='sponsors') return sponsors();
  if(section==='news') return manageNews();
  if(section==='polls') return managePolls();
}
async function manageSeasons(){
  const d=await api('admin/seasons');
  const rows=(d.seasons||[]).map(s=>`<tr><td><b>${esc(s.name)}</b>${s.is_current?'<span class="admin-current-badge">In corso</span>':''}</td><td>${esc(s.competition_name||'Prime League')}</td><td>${s.start_date?fmtDate(s.start_date):'—'}</td><td>${s.end_date?fmtDate(s.end_date):'—'}</td><td><div class="admin-row-actions"><button class="btn small edit-season" data-id="${s.id}">Modifica</button>${!s.is_current?`<button class="btn small primary current-season" data-id="${s.id}">Imposta attuale</button>`:''}<button class="btn small danger delete-season" data-id="${s.id}">Elimina</button></div></td></tr>`).join('');
  set(dashLayout(`<div class="admin-page-head"><div><span class="eyebrow">Archivio competizione</span><h2>Stagioni</h2><p>Gestisci la stagione attuale e conserva lo storico completo della Prime League.</p></div><button class="btn primary" id="new-season">Nuova stagione</button></div><div id="editor"></div><div class="admin-table-card"><table class="table"><thead><tr><th>Stagione</th><th>Competizione</th><th>Inizio</th><th>Fine</th><th>Azioni</th></tr></thead><tbody>${rows||'<tr><td colspan="5">Nessuna stagione.</td></tr>'}</tbody></table></div>`,'seasons'),'');bindLogout();
  const openForm=(season={})=>showForm('editor',`<div class="admin-editor-card"><div class="admin-editor-head"><div><span class="eyebrow">${season.id?'Modifica':'Nuova'}</span><h3>${season.id?esc(season.name):'Crea stagione'}</h3></div><button type="button" class="admin-close-editor" onclick="document.querySelector('#editor').innerHTML=''">×</button></div><form class="form-grid data-form"><div class="field full"><label>Nome stagione</label><input class="input" name="name" value="${esc(season.name||'Stagione 2027/28')}" required></div><div class="field"><label>Data inizio</label><input class="input" type="date" name="start_date" value="${esc(season.start_date||'')}"></div><div class="field"><label>Data fine</label><input class="input" type="date" name="end_date" value="${esc(season.end_date||'')}"></div><div class="field full"><label class="admin-check"><input type="checkbox" name="is_current" value="1" ${season.is_current?'checked':''}> Imposta come stagione attuale</label></div><div class="field full"><button class="btn primary">${season.id?'Salva modifiche':'Crea stagione'}</button></div></form></div>`,async f=>{f.is_current=f.is_current==='1';await api(season.id?`admin/seasons/${season.id}`:'admin/seasons',{method:season.id?'PUT':'POST',body:JSON.stringify(f)});manageSeasons()});
  document.querySelector('#new-season').onclick=()=>openForm();
  document.querySelectorAll('.edit-season').forEach(b=>b.onclick=()=>openForm(d.seasons.find(s=>Number(s.id)===Number(b.dataset.id))));
  document.querySelectorAll('.current-season').forEach(b=>b.onclick=async()=>{await api(`admin/seasons/${b.dataset.id}/current`,{method:'POST',body:'{}'});manageSeasons()});
  document.querySelectorAll('.delete-season').forEach(b=>b.onclick=async()=>{if(confirm('Eliminare questa stagione e tutte le partite collegate?')){await api(`admin/seasons/${b.dataset.id}`,{method:'DELETE'});manageSeasons()}});
}

async function loadTeams(){state.teams=(await api('public/teams')).teams}
async function adminTeams(){
  const [teamsData,playersData]=await Promise.all([
    api('admin/teams'),
    api('admin/players').catch(()=>({players:[]}))
  ]);
  const teams=[...(teamsData.teams||[])];
  const players=playersData.players||[];

  if(!document.querySelector('link[data-prime-teams-admin]')){
    const link=document.createElement('link');
    link.rel='stylesheet';
    link.href='/assets/teams-admin.css';
    link.dataset.primeTeamsAdmin='1';
    document.head.appendChild(link);
  }

  const playerCount=id=>players.filter(p=>Number(p.team_id)===Number(id)&&Number(p.is_active)!==0).length;
  const activeCount=teams.filter(t=>Number(t.is_active)!==0).length;
  const withCoach=teams.filter(t=>String(t.coach_name||'').trim()).length;

  const teamCard=t=>`<article class="team-admin-card"
    data-id="${t.id}"
    data-status="${Number(t.is_active)!==0?'active':'inactive'}"
    data-name="${esc((t.name||'').toLowerCase())}"
    data-search="${esc(`${t.name||''} ${t.short_name||''} ${t.coach_name||''} ${t.manager_name||''}`.toLowerCase())}"
    data-players="${playerCount(t.id)}">
    <div class="team-admin-accent" style="--primary:${esc(t.primary_color||'#0b2348')};--secondary:${esc(t.secondary_color||'#ffffff')}"></div>
    <div class="team-admin-card-head">
      <div class="team-admin-logo">${t.logo_url?`<img src="${esc(t.logo_url)}" alt="${esc(t.name)}">`:`<span>${esc(initials(t.name))}</span>`}</div>
      <div class="team-admin-title">
        <span>${esc(t.short_name||'Nessuna sigla')}</span>
        <h3>${esc(t.name)}</h3>
        <div class="team-admin-colors"><i style="background:${esc(t.primary_color||'#0b2348')}"></i><i style="background:${esc(t.secondary_color||'#ffffff')}"></i></div>
      </div>
      <span class="team-admin-status ${Number(t.is_active)!==0?'active':'inactive'}">${Number(t.is_active)!==0?'Attiva':'Non attiva'}</span>
    </div>
    <div class="team-admin-details">
      <div><span>Allenatore</span><strong>${esc(t.coach_name||'Da definire')}</strong></div>
      <div><span>Responsabile</span><strong>${esc(t.manager_name||'Da definire')}</strong></div>
      <div><span>Giocatori attivi</span><strong>${playerCount(t.id)}</strong></div>
    </div>
    <div class="team-admin-actions">
      <button class="btn small edit-team" data-id="${t.id}">Modifica</button>
      <button class="btn small team-roster" data-id="${t.id}">Apri rosa</button>
      <button class="btn small danger delete-team" data-id="${t.id}">Elimina</button>
    </div>
  </article>`;

  set(dashLayout(`<div class="admin-page-head teams-admin-head">
      <div><span class="eyebrow">Gestione completa</span><h2>Squadre</h2><p>Gestisci identità, staff, colori, stemmi e rose delle squadre.</p></div>
      <button class="btn primary" id="new-team">Nuova squadra</button>
    </div>
    <div id="editor"></div>

    <section class="teams-admin-summary">
      <div><span>Squadre totali</span><b>${teams.length}</b></div>
      <div><span>Attive</span><b>${activeCount}</b></div>
      <div><span>Non attive</span><b>${teams.length-activeCount}</b></div>
      <div><span>Con allenatore</span><b>${withCoach}</b></div>
    </section>

    <section class="teams-admin-toolbar">
      <div class="field teams-search-field"><label>Cerca squadra</label><input class="input" id="teams-search" placeholder="Nome, sigla, allenatore o responsabile"></div>
      <div class="field"><label>Stato</label><select class="input" id="teams-status"><option value="">Tutte</option><option value="active">Attive</option><option value="inactive">Non attive</option></select></div>
      <div class="field"><label>Ordina per</label><select class="input" id="teams-sort"><option value="name">Nome</option><option value="players">Numero giocatori</option><option value="status">Stato</option></select></div>
      <button class="btn small" id="teams-reset" type="button">Azzera filtri</button>
    </section>

    <div class="teams-results-bar"><span id="teams-result-count">${teams.length} squadre</span><span>Clicca “Apri rosa” per vedere i giocatori collegati</span></div>

    <section class="teams-admin-grid" id="teams-admin-grid">${teams.map(teamCard).join('')||'<div class="teams-admin-empty">Nessuna squadra presente.</div>'}</section>
    <div class="teams-admin-empty" id="teams-filter-empty" hidden>Nessuna squadra corrisponde ai filtri selezionati.</div>`,'teams'),'');
  bindLogout();

  const openForm=(t={})=>showForm('editor',teamForm(t),async(f,form)=>{
    f.is_active=f.is_active==='1'?1:0;
    const existing=form.querySelector('[name="existing_media_url"]')?.value||'';
    const remove=form.querySelector('[name="remove_media"]')?.value==='1';
    const file=form.querySelector('[name="logo_file"]')?.files?.[0];
    f.logo_url=remove?'':await uploadMediaFile(file,'teams',existing,900);
    if(remove&&existing)await api('admin/media/delete',{method:'POST',body:JSON.stringify({url:existing})}).catch(()=>{});
    delete f.logo_file;delete f.existing_media_url;delete f.remove_media;
    await api(t.id?`admin/teams/${t.id}`:'admin/teams',{method:t.id?'PUT':'POST',body:JSON.stringify(f)});
    adminTeams();
  });

  const cards=[...document.querySelectorAll('.team-admin-card')];
  const applyFilters=()=>{
    const search=(document.querySelector('#teams-search').value||'').toLowerCase().trim();
    const status=document.querySelector('#teams-status').value;
    const sort=document.querySelector('#teams-sort').value;
    const visible=cards.filter(card=>{
      const show=(!search||card.dataset.search.includes(search))&&(!status||card.dataset.status===status);
      card.hidden=!show;
      return show;
    });

    visible.sort((a,b)=>{
      if(sort==='players')return Number(b.dataset.players)-Number(a.dataset.players)||a.dataset.name.localeCompare(b.dataset.name);
      if(sort==='status')return a.dataset.status.localeCompare(b.dataset.status)||a.dataset.name.localeCompare(b.dataset.name);
      return a.dataset.name.localeCompare(b.dataset.name);
    });

    const grid=document.querySelector('#teams-admin-grid');
    visible.forEach(card=>grid.appendChild(card));
    cards.filter(card=>card.hidden).forEach(card=>grid.appendChild(card));
    document.querySelector('#teams-result-count').textContent=`${visible.length} ${visible.length===1?'squadra':'squadre'}`;
    document.querySelector('#teams-filter-empty').hidden=visible.length>0;
  };

  document.querySelector('#teams-search').addEventListener('input',applyFilters);
  document.querySelector('#teams-status').addEventListener('change',applyFilters);
  document.querySelector('#teams-sort').addEventListener('change',applyFilters);
  document.querySelector('#teams-reset').onclick=()=>{
    document.querySelector('#teams-search').value='';
    document.querySelector('#teams-status').value='';
    document.querySelector('#teams-sort').value='name';
    applyFilters();
  };

  document.querySelector('#new-team').onclick=()=>openForm();
  document.querySelectorAll('.edit-team').forEach(btn=>btn.onclick=()=>openForm(teams.find(x=>Number(x.id)===Number(btn.dataset.id))));
  document.querySelectorAll('.team-roster').forEach(btn=>btn.onclick=()=>{
    const team=teams.find(x=>Number(x.id)===Number(btn.dataset.id));
    location.hash=`#/dashboard/players`;
    setTimeout(()=>{
      const select=document.querySelector('#players-team');
      if(select){select.value=String(team.id);select.dispatchEvent(new Event('change'))}
    },250);
  });
  document.querySelectorAll('.delete-team').forEach(btn=>btn.onclick=async()=>{
    const team=teams.find(x=>Number(x.id)===Number(btn.dataset.id));
    const count=playerCount(btn.dataset.id);
    if(confirm(`Eliminare definitivamente ${team?.name||'questa squadra'}? Verranno eliminati anche ${count} giocatori e tutte le partite collegate.`)){
      await api(`admin/teams/${btn.dataset.id}?hard=1`,{method:'DELETE'});
      adminTeams();
    }
  });

  applyFilters();
}
function teamForm(t={}){return `<div class="admin-editor-card"><h3>${t.id?'Modifica squadra':'Nuova squadra'}</h3><form class="form-grid data-form"><div class="field"><label>Nome</label><input class="input" name="name" value="${esc(t.name||'')}" required></div><div class="field"><label>Sigla</label><input class="input" name="short_name" value="${esc(t.short_name||'')}"></div><div class="field"><label>Responsabile</label><input class="input" name="manager_name" value="${esc(t.manager_name||'')}"></div><div class="field"><label>Allenatore</label><input class="input" name="coach_name" value="${esc(t.coach_name||'')}"></div><div class="field"><label>Colore principale</label><input class="input" type="color" name="primary_color" value="${esc(t.primary_color||'#081a36')}"></div><div class="field"><label>Colore secondario</label><input class="input" type="color" name="secondary_color" value="${esc(t.secondary_color||'#ffffff')}"></div>${mediaPicker({name:'logo_file',current:t.logo_url||'',label:'Stemma squadra',shape:'logo'})}<div class="field full"><label>Descrizione</label><textarea class="input" name="description">${esc(t.description||'')}</textarea></div>${t.id?`<div class="field full"><label class="admin-check"><input type="checkbox" name="is_active" value="1" ${t.is_active?'checked':''}> Squadra attiva</label></div>`:'<input type="hidden" name="is_active" value="1">'}<div class="field full"><button class="btn primary">${t.id?'Salva modifiche':'Crea squadra'}</button></div></form></div>`}
function showForm(id,html,handler){document.querySelector('#'+id).innerHTML=html;const form=document.querySelector('#'+id+' form');if(!form)return;bindMediaPicker(form);form.onsubmit=async e=>{e.preventDefault();const data=Object.fromEntries(new FormData(e.target));try{await handler(data,e.target)}catch(err){alert(err.message)}}}

async function teamProfile(){
  if(state.user.role!=='team_manager'){location.hash='#/dashboard';return}
  const d=await api('team/profile');
  const team=d.team||{};
  const details=d.details||{};

  if(!document.querySelector('link[data-prime-team-area]')){
    const link=document.createElement('link');link.rel='stylesheet';link.href='/assets/team-area.css';link.dataset.primeTeamArea='1';document.head.appendChild(link);
  }

  set(dashLayout(`<div class="admin-page-head">
    <div><span class="eyebrow">Identità della squadra</span><h2>Profilo squadra</h2><p>Aggiorna i dati pubblici e i contatti della tua società.</p></div>
  </div>
  <div id="team-profile-message"></div>
  <section class="team-profile-editor">
    <form class="form-grid" id="team-profile-form">
      <div class="field full">${mediaPicker({name:'team_logo_file',current:team.logo_url||'',label:'Stemma della squadra',shape:'logo'})}</div>
      <div class="field"><label>Nome squadra</label><input class="input" value="${esc(team.name||'')}" disabled><small>Il nome ufficiale può essere modificato soltanto dall’Admin.</small></div>
      <div class="field"><label>Nome breve</label><input class="input" name="short_name" maxlength="12" value="${esc(team.short_name||'')}"></div>
      <div class="field"><label>Colore principale</label><input class="input color-input" type="color" name="primary_color" value="${esc(team.primary_color||'#07172f')}"></div>
      <div class="field"><label>Colore secondario</label><input class="input color-input" type="color" name="secondary_color" value="${esc(team.secondary_color||'#ffffff')}"></div>
      <div class="field"><label>Allenatore</label><input class="input" name="coach_name" value="${esc(team.coach_name||'')}"></div>
      <div class="field"><label>Dirigente responsabile</label><input class="input" name="manager_name" value="${esc(team.manager_name||'')}"></div>
      <div class="field"><label>Città</label><input class="input" name="city" value="${esc(details.city||'')}"></div>
      <div class="field"><label>Campo di casa</label><input class="input" name="home_venue" value="${esc(details.home_venue||'')}"></div>
      <div class="field"><label>Telefono</label><input class="input" name="phone" value="${esc(details.phone||'')}"></div>
      <div class="field"><label>Email pubblica</label><input class="input" type="email" name="public_email" value="${esc(details.public_email||'')}"></div>
      <div class="field"><label>Instagram</label><input class="input" name="instagram_url" value="${esc(details.instagram_url||'')}" placeholder="https://instagram.com/..."></div>
      <div class="field"><label>Facebook</label><input class="input" name="facebook_url" value="${esc(details.facebook_url||'')}" placeholder="https://facebook.com/..."></div>
      <div class="field full"><label>Descrizione</label><textarea class="input" name="description" rows="5">${esc(team.description||'')}</textarea></div>
      <div class="field full"><button class="btn primary" id="save-team-profile">Salva profilo</button></div>
    </form>
  </section>`,'profile'),'');
  bindLogout();

  const form=document.querySelector('#team-profile-form');
  bindMediaPicker(form);
  form.onsubmit=async e=>{
    e.preventDefault();
    const button=document.querySelector('#save-team-profile');
    button.disabled=true;button.textContent='Salvataggio...';
    try{
      const fd=new FormData(form);
      const file=form.querySelector('[name="team_logo_file"]')?.files?.[0];
      let logoUrl=team.logo_url||'';
      if(fd.get('remove_media')==='1')logoUrl='';
      if(file)logoUrl=(await uploadMediaFile(file,'logos',logoUrl)).url;
      const payload=Object.fromEntries(fd);
      payload.logo_url=logoUrl;
      delete payload.team_logo_file;delete payload.existing_media_url;delete payload.remove_media;
      await api('team/profile',{method:'PUT',body:JSON.stringify(payload)});
      document.querySelector('#team-profile-message').innerHTML=message('Profilo squadra aggiornato correttamente.','success');
      setTimeout(teamProfile,700);
    }catch(err){
      document.querySelector('#team-profile-message').innerHTML=message(err.message,'error');
      button.disabled=false;button.textContent='Salva profilo';
    }
  };
}

async function teamRoster(){
  const d=await api('team/players');
  const players=d.players||[];
  const roles=[...new Set(players.map(p=>p.role).filter(Boolean))].sort();
  const active=players.filter(p=>Number(p.is_active)!==0).length;

  if(!document.querySelector('link[data-prime-team-area]')){
    const link=document.createElement('link');link.rel='stylesheet';link.href='/assets/team-area.css';link.dataset.primeTeamArea='1';document.head.appendChild(link);
  }

  const card=p=>`<article class="team-player-card" data-search="${esc(`${p.first_name} ${p.last_name} ${p.role||''} ${p.shirt_number||''}`.toLowerCase())}" data-role="${esc(p.role||'')}" data-status="${Number(p.is_active)!==0?'active':'inactive'}">
    <div class="team-player-photo">${avatar(p.photo_url,`${p.first_name} ${p.last_name}`)}${p.shirt_number?`<b>#${p.shirt_number}</b>`:''}</div>
    <div class="team-player-info"><span>${esc(p.role||'Ruolo non indicato')}</span><h3>${esc(p.first_name)} ${esc(p.last_name)}</h3><small>${Number(p.is_active)!==0?'Giocatore attivo':'Giocatore inattivo'}</small></div>
    <div class="team-player-actions"><button class="btn small edit-team-player" data-id="${p.id}">Modifica</button><button class="btn small ${Number(p.is_active)!==0?'deactivate-player':'activate-player'}" data-id="${p.id}">${Number(p.is_active)!==0?'Disattiva':'Riattiva'}</button></div>
  </article>`;

  set(dashLayout(`<div class="admin-page-head">
    <div><span class="eyebrow">Gestione rosa</span><h2>La tua squadra</h2><p>Gestisci giocatori, numeri di maglia, ruoli e stato della rosa.</p></div>
    <button class="btn primary" id="new-team-player">Nuovo giocatore</button>
  </div>
  <section class="team-roster-summary"><div><span>Totale rosa</span><b>${players.length}</b></div><div><span>Attivi</span><b>${active}</b></div><div><span>Inattivi</span><b>${players.length-active}</b></div></section>
  <div id="editor"></div>
  <section class="team-roster-filters">
    <div class="field"><label>Cerca</label><input class="input" id="team-player-search" placeholder="Nome, numero o ruolo"></div>
    <div class="field"><label>Ruolo</label><select class="input" id="team-player-role"><option value="">Tutti</option>${roles.map(r=>`<option value="${esc(r)}">${esc(r)}</option>`).join('')}</select></div>
    <div class="field"><label>Stato</label><select class="input" id="team-player-status"><option value="">Tutti</option><option value="active">Attivi</option><option value="inactive">Inattivi</option></select></div>
    <span id="team-player-count"></span>
  </section>
  <section class="team-roster-grid">${players.map(card).join('')||'<div class="team-area-empty">La rosa è ancora vuota.</div>'}</section>`,'players'),'');
  bindLogout();

  const apply=()=>{
    const q=(document.querySelector('#team-player-search').value||'').toLowerCase().trim();
    const role=document.querySelector('#team-player-role').value;
    const status=document.querySelector('#team-player-status').value;
    let visible=0;
    document.querySelectorAll('.team-player-card').forEach(c=>{
      const show=(!q||c.dataset.search.includes(q))&&(!role||c.dataset.role===role)&&(!status||c.dataset.status===status);
      c.hidden=!show;if(show)visible++;
    });
    document.querySelector('#team-player-count').textContent=`${visible} giocatori`;
  };
  ['team-player-search','team-player-role','team-player-status'].forEach(id=>document.querySelector('#'+id).addEventListener(id==='team-player-search'?'input':'change',apply));

  const open=(p={})=>{
    showForm('editor',`<div class="admin-editor-card"><h3>${p.id?'Modifica giocatore':'Nuovo giocatore'}</h3><form class="form-grid team-player-form">
      <div class="field full">${mediaPicker({name:'player_photo_file',current:p.photo_url||'',label:'Foto giocatore',shape:'portrait'})}</div>
      <div class="field"><label>Nome</label><input class="input" name="first_name" value="${esc(p.first_name||'')}" required></div>
      <div class="field"><label>Cognome</label><input class="input" name="last_name" value="${esc(p.last_name||'')}" required></div>
      <div class="field"><label>Numero di maglia</label><input class="input" type="number" min="1" max="99" name="shirt_number" value="${p.shirt_number||''}"></div>
      <div class="field"><label>Ruolo</label><select class="input" name="role" required><option value="">Seleziona</option>${['Portiere','Difensore','Centrocampista','Attaccante'].map(r=>`<option value="${r}" ${p.role===r?'selected':''}>${r}</option>`).join('')}</select></div>
      ${p.id?`<div class="field full"><label class="admin-check"><input type="checkbox" name="is_active" value="1" ${Number(p.is_active)!==0?'checked':''}> Giocatore attivo</label></div>`:''}
      <div class="field full"><button class="btn primary">${p.id?'Salva modifiche':'Aggiungi alla rosa'}</button></div>
    </form></div>`,async data=>{
      const form=document.querySelector('.team-player-form');
      const file=form.querySelector('[name="player_photo_file"]')?.files?.[0];
      let photo=p.photo_url||'';
      const fd=new FormData(form);
      if(fd.get('remove_media')==='1')photo='';
      if(file)photo=(await uploadMediaFile(file,'players',photo)).url;
      data.photo_url=photo;data.is_active=p.id?(data.is_active==='1'?1:0):1;
      delete data.player_photo_file;delete data.existing_media_url;delete data.remove_media;
      await api(p.id?`team/players/${p.id}`:'team/players',{method:p.id?'PUT':'POST',body:JSON.stringify(data)});
      teamRoster();
    });
    bindMediaPicker(document.querySelector('.team-player-form'));
  };

  document.querySelector('#new-team-player').onclick=()=>open();
  document.querySelectorAll('.edit-team-player').forEach(b=>b.onclick=()=>open(players.find(p=>Number(p.id)===Number(b.dataset.id))));
  document.querySelectorAll('.deactivate-player,.activate-player').forEach(b=>b.onclick=async()=>{
    const p=players.find(x=>Number(x.id)===Number(b.dataset.id));
    await api(`team/players/${p.id}`,{method:'PUT',body:JSON.stringify({...p,is_active:b.classList.contains('activate-player')?1:0})});
    teamRoster();
  });
  apply();
}

async function teamMatchesArea(){
  const [d,pd]=await Promise.all([api('team/matches'),api('team/players')]);
  const matches=d.matches||[];
  const players=pd.players||[];
  const now=Date.now();

  if(!document.querySelector('link[data-prime-team-area]')){
    const link=document.createElement('link');link.rel='stylesheet';link.href='/assets/team-area.css';link.dataset.primeTeamArea='1';document.head.appendChild(link);
  }

  const stateOf=m=>{
    if(m.submission_status==='pending')return 'pending';
    if(m.submission_status==='rejected')return 'rejected';
    if(m.submission_status==='approved'||m.status==='published')return 'completed';
    return new Date(m.match_date).getTime()>now?'upcoming':'todo';
  };
  const labels={upcoming:'Prossime',todo:'Da completare',pending:'In attesa',rejected:'Da correggere',completed:'Concluse'};
  const counts=Object.fromEntries(Object.keys(labels).map(k=>[k,matches.filter(m=>stateOf(m)===k).length]));

  const card=m=>{
    const st=stateOf(m);
    const opponent=Number(m.home_team_id)===Number(state.user.team_id)?m.away_name:m.home_name;
    return `<article class="team-match-card" data-state="${st}" data-search="${esc(`${m.home_name} ${m.away_name} ${m.round_name||''}`.toLowerCase())}">
      <div class="team-match-head"><div><span>${esc(m.round_name||'Prime League')}</span><strong>${fmtDate(m.match_date)}</strong></div><span class="team-match-state ${st}">${labels[st]}</span></div>
      <div class="team-match-score"><div><strong>${esc(m.home_name)}</strong></div><b>${m.status==='published'?`${m.home_score??0} – ${m.away_score??0}`:'VS'}</b><div><strong>${esc(m.away_name)}</strong></div></div>
      <div class="team-match-meta"><span>${esc(m.venue||'Campo da definire')}</span><span>Avversario: ${esc(opponent)}</span></div>
      ${m.submission_status==='rejected'?`<div class="team-rejection"><strong>Referto da correggere</strong><span>${esc(m.admin_note||'Controlla i dati e invialo nuovamente.')}</span></div>`:''}
      <div class="team-match-actions">
        ${['upcoming','todo','rejected'].includes(st)?`<button class="btn primary small submit-team-report" data-id="${m.id}">${st==='rejected'?'Correggi e reinvia':'Compila referto'}</button>`:''}
        ${st==='pending'?'<span class="team-waiting">In attesa di approvazione Admin</span>':''}
        <a class="btn small" href="#/partita/${m.id}">Scheda partita</a>
      </div>
    </article>`;
  };

  set(dashLayout(`<div class="admin-page-head"><div><span class="eyebrow">Calendario squadra</span><h2>Partite e referti</h2><p>Consulta le gare e invia all’Admin i dati delle partite concluse.</p></div></div>
  <section class="team-match-tabs">${Object.entries(labels).map(([k,l])=>`<button data-tab="${k}" class="${k==='upcoming'?'active':''}"><span>${l}</span><b>${counts[k]}</b></button>`).join('')}<button data-tab="all"><span>Tutte</span><b>${matches.length}</b></button></section>
  <div id="editor"></div>
  <section class="team-match-toolbar"><div class="field"><label>Cerca</label><input class="input" id="team-match-search" placeholder="Avversario o giornata"></div><span id="team-match-count"></span></section>
  <section class="team-match-grid">${matches.map(card).join('')||'<div class="team-area-empty">Nessuna partita disponibile.</div>'}</section>`,'matches'),'');
  bindLogout();

  let tab='upcoming';
  const apply=()=>{
    const q=(document.querySelector('#team-match-search').value||'').toLowerCase().trim();let visible=0;
    document.querySelectorAll('.team-match-card').forEach(c=>{const show=(tab==='all'||c.dataset.state===tab)&&(!q||c.dataset.search.includes(q));c.hidden=!show;if(show)visible++});
    document.querySelector('#team-match-count').textContent=`${visible} partite`;
  };
  document.querySelectorAll('.team-match-tabs button').forEach(b=>b.onclick=()=>{document.querySelectorAll('.team-match-tabs button').forEach(x=>x.classList.remove('active'));b.classList.add('active');tab=b.dataset.tab;apply()});
  document.querySelector('#team-match-search').addEventListener('input',apply);

  const openReport=m=>{
    let events=[];
    if(m.submission_events_json){try{events=JSON.parse(m.submission_events_json)||[]}catch{}}
    let submissionNotes=m.submission_notes||'';
    let proposedMvp=m.submission_mvp_player_id||null;
    try{
      const parsedNotes=JSON.parse(submissionNotes);
      if(parsedNotes&&typeof parsedNotes==='object'){
        submissionNotes=parsedNotes.text||'';
        proposedMvp=parsedNotes.mvp_player_id||proposedMvp;
      }
    }catch{}
    const teamPlayers=players;
    const render=()=>{
      const box=document.querySelector('#team-report-events');if(!box)return;
      box.innerHTML=events.map((e,i)=>`<div class="team-event-row" data-i="${i}">
        <select class="input event-type"><option value="goal" ${e.event_type==='goal'?'selected':''}>Gol</option><option value="assist" ${e.event_type==='assist'?'selected':''}>Assist</option><option value="yellow" ${e.event_type==='yellow'?'selected':''}>Ammonizione</option><option value="red" ${e.event_type==='red'?'selected':''}>Espulsione</option></select>
        <select class="input event-player"><option value="">Seleziona giocatore</option>${teamPlayers.map(p=>`<option value="${p.id}" ${Number(e.player_id)===Number(p.id)?'selected':''}>${esc(p.first_name)} ${esc(p.last_name)}</option>`).join('')}</select>
        <input class="input event-quantity" type="number" min="1" value="${e.quantity||1}">
        <button class="btn small danger remove-team-event" type="button">Rimuovi</button>
      </div>`).join('')||'<div class="team-area-empty compact">Nessun evento inserito.</div>';
      box.querySelectorAll('.team-event-row').forEach(row=>{
        const i=Number(row.dataset.i);
        row.querySelector('.event-type').onchange=e=>events[i].event_type=e.target.value;
        row.querySelector('.event-player').onchange=e=>events[i].player_id=e.target.value;
        row.querySelector('.event-quantity').oninput=e=>events[i].quantity=Math.max(1,Number(e.target.value||1));
        row.querySelector('.remove-team-event').onclick=()=>{events.splice(i,1);render()};
      });
    };

    document.querySelector('#editor').innerHTML=`<section class="team-report-editor">
      <div class="account-editor-head"><div><span class="eyebrow">Invio referto</span><h3>${esc(m.home_name)} – ${esc(m.away_name)}</h3><p>${fmtDate(m.match_date)} · ${esc(m.venue||'Campo da definire')}</p></div><button class="btn small" id="close-team-report">Chiudi</button></div>
      <div class="team-report-score">
        <div><label>${esc(m.home_name)}</label><input class="input" id="team-home-score" type="number" min="0" value="${m.submission_home_score??m.home_score??0}"></div>
        <b>–</b>
        <div><label>${esc(m.away_name)}</label><input class="input" id="team-away-score" type="number" min="0" value="${m.submission_away_score??m.away_score??0}"></div>
      </div>
      <div class="team-event-heading"><div><h4>Eventi della tua squadra</h4><p>Inserisci marcatori, assist e cartellini. L’Admin verificherà tutto prima della pubblicazione.</p></div><div><button class="btn small add-team-event" data-type="goal">+ Gol</button><button class="btn small add-team-event" data-type="assist">+ Assist</button><button class="btn small add-team-event" data-type="yellow">+ Giallo</button><button class="btn small add-team-event" data-type="red">+ Rosso</button></div></div>
      <div id="team-report-events"></div>
      <div class="field"><label>MVP proposto</label><select class="input" id="team-report-mvp"><option value="">Nessuna proposta</option>${teamPlayers.map(p=>`<option value="${p.id}" ${Number(proposedMvp)===Number(p.id)?'selected':''}>${esc(p.first_name)} ${esc(p.last_name)}</option>`).join('')}</select></div>
      <div class="field"><label>Note per l’Admin</label><textarea class="input" id="team-report-notes" rows="4">${esc(submissionNotes)}</textarea></div>
      <div class="team-report-flow">
        <div><b>1</b><span>La squadra compila</span></div>
        <div><b>2</b><span>L’Admin verifica</span></div>
        <div><b>3</b><span>La partita si aggiorna</span></div>
      </div>
      <div class="team-report-submit"><span>Dopo l’invio il referto resterà in attesa. Solo l’approvazione dell’Admin renderà ufficiali risultato, eventi e MVP.</span><button class="btn primary" id="send-team-report">Invia all’Admin</button></div>
    </section>`;
    render();
    document.querySelector('#editor').scrollIntoView({behavior:'smooth',block:'start'});
    document.querySelector('#close-team-report').onclick=()=>document.querySelector('#editor').innerHTML='';
    document.querySelectorAll('.add-team-event').forEach(b=>b.onclick=()=>{events.push({team_id:Number(state.user.team_id),player_id:'',event_type:b.dataset.type,quantity:1});render()});
    document.querySelector('#send-team-report').onclick=async()=>{
      const clean=events.filter(e=>e.player_id).map(e=>({...e,team_id:Number(state.user.team_id),player_id:Number(e.player_id),quantity:Number(e.quantity||1)}));
      await api('team/submissions',{method:'POST',body:JSON.stringify({
        match_id:m.id,home_score:Number(document.querySelector('#team-home-score').value||0),away_score:Number(document.querySelector('#team-away-score').value||0),
        events:clean,mvp_player_id:document.querySelector('#team-report-mvp').value||null,notes:document.querySelector('#team-report-notes').value||''
      })});
      alert('Referto inviato correttamente.');teamMatchesArea();
    };
  };

  document.querySelectorAll('.submit-team-report').forEach(b=>b.onclick=()=>{
    const match=matches.find(m=>Number(m.id)===Number(b.dataset.id));
    if(!match)return;
    const isFuture=new Date(match.match_date).getTime()>Date.now();
    if(isFuture&&!confirm('Questa partita risulta ancora in programma. Vuoi comunque compilare il referto adesso?'))return;
    openReport(match);
  });
  apply();
}

async function managePlayers(){
  if(state.user.role==='team_manager')return teamRoster();
  await loadTeams();
  const endpoint=['super_admin','organizer'].includes(state.user.role)?'admin/players':'team/players';
  const d=await api(endpoint);
  const isAdmin=['super_admin','organizer'].includes(state.user.role);
  const players=[...(d.players||[])].sort((a,b)=>(a.team_name||'').localeCompare(b.team_name||'')||(a.last_name||'').localeCompare(b.last_name||'')||(a.first_name||'').localeCompare(b.first_name||''));
  const teams=d.teams||state.teams||[];
  const roles=[...new Set(players.map(p=>p.role).filter(Boolean))].sort((a,b)=>a.localeCompare(b));
  const activeCount=players.filter(p=>Number(p.is_active)!==0).length;

  if(!document.querySelector('link[data-prime-players]')){
    const link=document.createElement('link');
    link.rel='stylesheet';
    link.href='/assets/players-admin.css';
    link.dataset.primePlayers='1';
    document.head.appendChild(link);
  }

  const rows=players.map(p=>`<tr class="player-row"
    data-search="${esc(`${p.first_name||''} ${p.last_name||''} ${p.team_name||''} ${p.role||''} ${p.shirt_number||''}`.toLowerCase())}"
    data-team="${p.team_id||''}" data-role="${esc(p.role||'')}"
    data-status="${Number(p.is_active)!==0?'active':'inactive'}"
    data-name="${esc(`${p.last_name||''} ${p.first_name||''}`.toLowerCase())}"
    data-number="${Number(p.shirt_number||999)}">
    <td><div class="player-admin-identity">${p.photo_url?`<img src="${esc(p.photo_url)}" alt="${esc(p.first_name+' '+p.last_name)}">`:`<div class="player-admin-avatar">${esc(initials(`${p.first_name||''} ${p.last_name||''}`))}</div>`}<div><strong>${esc(p.first_name)} ${esc(p.last_name)}</strong><small>${esc(p.slug||'')}</small></div></div></td>
    <td>${esc(p.team_name||'Senza squadra')}</td>
    <td><span class="player-number">${p.shirt_number??'—'}</span></td>
    <td><span class="player-role">${esc(p.role||'Non definito')}</span></td>
    <td><span class="player-status ${Number(p.is_active)!==0?'active':'inactive'}">${Number(p.is_active)!==0?'Attivo':'Non attivo'}</span></td>
    <td><div class="player-actions"><button class="btn small edit-player" data-id="${p.id}">Modifica</button>${isAdmin?`<button class="btn small danger delete-player" data-id="${p.id}">Elimina</button>`:''}</div></td>
  </tr>`).join('');

  set(dashLayout(`<div class="admin-page-head players-admin-head"><div><span class="eyebrow">Gestione completa</span><h2>${isAdmin?'Giocatori':'Rosa'}</h2><p>Inserisci, trasferisci, modifica o elimina i giocatori.</p></div><button class="btn primary" id="new-player">Nuovo giocatore</button></div>
    <div id="editor"></div>
    <section class="players-admin-summary">
      <div><span>Giocatori totali</span><b>${players.length}</b></div>
      <div><span>Attivi</span><b>${activeCount}</b></div>
      <div><span>Non attivi</span><b>${players.length-activeCount}</b></div>
      <div><span>Squadre</span><b>${teams.length}</b></div>
    </section>
    <section class="players-admin-filters">
      <div class="field search-field"><label>Cerca</label><input class="input" id="players-search" placeholder="Nome, squadra, ruolo o numero"></div>
      <div class="field"><label>Squadra</label><select class="input" id="players-team"><option value="">Tutte</option>${teams.map(t=>`<option value="${t.id}">${esc(t.name)}</option>`).join('')}</select></div>
      <div class="field"><label>Ruolo</label><select class="input" id="players-role"><option value="">Tutti</option>${roles.map(r=>`<option value="${esc(r)}">${esc(r)}</option>`).join('')}</select></div>
      <div class="field"><label>Stato</label><select class="input" id="players-status"><option value="">Tutti</option><option value="active">Attivi</option><option value="inactive">Non attivi</option></select></div>
      <div class="field"><label>Ordina</label><select class="input" id="players-sort"><option value="team">Squadra</option><option value="name">Nome</option><option value="number">Numero</option><option value="role">Ruolo</option></select></div>
      <button type="button" class="btn small" id="players-reset">Azzera</button>
    </section>
    <div class="players-results-bar"><span id="players-result-count">${players.length} giocatori</span><span>Gestione riservata</span></div>
    <section class="admin-table-card players-table-card"><div class="table-wrap"><table class="admin-table players-table"><thead><tr><th>Giocatore</th><th>Squadra</th><th>Numero</th><th>Ruolo</th><th>Stato</th><th>Azioni</th></tr></thead><tbody id="players-table-body">${rows}</tbody></table></div><div class="players-empty" id="players-empty" hidden>Nessun giocatore corrisponde ai filtri.</div></section>`,'players'),'');
  bindLogout();

  const findPlayer=id=>players.find(p=>Number(p.id)===Number(id));
  const openForm=(p={})=>showForm('editor',`<div class="admin-editor-card"><h3>${p.id?'Modifica giocatore':'Nuovo giocatore'}</h3><form class="form-grid"><div class="field"><label>Nome</label><input class="input" name="first_name" value="${esc(p.first_name||'')}" required></div><div class="field"><label>Cognome</label><input class="input" name="last_name" value="${esc(p.last_name||'')}" required></div><div class="field"><label>Squadra</label><select class="input" name="team_id">${teams.map(t=>`<option value="${t.id}" ${Number(p.team_id)===Number(t.id)?'selected':''}>${esc(t.name)}</option>`).join('')}</select></div><div class="field"><label>Numero</label><input class="input" type="number" name="shirt_number" value="${p.shirt_number??''}"></div><div class="field"><label>Ruolo</label><select class="input" name="role">${['Portiere','Difensore','Centrocampista','Attaccante'].map(r=>`<option value="${r}" ${p.role===r?'selected':''}>${r}</option>`).join('')}</select></div><div class="field"><label>Stato</label><select class="input" name="is_active"><option value="1" ${Number(p.is_active)!==0?'selected':''}>Attivo</option><option value="0" ${Number(p.is_active)===0?'selected':''}>Non attivo</option></select></div>${mediaPicker({name:'photo_file',current:p.photo_url||'',label:'Foto giocatore',shape:'portrait'})}<div class="field full"><button class="btn primary">${p.id?'Salva modifiche':'Crea giocatore'}</button></div></form></div>`,async(f,form)=>{
    const existing=form.querySelector('[name="existing_media_url"]')?.value||'';
    const remove=form.querySelector('[name="remove_media"]')?.value==='1';
    const file=form.querySelector('[name="photo_file"]')?.files?.[0];
    f.photo_url=remove?'':await uploadMediaFile(file,'players',existing,1200);
    if(remove&&existing)await api('admin/media/delete',{method:'POST',body:JSON.stringify({url:existing})}).catch(()=>{});
    delete f.photo_file;delete f.existing_media_url;delete f.remove_media;
    f.is_active=f.is_active==='0'?0:1;
    await api(p.id?`admin/players/${p.id}`:'admin/players',{method:p.id?'PUT':'POST',body:JSON.stringify(f)});
    managePlayers();
  });

  const allRows=[...document.querySelectorAll('.player-row')];
  const apply=()=>{
    const search=document.querySelector('#players-search').value.toLowerCase().trim();
    const team=document.querySelector('#players-team').value;
    const role=document.querySelector('#players-role').value;
    const status=document.querySelector('#players-status').value;
    const sort=document.querySelector('#players-sort').value;
    const visible=allRows.filter(r=>{
      const show=(!search||r.dataset.search.includes(search))&&(!team||r.dataset.team===team)&&(!role||r.dataset.role===role)&&(!status||r.dataset.status===status);
      r.hidden=!show; return show;
    });
    visible.sort((a,b)=>sort==='name'?a.dataset.name.localeCompare(b.dataset.name):sort==='number'?Number(a.dataset.number)-Number(b.dataset.number):sort==='role'?a.dataset.role.localeCompare(b.dataset.role):((findPlayer(a.querySelector('.edit-player').dataset.id)?.team_name||'').localeCompare(findPlayer(b.querySelector('.edit-player').dataset.id)?.team_name||'')||a.dataset.name.localeCompare(b.dataset.name)));
    const tbody=document.querySelector('#players-table-body'); visible.forEach(r=>tbody.appendChild(r)); allRows.filter(r=>r.hidden).forEach(r=>tbody.appendChild(r));
    document.querySelector('#players-result-count').textContent=`${visible.length} ${visible.length===1?'giocatore':'giocatori'}`;
    document.querySelector('#players-empty').hidden=visible.length>0;
    document.querySelector('.players-table').hidden=visible.length===0;
  };

  ['players-search','players-team','players-role','players-status','players-sort'].forEach(id=>document.querySelector('#'+id).addEventListener(id==='players-search'?'input':'change',apply));
  document.querySelector('#players-reset').onclick=()=>{['players-search','players-team','players-role','players-status'].forEach(id=>document.querySelector('#'+id).value='');document.querySelector('#players-sort').value='team';apply()};
  document.querySelector('#new-player').onclick=()=>openForm();
  document.querySelectorAll('.edit-player').forEach(btn=>btn.onclick=()=>openForm(findPlayer(btn.dataset.id)));
  document.querySelectorAll('.delete-player').forEach(btn=>btn.onclick=async()=>{if(confirm('Eliminare definitivamente questo giocatore?')){await api(`admin/players/${btn.dataset.id}`,{method:'DELETE'});managePlayers()}});
  apply();
}
async function manageCalendar(){
  await loadTeams();
  const isAdmin=['super_admin','organizer'].includes(state.user.role);
  const endpoint=isAdmin?'admin/matches':'team/matches';
  const d=await api(endpoint);
  const matches=[...(d.matches||[])].sort((a,b)=>new Date(a.match_date)-new Date(b.match_date));
  const statusLabels={scheduled:'In programma',postponed:'Rinviata',suspended:'Sospesa',recovery:'Da recuperare',cancelled:'Annullata',completed:'Conclusa'};
  const phaseLabels={regular:'Regular season',playoff:'Playoff',semifinal:'Semifinale',final:'Finale'};
  const seasonOptions=(d.seasons||[]).map(s=>`<option value="${s.id}" ${s.is_current?'selected':''}>${esc(s.name)}</option>`).join('');
  const teamOpts=state.teams.map(t=>`<option value="${t.id}">${esc(t.name)}</option>`).join('');

  if(!document.querySelector('link[data-prime-calendar]')){
    const link=document.createElement('link');
    link.rel='stylesheet';
    link.href='/assets/calendar-admin.css';
    link.dataset.primeCalendar='1';
    document.head.appendChild(link);
  }

  const adminTools=isAdmin?`<section class="calendar-admin-tools"><div class="admin-panel-head"><div><span class="eyebrow">Gestione calendario</span><h2>Calendario campionato</h2><p>Visualizza le gare per mese, settimana o giorno e modifica qualsiasi partita direttamente dal calendario.</p></div></div><div class="calendar-actions"><button class="btn primary" id="generate-calendar">Genera calendario</button><button class="btn" id="new-match">Nuova partita</button><button class="btn" id="new-finals">Aggiungi playoff/finale</button><button class="btn danger" id="delete-calendar">Elimina calendario</button></div></section>`:'';

  set(dashLayout(`${adminTools}<div id="editor"></div>
    <section class="gcal-shell">
      <div class="gcal-toolbar">
        <div class="gcal-toolbar-left">
          <button class="gcal-icon-btn" id="cal-prev" type="button" aria-label="Periodo precedente">‹</button>
          <button class="gcal-icon-btn" id="cal-next" type="button" aria-label="Periodo successivo">›</button>
          <button class="gcal-today" id="cal-today" type="button">Oggi</button>
          <h2 id="cal-title"></h2>
        </div>
        <div class="gcal-view-switch" role="group" aria-label="Vista calendario">
          <button type="button" data-view="month" class="active">Mese</button>
          <button type="button" data-view="week">Settimana</button>
          <button type="button" data-view="day">Giorno</button>
        </div>
      </div>
      <div class="gcal-summary"><span><b>${matches.length}</b> partite totali</span><span class="gcal-legend"><i></i> Clicca una partita per modificarla</span></div>
      <div id="calendar-root"></div>
    </section>`,'calendar'),'');
  bindLogout();

  const openMatchForm=(m={})=>showForm('editor',`<div class="admin-editor-card"><div class="admin-editor-title"><h3>${m.id?'Modifica / riprogramma partita':'Nuova partita'}</h3>${m.id?`<button type="button" class="btn danger small" id="delete-single-match">Elimina partita</button>`:''}</div><form class="form-grid"><div class="field"><label>Stagione</label><select class="input" name="season_id">${seasonOptions}</select></div><div class="field"><label>Fase</label><select class="input" name="phase">${Object.entries(phaseLabels).map(([v,l])=>`<option value="${v}" ${m.phase===v?'selected':''}>${l}</option>`).join('')}</select></div><div class="field"><label>Giornata / turno</label><input class="input" name="round_name" value="${esc(m.round_name||'')}" required></div><div class="field"><label>Data e ora</label><input class="input" type="datetime-local" name="match_date" value="${m.match_date?String(m.match_date).replace(' ','T').slice(0,16):''}" required></div><div class="field"><label>Casa</label><select class="input" name="home_team_id">${state.teams.map(t=>`<option value="${t.id}" ${Number(m.home_team_id)===Number(t.id)?'selected':''}>${esc(t.name)}</option>`).join('')}</select></div><div class="field"><label>Trasferta</label><select class="input" name="away_team_id">${state.teams.map(t=>`<option value="${t.id}" ${Number(m.away_team_id)===Number(t.id)?'selected':''}>${esc(t.name)}</option>`).join('')}</select></div><div class="field"><label>Stato calendario</label><select class="input" name="schedule_status">${Object.entries(statusLabels).map(([v,l])=>`<option value="${v}" ${(m.schedule_status||'scheduled')===v?'selected':''}>${l}</option>`).join('')}</select></div><div class="field"><label>Stato risultato</label><select class="input" name="status"><option value="scheduled" ${m.status==='scheduled'?'selected':''}>Non conclusa</option><option value="pending" ${m.status==='pending'?'selected':''}>Referto in attesa</option><option value="published" ${m.status==='published'?'selected':''}>Conclusa e pubblicata</option><option value="postponed" ${m.status==='postponed'?'selected':''}>Rinviata</option></select></div><div class="field"><label>Gol casa</label><input class="input" type="number" min="0" name="home_score" value="${m.home_score??''}"></div><div class="field"><label>Gol ospite</label><input class="input" type="number" min="0" name="away_score" value="${m.away_score??''}"></div><div class="field full"><label>Campo</label><input class="input" name="venue" value="${esc(m.venue||'')}"></div><div class="field full"><label>Note programmazione</label><textarea class="input" name="schedule_notes">${esc(m.schedule_notes||'')}</textarea></div><div class="field full"><button class="btn primary">${m.id?'Salva modifiche':'Crea partita'}</button></div></form></div>`,async f=>{if(Number(f.home_team_id)===Number(f.away_team_id))throw new Error('Le squadre devono essere diverse');await api(m.id?`admin/matches/${m.id}`:'admin/matches',{method:m.id?'PUT':'POST',body:JSON.stringify(f)});manageCalendar()});

  const monthNames=['Gennaio','Febbraio','Marzo','Aprile','Maggio','Giugno','Luglio','Agosto','Settembre','Ottobre','Novembre','Dicembre'];
  const dayNames=['Lun','Mar','Mer','Gio','Ven','Sab','Dom'];
  let currentDate=matches.length?new Date(matches[0].match_date):new Date();
  let currentView='month';

  const isoDayKey=date=>`${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,'0')}-${String(date.getDate()).padStart(2,'0')}`;
  const matchTime=m=>new Intl.DateTimeFormat('it-IT',{hour:'2-digit',minute:'2-digit'}).format(new Date(m.match_date));
  const eventHtml=(m,compact=false)=>`<button type="button" class="gcal-event phase-${esc(m.phase||'regular')} status-${esc(m.schedule_status||'scheduled')}" data-id="${m.id}" title="${esc(m.home_name)} vs ${esc(m.away_name)}">
    <span class="gcal-event-time">${matchTime(m)}</span>
    <strong>${esc(m.home_name)} <b>${m.status==='published'?`${m.home_score}-${m.away_score}`:'–'}</b> ${esc(m.away_name)}</strong>
    ${compact?'':`<small>${esc(m.round_name||'Prime League')}</small>`}
  </button>`;

  const matchesForDate=date=>matches.filter(m=>isoDayKey(new Date(m.match_date))===isoDayKey(date));

  function renderMonth(){
    const root=document.querySelector('#calendar-root');
    const title=document.querySelector('#cal-title');
    title.textContent=`${monthNames[currentDate.getMonth()]} ${currentDate.getFullYear()}`;
    const first=new Date(currentDate.getFullYear(),currentDate.getMonth(),1);
    const offset=(first.getDay()+6)%7;
    const start=new Date(first); start.setDate(first.getDate()-offset);
    const todayKey=isoDayKey(new Date());
    let html=`<div class="gcal-month"><div class="gcal-weekdays">${dayNames.map(x=>`<div>${x}</div>`).join('')}</div><div class="gcal-month-grid">`;
    for(let i=0;i<42;i++){
      const date=new Date(start); date.setDate(start.getDate()+i);
      const dayMatches=matchesForDate(date);
      const outside=date.getMonth()!==currentDate.getMonth();
      html+=`<div class="gcal-day-cell ${outside?'outside':''} ${isoDayKey(date)===todayKey?'today':''}" data-date="${isoDayKey(date)}">
        <div class="gcal-day-number"><span>${date.getDate()}</span>${dayMatches.length?`<b>${dayMatches.length}</b>`:''}</div>
        <div class="gcal-day-events">${dayMatches.slice(0,3).map(m=>eventHtml(m,true)).join('')}${dayMatches.length>3?`<button type="button" class="gcal-more" data-date="${isoDayKey(date)}">+${dayMatches.length-3} altre</button>`:''}</div>
      </div>`;
    }
    root.innerHTML=html+'</div></div>';
  }

  function weekStart(date){
    const d=new Date(date); const offset=(d.getDay()+6)%7; d.setDate(d.getDate()-offset); d.setHours(0,0,0,0); return d;
  }

  function renderWeek(){
    const root=document.querySelector('#calendar-root');
    const start=weekStart(currentDate);
    const endDate=new Date(start); endDate.setDate(start.getDate()+6);
    document.querySelector('#cal-title').textContent=`${start.getDate()} ${monthNames[start.getMonth()].slice(0,3)} – ${endDate.getDate()} ${monthNames[endDate.getMonth()].slice(0,3)} ${endDate.getFullYear()}`;
    const days=Array.from({length:7},(_,i)=>{const d=new Date(start);d.setDate(start.getDate()+i);return d});
    const hours=[18,19,20,21,22];
    root.innerHTML=`<div class="gcal-week-scroll"><div class="gcal-week">
      <div class="gcal-week-head"><div class="gcal-time-head"></div>${days.map(d=>`<button type="button" class="${isoDayKey(d)===isoDayKey(new Date())?'today':''}" data-open-day="${isoDayKey(d)}"><small>${dayNames[(d.getDay()+6)%7]}</small><b>${d.getDate()}</b></button>`).join('')}</div>
      <div class="gcal-week-body">
        <div class="gcal-time-column">${hours.map(h=>`<div>${String(h).padStart(2,'0')}:00</div>`).join('')}</div>
        ${days.map(day=>`<div class="gcal-week-day">${hours.map(h=>`<div class="gcal-hour-slot">${matchesForDate(day).filter(m=>new Date(m.match_date).getHours()===h).map(m=>eventHtml(m)).join('')}</div>`).join('')}</div>`).join('')}
      </div>
    </div></div>`;
  }

  function renderDay(){
    const root=document.querySelector('#calendar-root');
    const date=currentDate;
    document.querySelector('#cal-title').textContent=new Intl.DateTimeFormat('it-IT',{weekday:'long',day:'numeric',month:'long',year:'numeric'}).format(date);
    const dayMatches=matchesForDate(date);
    root.innerHTML=`<div class="gcal-day-view">
      <div class="gcal-day-agenda">${dayMatches.length?dayMatches.map(m=>`<article class="gcal-agenda-item"><div class="gcal-agenda-time">${matchTime(m)}</div><div class="gcal-agenda-card"><span>${esc(phaseLabels[m.phase]||'Regular season')} · ${esc(m.round_name||'')}</span><h3>${esc(m.home_name)} ${m.status==='published'?`<b>${m.home_score}-${m.away_score}</b>`:'vs'} ${esc(m.away_name)}</h3><p>${esc(m.venue||'Campo da definire')} · ${esc(statusLabels[m.schedule_status]||'In programma')}</p>${isAdmin?`<button type="button" class="btn small edit-match" data-id="${m.id}">Modifica / riprogramma</button>`:''}</div></article>`).join(''):`<div class="gcal-empty-day"><strong>Nessuna partita</strong><span>Non ci sono gare programmate in questa giornata.</span>${isAdmin?'<button class="btn primary" id="day-new-match">Aggiungi partita</button>':''}</div>`}</div>
    </div>`;
  }

  function bindCalendarEvents(){
    document.querySelectorAll('.gcal-event,.edit-match').forEach(el=>el.addEventListener('click',()=>{const m=matches.find(x=>Number(x.id)===Number(el.dataset.id));if(m&&isAdmin)openMatchForm(m)}));
    document.querySelectorAll('.gcal-more,[data-open-day]').forEach(el=>el.addEventListener('click',()=>{const value=el.dataset.date||el.dataset.openDay;currentDate=new Date(`${value}T12:00:00`);currentView='day';syncViewButtons();renderCalendar()}));
    document.querySelector('#day-new-match')?.addEventListener('click',()=>openMatchForm({match_date:`${isoDayKey(currentDate)}T19:00`}));
  }

  function syncViewButtons(){
    document.querySelectorAll('.gcal-view-switch button').forEach(btn=>btn.classList.toggle('active',btn.dataset.view===currentView));
  }

  function renderCalendar(){
    if(currentView==='month')renderMonth();
    else if(currentView==='week')renderWeek();
    else renderDay();
    bindCalendarEvents();
  }

  document.querySelectorAll('.gcal-view-switch button').forEach(btn=>btn.addEventListener('click',()=>{currentView=btn.dataset.view;syncViewButtons();renderCalendar()}));
  document.querySelector('#cal-today').addEventListener('click',()=>{currentDate=new Date();renderCalendar()});
  document.querySelector('#cal-prev').addEventListener('click',()=>{if(currentView==='month')currentDate.setMonth(currentDate.getMonth()-1);else if(currentView==='week')currentDate.setDate(currentDate.getDate()-7);else currentDate.setDate(currentDate.getDate()-1);renderCalendar()});
  document.querySelector('#cal-next').addEventListener('click',()=>{if(currentView==='month')currentDate.setMonth(currentDate.getMonth()+1);else if(currentView==='week')currentDate.setDate(currentDate.getDate()+7);else currentDate.setDate(currentDate.getDate()+1);renderCalendar()});

  if(isAdmin){
    document.querySelector('#new-match').onclick=()=>openMatchForm();
    document.querySelector('#generate-calendar').onclick=()=>showForm('editor',`<div class="admin-editor-card"><h3>Genera calendario automatico</h3><form class="form-grid"><div class="field"><label>Stagione</label><select class="input" name="season_id">${seasonOptions}</select></div><div class="field"><label>Data inizio</label><input class="input" type="date" name="start_date" required></div><div class="field"><label>Data finale indicativa</label><input class="input" type="date" name="end_date"></div><div class="field"><label>Massimo partite per sera</label><select class="input" name="max_per_day"><option>1</option><option>2</option><option selected>3</option></select></div><div class="field"><label>Pausa mercato (giorni)</label><input class="input" type="number" min="0" name="market_break_days" value="20"></div><div class="field full"><label>Squadre partecipanti</label><div class="calendar-team-checks">${state.teams.map(t=>`<label><input type="checkbox" name="team_ids" value="${t.id}" checked> ${esc(t.name)}</label>`).join('')}</div></div><div class="field full"><label>Giorni principali</label><div class="calendar-team-checks"><label><input type="checkbox" name="allowed_days" value="3" checked> Mercoledì</label><label><input type="checkbox" name="allowed_days" value="4" checked> Giovedì</label><label><input type="checkbox" name="allowed_days" value="5" checked> Venerdì</label></div></div><div class="field full"><label>Orari</label><input class="input" name="times_text" value="19:00,20:00,21:00"></div><div class="field full"><label>Campo predefinito</label><input class="input" name="venue"></div><div class="field full"><label class="admin-check"><input type="checkbox" name="replace_existing" value="1"> Sostituisci eventuale calendario già presente</label></div><div class="field full"><button class="btn primary" type="submit">Genera andata e ritorno</button></div></form></div>`,async(_,form)=>{const fd=new FormData(form);const teamIds=fd.getAll('team_ids');const allowedDays=fd.getAll('allowed_days');const times=String(fd.get('times_text')||'').split(',').map(x=>x.trim()).filter(Boolean);if(teamIds.length<2)throw new Error('Seleziona almeno due squadre');const r=await api('admin/calendar/generate',{method:'POST',body:JSON.stringify({season_id:fd.get('season_id'),start_date:fd.get('start_date'),end_date:fd.get('end_date'),max_per_day:fd.get('max_per_day'),market_break_days:fd.get('market_break_days'),venue:fd.get('venue'),replace_existing:fd.get('replace_existing')==='1',team_ids:teamIds,allowed_days:allowedDays,times})});alert(`Calendario creato: ${r.matches_created} partite`);manageCalendar()});
    document.querySelector('#new-finals').onclick=()=>showForm('editor',`<div class="admin-editor-card"><h3>Aggiungi fase finale</h3><form class="form-grid"><div class="field"><label>Stagione</label><select class="input" name="season_id">${seasonOptions}</select></div><div class="field"><label>Fase</label><select class="input" name="phase"><option value="playoff">Playoff</option><option value="semifinal">Semifinale</option><option value="final">Finale</option></select></div><div class="field"><label>Nome turno</label><input class="input" name="round_name" placeholder="Es. Playoff 1"></div><div class="field"><label>Data e ora</label><input class="input" type="datetime-local" name="match_date" required></div><div class="field"><label>Casa</label><select class="input" name="home_team_id">${teamOpts}</select></div><div class="field"><label>Trasferta</label><select class="input" name="away_team_id">${teamOpts}</select></div><div class="field full"><label>Campo</label><input class="input" name="venue"></div><div class="field full"><button class="btn primary">Aggiungi partita</button></div></form></div>`,async f=>{await api('admin/calendar/finals',{method:'POST',body:JSON.stringify(f)});manageCalendar()});
    document.querySelector('#delete-calendar').onclick=()=>showForm('editor',`<div class="admin-editor-card danger-zone"><h3>Elimina completamente il calendario</h3><p>Verranno eliminate tutte le partite, i risultati, gli eventi e i referti della stagione scelta.</p><form class="form-grid"><div class="field"><label>Stagione</label><select class="input" name="season_id">${seasonOptions}</select></div><div class="field"><label>Scrivi ELIMINA</label><input class="input" name="confirmation" required></div><div class="field full"><button class="btn danger">Elimina definitivamente</button></div></form></div>`,async f=>{await api('admin/calendar/delete',{method:'POST',body:JSON.stringify(f)});manageCalendar()});
  }

  syncViewButtons();
  renderCalendar();
}

async function refereeMatchesArea(){
  const d=await api('team/matches');
  const matches=d.matches||[];
  const now=Date.now();

  if(!document.querySelector('link[data-prime-team-area]')){
    const link=document.createElement('link');link.rel='stylesheet';link.href='/assets/team-area.css';link.dataset.primeTeamArea='1';document.head.appendChild(link);
  }

  const statusOf=m=>m.submission_status==='pending'?'pending':m.submission_status==='rejected'?'rejected':m.submission_status==='approved'?'approved':new Date(m.match_date).getTime()>now?'upcoming':'todo';
  const labels={upcoming:'In programma',todo:'Da refertare',pending:'In attesa',rejected:'Da correggere',approved:'Approvati'};

  const card=m=>{
    const st=statusOf(m);
    return `<article class="team-match-card referee-match-card" data-state="${st}">
      <div class="team-match-head"><div><span>${esc(m.round_name||'Prime League')}</span><strong>${fmtDate(m.match_date)}</strong></div><span class="team-match-state ${st}">${labels[st]}</span></div>
      <div class="team-match-score"><div><strong>${esc(m.home_name)}</strong></div><b>${m.status==='published'?`${m.home_score??0} – ${m.away_score??0}`:'VS'}</b><div><strong>${esc(m.away_name)}</strong></div></div>
      <div class="team-match-meta"><span>${esc(m.venue||'Campo da definire')}</span></div>
      ${m.submission_status==='rejected'?`<div class="team-rejection"><strong>Da correggere</strong><span>${esc(m.admin_note||'Controlla il referto.')}</span></div>`:''}
      <div class="team-match-actions">
        ${!['pending','approved'].includes(st)?`<button class="btn primary small referee-report" data-id="${m.id}">${st==='rejected'?'Correggi referto':'Compila referto'}</button>`:''}
        ${st==='pending'?'<span class="team-waiting">In attesa di approvazione</span>':''}
        <a class="btn small" href="#/partita/${m.id}">Scheda partita</a>
      </div>
    </article>`;
  };

  set(dashLayout(`<div class="admin-page-head"><div><span class="eyebrow">Area arbitro</span><h2>Partite e referti arbitrali</h2><p>Inserisci risultato, ammonizioni ed espulsioni. La compilazione resta facoltativa.</p></div></div>
    <div id="editor"></div>
    <section class="team-match-grid">${matches.map(card).join('')||'<div class="team-area-empty">Nessuna partita disponibile.</div>'}</section>`,'matches'),'');
  bindLogout();

  const open=async m=>{
    const detail=await api(`referee/matches/${m.id}/report-data`);
    const players=detail.players||[];
    let events=[];
    if(m.submission_events_json){try{events=JSON.parse(m.submission_events_json)||[]}catch{}}
    const render=()=>{
      const box=document.querySelector('#referee-events');if(!box)return;
      box.innerHTML=events.map((e,i)=>`<div class="team-event-row referee-event-row" data-i="${i}">
        <select class="input event-type"><option value="yellow" ${e.event_type==='yellow'?'selected':''}>Ammonizione</option><option value="red" ${e.event_type==='red'?'selected':''}>Espulsione</option><option value="goal" ${e.event_type==='goal'?'selected':''}>Gol</option><option value="assist" ${e.event_type==='assist'?'selected':''}>Assist</option></select>
        <select class="input event-team"><option value="${m.home_team_id}" ${Number(e.team_id)===Number(m.home_team_id)?'selected':''}>${esc(m.home_name)}</option><option value="${m.away_team_id}" ${Number(e.team_id)===Number(m.away_team_id)?'selected':''}>${esc(m.away_name)}</option></select>
        <select class="input event-player"><option value="">Seleziona giocatore</option>${players.filter(p=>Number(p.team_id)===Number(e.team_id)).map(p=>`<option value="${p.id}" ${Number(e.player_id)===Number(p.id)?'selected':''}>${esc(p.first_name)} ${esc(p.last_name)}</option>`).join('')}</select>
        <input class="input event-quantity" type="number" min="1" value="${e.quantity||1}">
        <button class="btn small danger remove-ref-event">Rimuovi</button>
      </div>`).join('')||'<div class="team-area-empty compact">Nessun evento inserito.</div>';
      box.querySelectorAll('.referee-event-row').forEach(row=>{
        const i=Number(row.dataset.i),team=row.querySelector('.event-team');
        row.querySelector('.event-type').onchange=e=>events[i].event_type=e.target.value;
        team.onchange=()=>{events[i].team_id=Number(team.value);events[i].player_id='';render()};
        row.querySelector('.event-player').onchange=e=>events[i].player_id=e.target.value;
        row.querySelector('.event-quantity').oninput=e=>events[i].quantity=Math.max(1,Number(e.target.value||1));
        row.querySelector('.remove-ref-event').onclick=()=>{events.splice(i,1);render()};
      });
    };

    document.querySelector('#editor').innerHTML=`<section class="team-report-editor">
      <div class="account-editor-head"><div><span class="eyebrow">Referto arbitro</span><h3>${esc(m.home_name)} – ${esc(m.away_name)}</h3><p>${fmtDate(m.match_date)}</p></div><button class="btn small close-referee-report">Chiudi</button></div>
      <div class="team-report-score"><div><label>${esc(m.home_name)}</label><input class="input" id="ref-home-score" type="number" min="0" value="${m.submission_home_score??m.home_score??0}"></div><b>–</b><div><label>${esc(m.away_name)}</label><input class="input" id="ref-away-score" type="number" min="0" value="${m.submission_away_score??m.away_score??0}"></div></div>
      <div class="review-info-banner"><strong>Compilazione facoltativa.</strong><span>Puoi inserire soltanto cartellini ed espulsioni oppure completare anche risultato, gol e assist.</span></div>
      <div class="team-event-heading"><div><h4>Eventi arbitrali</h4><p>Seleziona sempre la squadra e il giocatore corretto.</p></div><div><button class="btn small add-ref-event" data-type="yellow">+ Giallo</button><button class="btn small add-ref-event" data-type="red">+ Rosso</button><button class="btn small add-ref-event" data-type="goal">+ Gol</button><button class="btn small add-ref-event" data-type="assist">+ Assist</button></div></div>
      <div id="referee-events"></div>
      <div class="field"><label>Note arbitrali</label><textarea class="input" id="referee-notes" rows="4"></textarea></div>
      <div class="team-report-submit"><span>L’Admin controllerà il referto prima della pubblicazione.</span><button class="btn primary send-referee-report">Invia all’Admin</button></div>
    </section>`;
    render();
    document.querySelector('#editor').scrollIntoView({behavior:'smooth'});
    document.querySelector('.close-referee-report').onclick=()=>document.querySelector('#editor').innerHTML='';
    document.querySelectorAll('.add-ref-event').forEach(b=>b.onclick=()=>{events.push({team_id:Number(m.home_team_id),player_id:'',event_type:b.dataset.type,quantity:1});render()});
    document.querySelector('.send-referee-report').onclick=async()=>{
      const clean=events.filter(e=>e.player_id).map(e=>({...e,team_id:Number(e.team_id),player_id:Number(e.player_id),quantity:Number(e.quantity||1)}));
      await api('team/submissions',{method:'POST',body:JSON.stringify({match_id:m.id,home_score:Number(document.querySelector('#ref-home-score').value||0),away_score:Number(document.querySelector('#ref-away-score').value||0),events:clean,notes:document.querySelector('#referee-notes').value||''})});
      alert('Referto arbitrale inviato.');refereeMatchesArea();
    };
  };
  document.querySelectorAll('.referee-report').forEach(b=>b.onclick=()=>{
    const m=matches.find(x=>Number(x.id)===Number(b.dataset.id));
    if(new Date(m.match_date).getTime()>Date.now()&&!confirm('La partita risulta ancora in programma. Vuoi compilare il referto per effettuare un test?'))return;
    open(m);
  });
}
async function manageMatches(){
  if(state.user.role==='team_manager')return teamMatchesArea();
  if(state.user.role==='referee')return refereeMatchesArea();
  await loadTeams();
  const isAdmin=['super_admin','organizer'].includes(state.user.role);
  const endpoint=isAdmin?'admin/matches':'team/matches';
  const d=await api(endpoint);
  const seasons=isAdmin?(d.seasons||[]):[];
  const matches=[...(d.matches||[])].sort((a,b)=>new Date(a.match_date)-new Date(b.match_date));
  const statusLabels={scheduled:'In programma',pending:'Referto in attesa',published:'Conclusa',postponed:'Rinviata'};
  const scheduleLabels={scheduled:'In programma',postponed:'Rinviata',suspended:'Sospesa',recovery:'Da recuperare',cancelled:'Annullata',completed:'Conclusa'};
  const phaseLabels={regular:'Regular season',playoff:'Playoff',semifinal:'Semifinale',final:'Finale'};

  if(!document.querySelector('link[data-prime-matches]')){
    const link=document.createElement('link');
    link.rel='stylesheet';
    link.href='/assets/matches-admin.css';
    link.dataset.primeMatches='1';
    document.head.appendChild(link);
  }

  const seasonOptions=seasons.map(s=>`<option value="${s.id}">${esc(s.name)}</option>`).join('');
  const teamFilterOptions=state.teams.map(t=>`<option value="${t.id}">${esc(t.name)}</option>`).join('');
  const grouped=[...new Set(matches.map(m=>m.round_name||'Senza giornata'))];

  const card=m=>`<article class="admin-match-card" data-season="${m.season_id}" data-team="${m.home_team_id},${m.away_team_id}" data-status="${esc(m.status)}" data-search="${esc((m.home_name+' '+m.away_name+' '+(m.round_name||'')).toLowerCase())}">
    <div class="admin-match-card-top">
      <div><span class="admin-match-phase">${esc(phaseLabels[m.phase]||'Regular season')}</span><strong>${esc(m.round_name||'Prime League')}</strong></div>
      <span class="admin-match-status ${esc(m.status)}">${esc(statusLabels[m.status]||m.status)}</span>
    </div>
    <div class="admin-match-date">${fmtDate(m.match_date)}${m.venue?` · ${esc(m.venue)}`:''}</div>
    <div class="admin-scoreboard">
      <div class="admin-club home">${logo(m.home_logo,m.home_name)}<strong>${esc(m.home_name)}</strong></div>
      <div class="admin-result">${m.status==='published'?`<b>${m.home_score??0}</b><span>–</span><b>${m.away_score??0}</b>`:'<span>VS</span>'}</div>
      <div class="admin-club away">${logo(m.away_logo,m.away_name)}<strong>${esc(m.away_name)}</strong></div>
    </div>
    <div class="admin-match-card-actions">
      ${isAdmin?`<button class="btn primary small report-match" data-id="${m.id}">${m.status==='published'?'Modifica referto':'Inserisci referto'}</button><button class="btn small edit-match-basic" data-id="${m.id}">Dati partita</button><button class="btn small danger delete-match" data-id="${m.id}">Elimina</button>`:'<span>Solo consultazione</span>'}
    </div>
  </article>`;

  const sections=grouped.map(round=>{
    const roundMatches=matches.filter(m=>(m.round_name||'Senza giornata')===round);
    return `<section class="admin-round-group" data-round="${esc(round)}"><div class="admin-round-head"><div><span>Turno</span><h3>${esc(round)}</h3></div><b>${roundMatches.length} gare</b></div><div class="admin-match-grid">${roundMatches.map(card).join('')}</div></section>`;
  }).join('');

  set(dashLayout(`<div class="admin-page-head matches-admin-head"><div><span class="eyebrow">Gestione sportiva</span><h2>Partite e referti</h2><p>Gestisci ogni gara, inserisci il risultato ufficiale e registra marcatori, assist, cartellini e MVP.</p></div>${isAdmin?'<button class="btn primary" id="new-match">Nuova partita</button>':''}</div>
    <div id="editor"></div>
    <section class="matches-admin-summary">
      <div><span>Totale</span><b>${matches.length}</b></div>
      <div><span>In programma</span><b>${matches.filter(m=>m.status==='scheduled').length}</b></div>
      <div><span>Concluse</span><b>${matches.filter(m=>m.status==='published').length}</b></div>
      <div><span>Da gestire</span><b>${matches.filter(m=>['pending','postponed'].includes(m.status)).length}</b></div>
    </section>
    <section class="matches-admin-filters">
      <div class="field"><label>Cerca partita</label><input class="input" id="match-search" placeholder="Squadra o giornata"></div>
      <div class="field"><label>Stagione</label><select class="input" id="match-season"><option value="">Tutte</option>${seasonOptions}</select></div>
      <div class="field"><label>Squadra</label><select class="input" id="match-team"><option value="">Tutte</option>${teamFilterOptions}</select></div>
      <div class="field"><label>Stato</label><select class="input" id="match-status"><option value="">Tutti</option><option value="scheduled">In programma</option><option value="pending">Referto in attesa</option><option value="published">Conclusa</option><option value="postponed">Rinviata</option></select></div>
    </section>
    <div id="matches-admin-list">${sections||'<div class="admin-table-card empty">Nessuna partita disponibile.</div>'}</div>
    <div class="matches-admin-empty" id="matches-admin-empty" hidden>Nessuna partita corrisponde ai filtri.</div>`,'matches'),'');
  bindLogout();
  if(!isAdmin)return;

  const findMatch=id=>matches.find(x=>Number(x.id)===Number(id));

  const basicForm=(m={})=>`<div class="admin-editor-card"><h3>${m.id?'Modifica dati partita':'Nuova partita'}</h3><form class="form-grid data-form"><div class="field"><label>Stagione</label><select class="input" name="season_id">${seasons.map(s=>`<option value="${s.id}" ${Number(m.season_id)===Number(s.id)?'selected':''}>${esc(s.name)}</option>`).join('')}</select></div><div class="field"><label>Giornata / turno</label><input class="input" name="round_name" value="${esc(m.round_name||'')}" required></div><div class="field"><label>Squadra casa</label><select class="input" name="home_team_id">${state.teams.map(t=>`<option value="${t.id}" ${Number(m.home_team_id)===Number(t.id)?'selected':''}>${esc(t.name)}</option>`).join('')}</select></div><div class="field"><label>Squadra ospite</label><select class="input" name="away_team_id">${state.teams.map(t=>`<option value="${t.id}" ${Number(m.away_team_id)===Number(t.id)?'selected':''}>${esc(t.name)}</option>`).join('')}</select></div><div class="field"><label>Data e ora</label><input class="input" type="datetime-local" name="match_date" value="${esc(String(m.match_date||'').replace(' ','T').slice(0,16))}" required></div><div class="field"><label>Campo</label><input class="input" name="venue" value="${esc(m.venue||'')}"></div><div class="field"><label>Fase</label><select class="input" name="phase">${Object.entries(phaseLabels).map(([v,l])=>`<option value="${v}" ${m.phase===v?'selected':''}>${l}</option>`).join('')}</select></div><div class="field"><label>Stato calendario</label><select class="input" name="schedule_status">${Object.entries(scheduleLabels).map(([v,l])=>`<option value="${v}" ${(m.schedule_status||'scheduled')===v?'selected':''}>${l}</option>`).join('')}</select></div><input type="hidden" name="status" value="${esc(m.status||'scheduled')}"><input type="hidden" name="home_score" value="${m.home_score??''}"><input type="hidden" name="away_score" value="${m.away_score??''}"><input type="hidden" name="mvp_player_id" value="${m.mvp_player_id||''}"><div class="field full"><button class="btn primary">${m.id?'Salva modifiche':'Crea partita'}</button></div></form></div>`;

  const openBasic=(m={})=>showForm('editor',basicForm(m),async f=>{
    if(Number(f.home_team_id)===Number(f.away_team_id))throw new Error('Le squadre devono essere diverse');
    await api(m.id?`admin/matches/${m.id}`:'admin/matches',{method:m.id?'PUT':'POST',body:JSON.stringify(f)});
    manageMatches();
  });

  async function openReport(m){
    const [detail,playersData]=await Promise.all([api(`public/match/${m.id}`),api('admin/players')]);
    const current=detail.match;
    const players=(playersData.players||[]).filter(p=>[Number(current.home_team_id),Number(current.away_team_id)].includes(Number(p.team_id)));
    let events=[];
    (detail.events||[]).forEach(e=>{
      events.push({team_id:e.team_id,player_id:e.player_id||'',event_type:e.event_type,quantity:Number(e.quantity||1)});
      if(e.event_type==='goal'&&e.assist_player_id){
        events.push({team_id:e.team_id,player_id:e.assist_player_id,event_type:'assist',quantity:Number(e.quantity||1)});
      }
    });
    const selectedMvpTeam=players.find(p=>Number(p.id)===Number(current.mvp_player_id))?.team_id||current.home_team_id;

    const playerOptions=(teamId,selected='',allowEmpty=true)=>`${allowEmpty?'<option value="">Nessuno</option>':''}${players.filter(p=>Number(p.team_id)===Number(teamId)).map(p=>`<option value="${p.id}" ${Number(selected)===Number(p.id)?'selected':''}>${esc(p.first_name)} ${esc(p.last_name)}${p.shirt_number?` · #${p.shirt_number}`:''}</option>`).join('')}`;

    const renderEventRows=()=>{
      const box=document.querySelector('#report-events');
      if(!box)return;
      box.innerHTML=(events.length?`<div class="report-event-labels"><span>Evento</span><span>Squadra</span><span>Giocatore</span><span>Qtà</span><span></span></div>`:'')+events.map((e,index)=>`<div class="report-event-row" data-index="${index}">
        <select class="input event-type" aria-label="Tipo evento">
          <option value="goal" ${e.event_type==='goal'?'selected':''}>⚽ Gol</option>
          <option value="assist" ${e.event_type==='assist'?'selected':''}>🎯 Assist</option>
          <option value="yellow" ${e.event_type==='yellow'?'selected':''}>🟨 Ammonizione</option>
          <option value="red" ${e.event_type==='red'?'selected':''}>🟥 Espulsione</option>
        </select>
        <select class="input event-team" aria-label="Squadra"><option value="${current.home_team_id}" ${Number(e.team_id)===Number(current.home_team_id)?'selected':''}>${esc(current.home_name)}</option><option value="${current.away_team_id}" ${Number(e.team_id)===Number(current.away_team_id)?'selected':''}>${esc(current.away_name)}</option></select>
        <select class="input event-player" aria-label="Giocatore"><option value="">Da selezionare</option>${players.filter(p=>Number(p.team_id)===Number(e.team_id)).map(p=>`<option value="${p.id}" ${Number(e.player_id)===Number(p.id)?'selected':''}>${esc(p.first_name)} ${esc(p.last_name)}${p.shirt_number?` · #${p.shirt_number}`:''}</option>`).join('')}</select>
        <input class="input event-quantity" type="number" min="1" value="${e.quantity||1}" title="Quantità">
        <button type="button" class="btn small danger remove-event">Rimuovi</button>
      </div>`).join('')||'<div class="report-events-empty">Nessun evento inserito. Puoi salvare anche soltanto il risultato.</div>';

      box.querySelectorAll('.report-event-row').forEach(row=>{
        const i=Number(row.dataset.index);
        const type=row.querySelector('.event-type');
        const team=row.querySelector('.event-team');
        const player=row.querySelector('.event-player');
        const quantity=row.querySelector('.event-quantity');
        type.onchange=()=>{events[i].event_type=type.value};
        team.onchange=()=>{events[i].team_id=Number(team.value);events[i].player_id='';renderEventRows()};
        player.onchange=()=>events[i].player_id=player.value;
        quantity.oninput=()=>events[i].quantity=Math.max(1,Number(quantity.value||1));
        row.querySelector('.remove-event').onclick=()=>{events.splice(i,1);renderEventRows()};
      });
    };

    document.querySelector('#editor').innerHTML=`<section class="match-report-editor">
      <div class="report-editor-head"><div><span class="eyebrow">Referto ufficiale</span><h2>${esc(current.home_name)} – ${esc(current.away_name)}</h2><p>${esc(current.round_name||'')} · ${fmtDate(current.match_date)}</p></div><button class="btn small" id="close-report">Chiudi</button></div>
      <div class="report-score-panel">
        <div class="report-team">${logo(current.home_logo,current.home_name)}<strong>${esc(current.home_name)}</strong><input class="input report-score" id="report-home-score" type="number" min="0" value="${current.home_score??0}"></div>
        <div class="report-score-separator">–</div>
        <div class="report-team">${logo(current.away_logo,current.away_name)}<strong>${esc(current.away_name)}</strong><input class="input report-score" id="report-away-score" type="number" min="0" value="${current.away_score??0}"></div>
      </div>
      <div class="report-settings">
        <div class="field"><label>Stato partita</label><select class="input" id="report-status"><option value="published" ${current.status==='published'?'selected':''}>Conclusa e pubblicata</option><option value="pending" ${current.status==='pending'?'selected':''}>Referto in attesa</option><option value="scheduled" ${current.status==='scheduled'?'selected':''}>In programma</option><option value="postponed" ${current.status==='postponed'?'selected':''}>Rinviata</option></select></div>
      </div>
      <section class="report-mvp-box">
        <div class="report-mvp-heading"><span>⭐</span><div><h3>MVP della partita</h3><p>Seleziona la squadra e poi il miglior giocatore della gara.</p></div></div>
        <div class="report-mvp-controls">
          <div class="field"><label>Squadra MVP</label><select class="input" id="report-mvp-team"><option value="${current.home_team_id}" ${Number(selectedMvpTeam)===Number(current.home_team_id)?'selected':''}>${esc(current.home_name)}</option><option value="${current.away_team_id}" ${Number(selectedMvpTeam)===Number(current.away_team_id)?'selected':''}>${esc(current.away_name)}</option></select></div>
          <div class="field"><label>Giocatore MVP</label><select class="input" id="report-mvp"></select></div>
        </div>
      </section>
      <div class="report-events-head"><div><h3>Eventi della partita</h3><p>Gol, assist, ammonizioni ed espulsioni sono eventi separati e facoltativi.</p></div><div class="report-event-actions"><button class="btn small add-event" data-type="goal">+ Gol</button><button class="btn small add-event assist-button" data-type="assist">+ Assist</button><button class="btn small add-event" data-type="yellow">+ Giallo</button><button class="btn small add-event" data-type="red">+ Rosso</button></div></div>
      <div id="report-events" class="report-events"></div>
      <div class="report-save-bar"><span>Il risultato e gli eventi aggiorneranno classifica e statistiche quando la partita sarà pubblicata.</span><button class="btn primary" id="save-report">Salva referto</button></div>
    </section>`;
    document.querySelector('#editor').scrollIntoView({behavior:'smooth',block:'start'});
    renderEventRows();

    const mvpTeam=document.querySelector('#report-mvp-team');
    const mvpPlayer=document.querySelector('#report-mvp');
    const renderMvpPlayers=()=>{
      const teamId=Number(mvpTeam.value);
      const selected=Number(current.mvp_player_id||mvpPlayer.value||0);
      const available=players.filter(p=>Number(p.team_id)===teamId);
      mvpPlayer.innerHTML=`<option value="">Da assegnare</option>${available.map(p=>`<option value="${p.id}" ${Number(p.id)===selected?'selected':''}>${esc(p.first_name)} ${esc(p.last_name)}${p.shirt_number?` · #${p.shirt_number}`:''}</option>`).join('')}`;
    };
    renderMvpPlayers();
    mvpTeam.onchange=()=>{current.mvp_player_id=null;renderMvpPlayers()};

    document.querySelector('#close-report').onclick=()=>{document.querySelector('#editor').innerHTML=''};
    document.querySelectorAll('.add-event').forEach(btn=>btn.onclick=()=>{events.push({team_id:Number(current.home_team_id),player_id:'',event_type:btn.dataset.type,quantity:1});renderEventRows()});
    document.querySelector('#save-report').onclick=async()=>{
      const completedEvents=events.filter(e=>e.player_id&&Number(e.quantity||0)>0);
      const homeScore=Number(document.querySelector('#report-home-score').value||0);
      const awayScore=Number(document.querySelector('#report-away-score').value||0);
      const payload={
        season_id:current.season_id,
        round_name:current.round_name||'',
        home_team_id:current.home_team_id,
        away_team_id:current.away_team_id,
        match_date:current.match_date,
        venue:current.venue||'',
        phase:m.phase||'regular',
        schedule_status:document.querySelector('#report-status').value==='published'?'completed':(m.schedule_status||'scheduled'),
        schedule_notes:m.schedule_notes||'',
        status:document.querySelector('#report-status').value,
        home_score:homeScore,
        away_score:awayScore,
        highlights_url:current.highlights_url||'',
        mvp_player_id:document.querySelector('#report-mvp').value||null,
        events:(()=>{
          const stored=[];
          const teams=[Number(current.home_team_id),Number(current.away_team_id)];
          teams.forEach(teamId=>{
            const goalUnits=[];
            completedEvents.filter(e=>e.event_type==='goal'&&Number(e.team_id)===teamId).forEach(e=>{
              for(let n=0;n<Number(e.quantity||1);n++)goalUnits.push({team_id:teamId,player_id:Number(e.player_id),assist_player_id:null,event_type:'goal',quantity:1});
            });
            const assistUnits=[];
            completedEvents.filter(e=>e.event_type==='assist'&&Number(e.team_id)===teamId).forEach(e=>{
              for(let n=0;n<Number(e.quantity||1);n++)assistUnits.push(Number(e.player_id));
            });
            assistUnits.slice(0,goalUnits.length).forEach((playerId,index)=>goalUnits[index].assist_player_id=playerId);
            stored.push(...goalUnits);
            completedEvents.filter(e=>['yellow','red'].includes(e.event_type)&&Number(e.team_id)===teamId).forEach(e=>stored.push({team_id:teamId,player_id:Number(e.player_id),assist_player_id:null,event_type:e.event_type,quantity:Number(e.quantity||1)}));
          });
          return stored;
        })()
      };
      const assistsHome=completedEvents.filter(e=>e.event_type==='assist'&&Number(e.team_id)===Number(current.home_team_id)).reduce((s,e)=>s+Number(e.quantity||1),0);
      const assistsAway=completedEvents.filter(e=>e.event_type==='assist'&&Number(e.team_id)===Number(current.away_team_id)).reduce((s,e)=>s+Number(e.quantity||1),0);
      const goalsHome=payload.events.filter(e=>e.event_type==='goal'&&Number(e.team_id)===Number(current.home_team_id)).reduce((s,e)=>s+e.quantity,0);
      const goalsAway=payload.events.filter(e=>e.event_type==='goal'&&Number(e.team_id)===Number(current.away_team_id)).reduce((s,e)=>s+e.quantity,0);
      if(assistsHome>goalsHome||assistsAway>goalsAway){
        const proceed=confirm('Hai inserito più assist che gol per una delle squadre. Gli assist in eccesso non potranno essere associati e non verranno salvati. Vuoi continuare?');
        if(!proceed)return;
      }
      if(payload.status==='published'&&(goalsHome!==homeScore||goalsAway!==awayScore)){
        const proceed=confirm(`Attenzione: gli eventi registrano ${goalsHome}-${goalsAway}, mentre il risultato inserito è ${homeScore}-${awayScore}. Vuoi salvare comunque?`);
        if(!proceed)return;
      }
      const save=document.querySelector('#save-report');save.disabled=true;save.textContent='Salvataggio…';
      try{await api(`admin/matches/${m.id}`,{method:'PUT',body:JSON.stringify(payload)});alert('Referto salvato correttamente.');manageMatches()}catch(err){alert(err.message);save.disabled=false;save.textContent='Salva referto'}
    };
  }

  const applyFilters=()=>{
    const search=(document.querySelector('#match-search').value||'').toLowerCase().trim();
    const season=document.querySelector('#match-season').value;
    const team=document.querySelector('#match-team').value;
    const status=document.querySelector('#match-status').value;
    let visible=0;
    document.querySelectorAll('.admin-match-card').forEach(card=>{
      const okSearch=!search||card.dataset.search.includes(search);
      const okSeason=!season||card.dataset.season===season;
      const okTeam=!team||card.dataset.team.split(',').includes(team);
      const okStatus=!status||card.dataset.status===status;
      const show=okSearch&&okSeason&&okTeam&&okStatus;
      card.hidden=!show;if(show)visible++;
    });
    document.querySelectorAll('.admin-round-group').forEach(group=>group.hidden=!group.querySelector('.admin-match-card:not([hidden])'));
    document.querySelector('#matches-admin-empty').hidden=visible>0;
  };

  ['match-search','match-season','match-team','match-status'].forEach(id=>document.querySelector('#'+id).addEventListener(id==='match-search'?'input':'change',applyFilters));
  document.querySelector('#new-match').onclick=()=>openBasic();
  document.querySelectorAll('.edit-match-basic').forEach(btn=>btn.onclick=()=>openBasic(findMatch(btn.dataset.id)));
  document.querySelectorAll('.report-match').forEach(btn=>btn.onclick=()=>openReport(findMatch(btn.dataset.id)));
  if(state.pendingReportMatchId){
    const targetId=Number(state.pendingReportMatchId);
    state.pendingReportMatchId=null;
    const target=findMatch(targetId);
    if(target)setTimeout(()=>openReport(target),0);
  }
  document.querySelectorAll('.delete-match').forEach(btn=>btn.onclick=async()=>{if(confirm('Eliminare definitivamente questa partita, gli eventi e il referto collegato?')){await api(`admin/matches/${btn.dataset.id}`,{method:'DELETE'});manageMatches()}});
}
async function submissions(){
  const [d,playersData]=await Promise.all([api('admin/reports'),api('admin/players')]);
  const reports=[...(d.reports||[])];
  const reportPlayers=playersData.players||[];
  const seasons=d.seasons||[];
  const now=Date.now();

  if(!document.querySelector('link[data-prime-reports]')){
    const link=document.createElement('link');
    link.rel='stylesheet';
    link.href='/assets/reports-admin.css';
    link.dataset.primeReports='1';
    document.head.appendChild(link);
  }

  const reportState=r=>{
    if(Number(r.pending_submissions)>0)return 'pending';
    if(r.status==='published')return 'completed';
    if(new Date(r.match_date).getTime()<=now)return 'todo';
    return 'future';
  };
  const stateLabel={todo:'Da compilare',pending:'In attesa',completed:'Completato',future:'In programma'};
  const counts={
    todo:reports.filter(r=>reportState(r)==='todo').length,
    pending:reports.filter(r=>reportState(r)==='pending').length,
    completed:reports.filter(r=>reportState(r)==='completed').length,
    future:reports.filter(r=>reportState(r)==='future').length
  };

  const checks=r=>{
    const out=[];
    if(r.status==='published'){
      out.push({ok:true,text:'Risultato pubblicato'});
      if(Number(r.event_rows)>0)out.push({ok:true,text:`${r.event_rows} eventi registrati`});
      else out.push({ok:false,soft:true,text:'Nessun evento inserito'});
      if(r.mvp_player_id)out.push({ok:true,text:'MVP assegnato'});
      else out.push({ok:false,soft:true,text:'MVP non assegnato'});
    }else{
      out.push({ok:false,text:'Risultato da inserire'});
      if(Number(r.pending_submissions)>0)out.push({ok:false,soft:true,text:'Invio squadra da verificare'});
    }
    return out;
  };

  const card=r=>{
    const stateName=reportState(r);
    const score=r.status==='published'?`${r.home_score??0} – ${r.away_score??0}`:'VS';
    const checkHtml=checks(r).map(c=>`<span class="report-check ${c.ok?'ok':c.soft?'soft':'missing'}">${c.ok?'✓':c.soft?'•':'!'} ${esc(c.text)}</span>`).join('');
    return `<article class="report-admin-card"
      data-state="${stateName}"
      data-season="${r.season_id}"
      data-team="${r.home_team_id},${r.away_team_id}"
      data-round="${esc(r.round_name||'')}"
      data-search="${esc(`${r.home_name} ${r.away_name} ${r.round_name||''}`.toLowerCase())}">
      <div class="report-card-head">
        <div><span>${esc(r.round_name||'Prime League')}</span><strong>${fmtDate(r.match_date)}</strong></div>
        <span class="report-state ${stateName}">${stateLabel[stateName]}</span>
      </div>
      <div class="report-match-line">
        <div class="report-club">${logo(r.home_logo,r.home_name)}<strong>${esc(r.home_name)}</strong></div>
        <div class="report-score">${score}</div>
        <div class="report-club away">${logo(r.away_logo,r.away_name)}<strong>${esc(r.away_name)}</strong></div>
      </div>
      <div class="report-meta">
        <span>${esc(r.venue||'Campo da definire')}</span>
        <span>${Number(r.event_rows)} eventi</span>
        <span>${Number(r.assists_count)} assist</span>
      </div>
      <div class="report-checks">${checkHtml}</div>
      ${Number(r.pending_submissions)>0?`<div class="report-submission-note">
        <div><strong>Invio ricevuto da ${esc(r.pending_team_name||'squadra')}</strong><span>${fmtDate(r.pending_created_at)}</span></div>
        <b>Risultato proposto: ${r.pending_home_score??0} – ${r.pending_away_score??0}</b>
      </div>`:''}
      <div class="report-card-actions">
        <button class="btn primary small open-report" data-id="${r.id}">${r.status==='published'?'Modifica referto':'Compila referto'}</button>
        ${Number(r.pending_submissions)>0?`<button class="btn small primary review-submissions" data-match="${r.id}">Vedi referto completo</button>`:''}
        <a class="btn small" href="#/partita/${r.id}">Scheda pubblica</a>
      </div>
    </article>`;
  };

  set(dashLayout(`<div class="admin-page-head reports-admin-head">
      <div><span class="eyebrow">Controllo ufficiale</span><h2>Referti</h2><p>Controlla le gare da compilare, gli invii ricevuti e i referti già pubblicati.</p></div>
    </div>

    <section class="reports-summary">
      <button type="button" class="report-summary-card active" data-tab="todo"><span>Da compilare</span><b>${counts.todo}</b></button>
      <button type="button" class="report-summary-card" data-tab="pending"><span>In attesa</span><b>${counts.pending}</b></button>
      <button type="button" class="report-summary-card" data-tab="completed"><span>Completati</span><b>${counts.completed}</b></button>
      <button type="button" class="report-summary-card" data-tab="all"><span>Tutti</span><b>${reports.length}</b></button>
    </section>

    <section class="reports-filters">
      <div class="field search-field"><label>Cerca</label><input class="input" id="reports-search" placeholder="Squadra o giornata"></div>
      <div class="field"><label>Stagione</label><select class="input" id="reports-season"><option value="">Tutte</option>${seasons.map(s=>`<option value="${s.id}">${esc(s.name)}</option>`).join('')}</select></div>
      <div class="field"><label>Squadra</label><select class="input" id="reports-team"><option value="">Tutte</option>${state.teams.map(t=>`<option value="${t.id}">${esc(t.name)}</option>`).join('')}</select></div>
      <div class="field"><label>Giornata</label><select class="input" id="reports-round"><option value="">Tutte</option>${[...new Set(reports.map(r=>r.round_name).filter(Boolean))].map(r=>`<option value="${esc(r)}">${esc(r)}</option>`).join('')}</select></div>
      <button class="btn small" id="reports-reset" type="button">Azzera filtri</button>
    </section>

    <div class="reports-result-bar"><span id="reports-result-count"></span><span>MVP ed eventi sono facoltativi: puoi pubblicare anche solo il risultato.</span></div>
    <section class="reports-grid" id="reports-grid">${reports.map(card).join('')||'<div class="reports-empty">Nessuna partita disponibile.</div>'}</section>
    <div class="reports-empty" id="reports-empty" hidden>Nessun referto corrisponde ai filtri selezionati.</div>`,'submissions'),'');
  bindLogout();

  let activeTab='todo';
  const cards=[...document.querySelectorAll('.report-admin-card')];

  const apply=()=>{
    const search=(document.querySelector('#reports-search').value||'').toLowerCase().trim();
    const season=document.querySelector('#reports-season').value;
    const team=document.querySelector('#reports-team').value;
    const round=document.querySelector('#reports-round').value;
    let visible=0;
    cards.forEach(card=>{
      const tabOk=activeTab==='all'||card.dataset.state===activeTab;
      const show=tabOk&&(!search||card.dataset.search.includes(search))&&(!season||card.dataset.season===season)&&(!team||card.dataset.team.split(',').includes(team))&&(!round||card.dataset.round===round);
      card.hidden=!show;if(show)visible++;
    });
    document.querySelector('#reports-result-count').textContent=`${visible} ${visible===1?'referto':'referti'}`;
    document.querySelector('#reports-empty').hidden=visible>0;
  };

  document.querySelectorAll('.report-summary-card').forEach(btn=>btn.onclick=()=>{
    document.querySelectorAll('.report-summary-card').forEach(x=>x.classList.remove('active'));
    btn.classList.add('active');activeTab=btn.dataset.tab;apply();
  });
  ['reports-search','reports-season','reports-team','reports-round'].forEach(id=>document.querySelector('#'+id).addEventListener(id==='reports-search'?'input':'change',apply));
  document.querySelector('#reports-reset').onclick=()=>{
    document.querySelector('#reports-search').value='';
    document.querySelector('#reports-season').value='';
    document.querySelector('#reports-team').value='';
    document.querySelector('#reports-round').value='';
    apply();
  };

  document.querySelectorAll('.open-report').forEach(btn=>btn.onclick=()=>{
    state.pendingReportMatchId=Number(btn.dataset.id);
    manageMatches();
  });
  const eventLabel={goal:'Gol',assist:'Assist',yellow:'Ammonizione',red:'Espulsione'};
  const playerName=id=>{
    const p=reportPlayers.find(x=>Number(x.id)===Number(id));
    return p?`${p.first_name} ${p.last_name}${p.shirt_number?` · #${p.shirt_number}`:''}`:'Giocatore non disponibile';
  };
  const parseNotes=value=>{
    try{
      const parsed=JSON.parse(value||'{}');
      return typeof parsed==='object'&&parsed!==null?{text:parsed.text||'',mvp_player_id:parsed.mvp_player_id||null}:{text:String(value||''),mvp_player_id:null};
    }catch{return {text:value||'',mvp_player_id:null}}
  };

  document.querySelectorAll('.review-submissions').forEach(btn=>btn.onclick=async()=>{
    const detail=await api(`admin/reports/${btn.dataset.match}/submissions`);
    const items=detail.submissions||[];
    const match=detail.match||{};
    document.querySelector('#reports-review-modal')?.remove();
    const modal=document.createElement('div');
    modal.id='reports-review-modal';
    modal.className='report-review-overlay';

    const submissionCard=s=>{
      let events=[];try{events=JSON.parse(s.events_json||'[]')||[]}catch{}
      const notes=parseNotes(s.notes);
      const grouped={goal:[],assist:[],yellow:[],red:[]};
      events.forEach(e=>{if(grouped[e.event_type])grouped[e.event_type].push(e)});
      const eventSections=Object.entries(grouped).filter(([,arr])=>arr.length).map(([type,arr])=>`<div class="review-event-group">
        <strong>${eventLabel[type]}</strong>
        ${arr.map(e=>`<span>${esc(playerName(e.player_id))}${Number(e.quantity||1)>1?` × ${Number(e.quantity)}`:''}</span>`).join('')}
      </div>`).join('')||'<div class="review-no-events">Nessun evento inserito.</div>';
      return `<article class="review-submission-card ${esc(s.status)}">
        <div class="review-submission-head">
          <div><span>${s.source_role==='referee'?'Referto arbitro':'Referto squadra'}</span><h4>${esc(s.team_name||s.submitted_by||'Invio')}</h4><small>Inviato da ${esc(s.submitted_by||'utente')} · ${fmtDate(s.created_at)}</small></div>
          <span class="review-status ${esc(s.status)}">${s.status==='pending'?'In attesa':s.status==='approved'?'Approvato':s.status==='rejected'?'Rifiutato':'Superato'}</span>
        </div>
        <div class="review-proposed-score"><span>${esc(match.home_name||'Casa')}</span><b>${s.home_score} – ${s.away_score}</b><span>${esc(match.away_name||'Ospite')}</span></div>
        <div class="review-events-grid">${eventSections}</div>
        ${notes.mvp_player_id?`<div class="review-mvp"><strong>MVP proposto</strong><span>${esc(playerName(notes.mvp_player_id))}</span></div>`:''}
        ${notes.text?`<div class="review-notes"><strong>Note</strong><p>${esc(notes.text)}</p></div>`:''}
        ${s.admin_note?`<div class="review-admin-note"><strong>Nota Admin</strong><p>${esc(s.admin_note)}</p></div>`:''}
        ${s.status==='pending'?`<div class="review-actions">
          <button class="btn primary approve-review" data-id="${s.id}">Approva questo referto</button>
          <button class="btn danger reject-review" data-id="${s.id}">Rifiuta</button>
        </div>`:''}
      </article>`;
    };

    modal.innerHTML=`<div class="report-review-dialog">
      <div class="report-review-head"><div><span class="eyebrow">Revisione completa</span><h2>${esc(match.home_name||'')} – ${esc(match.away_name||'')}</h2><p>${esc(match.round_name||'')} · ${fmtDate(match.match_date)}</p></div><button class="btn small close-review">Chiudi</button></div>
      <div class="review-info-banner"><strong>Il referto non è obbligatorio.</strong><span>Puoi confrontare gli invii delle due squadre e dell’arbitro. Approva soltanto quelli che vuoi rendere ufficiali.</span></div>
      <div class="review-submissions-list">${items.map(submissionCard).join('')||'<div class="reports-empty">Nessun referto ricevuto.</div>'}</div>
    </div>`;
    document.body.appendChild(modal);
    modal.querySelector('.close-review').onclick=()=>modal.remove();
    modal.onclick=e=>{if(e.target===modal)modal.remove()};
    modal.querySelectorAll('.approve-review').forEach(b=>b.onclick=async()=>{
      if(confirm('Approvare questo referto? I dati verranno uniti agli altri referti già approvati e la partita sarà aggiornata automaticamente.')){
        await api(`admin/submissions/${b.dataset.id}/approve`,{method:'POST',body:'{}'});
        modal.remove();submissions();
      }
    });
    modal.querySelectorAll('.reject-review').forEach(b=>b.onclick=async()=>{
      const note=prompt('Scrivi il motivo del rifiuto:')||'';
      await api(`admin/submissions/${b.dataset.id}/reject`,{method:'POST',body:JSON.stringify({admin_note:note})});
      modal.remove();submissions();
    });
  });

  apply();
}
async function users(){
  await loadTeams();
  const d=await api('admin/users');
  const accounts=d.users||[];
  const roles={organizer:'Admin',super_admin:'Admin',team_manager:'Squadra',referee:'Arbitro'};
  const roleDescriptions={
    organizer:'Gestione completa della lega e dei contenuti.',
    team_manager:'Accesso limitato alla propria squadra, rosa, partite e sponsor.',
    referee:'Accesso alle partite assegnate e compilazione dei referti.'
  };

  if(!document.querySelector('link[data-prime-accounts]')){
    const link=document.createElement('link');
    link.rel='stylesheet';
    link.href='/assets/accounts-admin.css';
    link.dataset.primeAccounts='1';
    document.head.appendChild(link);
  }

  const counts={
    all:accounts.length,
    admin:accounts.filter(u=>['super_admin','organizer'].includes(u.role)).length,
    team:accounts.filter(u=>u.role==='team_manager').length,
    referee:accounts.filter(u=>u.role==='referee').length,
    disabled:accounts.filter(u=>!Number(u.is_active)).length
  };

  const roleGroup=u=>['super_admin','organizer'].includes(u.role)?'admin':u.role==='team_manager'?'team':'referee';
  const teamName=u=>state.teams.find(t=>Number(t.id)===Number(u.team_id))?.name||'—';
  const initials=name=>String(name||'?').split(/\s+/).slice(0,2).map(x=>x[0]||'').join('').toUpperCase();

  const rows=accounts.map(u=>`<tr class="account-row"
    data-role="${roleGroup(u)}"
    data-status="${Number(u.is_active)?'active':'disabled'}"
    data-search="${esc(`${u.display_name} ${u.email} ${u.username||''} ${teamName(u)}`.toLowerCase())}">
    <td>
      <div class="account-person">
        <span class="account-avatar">${esc(initials(u.display_name))}</span>
        <div><strong>${esc(u.display_name)}</strong><small>${esc(u.email)}</small>${u.username?`<em>@${esc(u.username)}</em>`:''}</div>
      </div>
    </td>
    <td><span class="account-role role-${roleGroup(u)}">${esc(roles[u.role]||u.role)}</span></td>
    <td>${u.role==='team_manager'?`<strong>${esc(teamName(u))}</strong>`:'<span class="muted">Non richiesta</span>'}</td>
    <td><span class="account-last-login">${u.last_login?fmtDate(u.last_login):'Mai effettuato'}</span></td>
    <td>${Number(u.is_active)?'<span class="account-status active">Attivo</span>':'<span class="account-status disabled">Disattivato</span>'}</td>
    <td>
      <div class="admin-row-actions account-actions">
        <button class="btn small edit-user" data-id="${u.id}">Modifica</button>
        <button class="btn small reset-user" data-id="${u.id}">Reimposta password</button>
        ${Number(u.id)!==Number(state.user.id)?`<button class="btn small ${Number(u.is_active)?'disable-user':'enable-user'}" data-id="${u.id}">${Number(u.is_active)?'Disattiva':'Riattiva'}</button><button class="btn small danger delete-user" data-id="${u.id}">Elimina</button>`:'<span class="account-you">Il tuo account</span>'}
      </div>
    </td>
  </tr>`).join('');

  set(dashLayout(`<div class="admin-page-head accounts-admin-head">
    <div><span class="eyebrow">Accessi e permessi</span><h2>Account</h2><p>Gestisci gli accessi di amministratori, squadre e arbitri.</p></div>
    <button class="btn primary" id="new-user">Nuovo account</button>
  </div>

  <section class="accounts-summary">
    <button class="account-summary active" data-filter-role="all"><span>Tutti</span><b>${counts.all}</b></button>
    <button class="account-summary" data-filter-role="admin"><span>Admin</span><b>${counts.admin}</b></button>
    <button class="account-summary" data-filter-role="team"><span>Squadre</span><b>${counts.team}</b></button>
    <button class="account-summary" data-filter-role="referee"><span>Arbitri</span><b>${counts.referee}</b></button>
    <button class="account-summary" data-filter-role="disabled"><span>Disattivati</span><b>${counts.disabled}</b></button>
  </section>

  <section class="accounts-permissions">
    <article><span>A</span><div><strong>Admin</strong><p>Controllo completo di campionato, account, squadre, calendario, contenuti e referti.</p></div></article>
    <article><span>S</span><div><strong>Squadra</strong><p>Gestione della propria rosa, dati squadra, sponsor e invio dei referti consentiti.</p></div></article>
    <article><span>R</span><div><strong>Arbitro</strong><p>Visualizzazione delle gare assegnate e compilazione di risultati, eventi e MVP.</p></div></article>
  </section>

  <div id="editor"></div>

  <section class="accounts-toolbar">
    <div class="field"><label>Cerca account</label><input class="input" id="account-search" placeholder="Nome, email, username o squadra"></div>
    <div class="field"><label>Stato</label><select class="input" id="account-status"><option value="">Tutti</option><option value="active">Attivi</option><option value="disabled">Disattivati</option></select></div>
    <span id="account-count"></span>
  </section>

  <div class="admin-table-card accounts-table-card">
    <table class="table accounts-table">
      <thead><tr><th>Account</th><th>Ruolo</th><th>Squadra</th><th>Ultimo accesso</th><th>Stato</th><th>Azioni</th></tr></thead>
      <tbody>${rows||'<tr><td colspan="6">Nessun account disponibile.</td></tr>'}</tbody>
    </table>
  </div>`,'users'),'');
  bindLogout();

  let activeRole='all';
  const applyFilters=()=>{
    const q=(document.querySelector('#account-search').value||'').toLowerCase().trim();
    const status=document.querySelector('#account-status').value;
    let visible=0;
    document.querySelectorAll('.account-row').forEach(row=>{
      const roleOk=activeRole==='all'||(activeRole==='disabled'?row.dataset.status==='disabled':row.dataset.role===activeRole);
      const statusOk=!status||row.dataset.status===status;
      const searchOk=!q||row.dataset.search.includes(q);
      const show=roleOk&&statusOk&&searchOk;
      row.hidden=!show;
      if(show)visible++;
    });
    document.querySelector('#account-count').textContent=`${visible} ${visible===1?'account':'account'}`;
  };

  document.querySelectorAll('.account-summary').forEach(btn=>btn.onclick=()=>{
    document.querySelectorAll('.account-summary').forEach(x=>x.classList.remove('active'));
    btn.classList.add('active');
    activeRole=btn.dataset.filterRole;
    applyFilters();
  });
  document.querySelector('#account-search').addEventListener('input',applyFilters);
  document.querySelector('#account-status').addEventListener('change',applyFilters);

  const openForm=(u={})=>{
    const normalizedRole=['super_admin','organizer'].includes(u.role)?'organizer':(u.role||'team_manager');
    showForm('editor',`<div class="admin-editor-card account-editor">
      <div class="account-editor-head"><div><span class="eyebrow">${u.id?'Modifica accesso':'Nuovo accesso'}</span><h3>${u.id?esc(u.display_name):'Crea un account'}</h3></div><button type="button" class="btn small" id="close-user-editor">Chiudi</button></div>
      <form class="form-grid" id="account-form">
        <div class="field"><label>Nome e cognome</label><input class="input" name="display_name" value="${esc(u.display_name||'')}" required></div>
        <div class="field"><label>Email</label><input class="input" type="email" name="email" value="${esc(u.email||'')}" required></div>
        <div class="field"><label>Username</label><input class="input" name="username" value="${esc(u.username||'')}" placeholder="Facoltativo"></div>
        ${u.id?'':`<div class="field"><label>Password iniziale</label><input class="input" type="password" minlength="10" name="password" required><small>Almeno 10 caratteri.</small></div>`}
        <div class="field">
          <label>Ruolo</label>
          <select class="input" name="role" id="account-role">
            <option value="organizer" ${normalizedRole==='organizer'?'selected':''}>Admin</option>
            <option value="team_manager" ${normalizedRole==='team_manager'?'selected':''}>Squadra</option>
            <option value="referee" ${normalizedRole==='referee'?'selected':''}>Arbitro</option>
          </select>
          <small id="role-description">${esc(roleDescriptions[normalizedRole]||'')}</small>
        </div>
        <div class="field" id="account-team-field">
          <label>Squadra collegata</label>
          <select class="input" name="team_id"><option value="">Seleziona squadra</option>${state.teams.map(t=>`<option value="${t.id}" ${Number(u.team_id)===Number(t.id)?'selected':''}>${esc(t.name)}</option>`).join('')}</select>
          <small>Obbligatoria soltanto per il ruolo Squadra.</small>
        </div>
        ${u.id?`<div class="field full"><label class="admin-check"><input type="checkbox" name="is_active" value="1" ${Number(u.is_active)?'checked':''}> Account attivo</label></div>`:''}
        <div class="field full"><button class="btn primary">${u.id?'Salva modifiche':'Crea account'}</button></div>
      </form>
    </div>`,async f=>{
      if(f.role==='team_manager'&&!f.team_id)throw new Error('Seleziona la squadra da collegare.');
      if(f.role!=='team_manager')f.team_id='';
      if(u.id){
        f.is_active=f.is_active==='1'?1:0;
        await api(`admin/users/${u.id}`,{method:'PUT',body:JSON.stringify(f)});
      }else{
        await api('admin/users',{method:'POST',body:JSON.stringify(f)});
      }
      users();
    });

    const roleSelect=document.querySelector('#account-role');
    const teamField=document.querySelector('#account-team-field');
    const roleDescription=document.querySelector('#role-description');
    const syncRole=()=>{
      teamField.hidden=roleSelect.value!=='team_manager';
      roleDescription.textContent=roleDescriptions[roleSelect.value]||'';
    };
    roleSelect.addEventListener('change',syncRole);
    syncRole();
    document.querySelector('#close-user-editor').onclick=()=>document.querySelector('#editor').innerHTML='';
    document.querySelector('#editor').scrollIntoView({behavior:'smooth',block:'start'});
  };

  document.querySelector('#new-user').onclick=()=>openForm();
  document.querySelectorAll('.edit-user').forEach(b=>b.onclick=()=>openForm(accounts.find(u=>Number(u.id)===Number(b.dataset.id))));
  document.querySelectorAll('.reset-user').forEach(b=>b.onclick=async()=>{
    const r=await api(`admin/users/${b.dataset.id}/reset-link`,{method:'POST',body:'{}'});
    try{await navigator.clipboard.writeText(r.resetUrl);alert('Link per reimpostare la password copiato. Scade tra 30 minuti.')}
    catch{prompt('Copia questo link. Scade tra 30 minuti:',r.resetUrl)}
  });
  document.querySelectorAll('.disable-user,.enable-user').forEach(b=>b.onclick=async()=>{
    const u=accounts.find(x=>Number(x.id)===Number(b.dataset.id));
    const activate=b.classList.contains('enable-user');
    if(confirm(`${activate?'Riattivare':'Disattivare'} l’account di ${u.display_name}?`)){
      await api(`admin/users/${u.id}/status`,{method:'POST',body:JSON.stringify({is_active:activate?1:0})});
      users();
    }
  });
  document.querySelectorAll('.delete-user').forEach(b=>b.onclick=async()=>{
    const u=accounts.find(x=>Number(x.id)===Number(b.dataset.id));
    if(confirm(`Eliminare definitivamente l’account di ${u.display_name}? Questa operazione non può essere annullata.`)){
      await api(`admin/users/${u.id}`,{method:'DELETE'});
      users();
    }
  });

  applyFilters();
}
async function sponsors(){await loadTeams();const isTeam=state.user.role==='team_manager';const endpoint=isTeam?'team/sponsors':'admin/sponsors';const d=await api(endpoint);const rows=d.sponsors.map(x=>`<tr><td><b>${esc(x.name)}</b></td><td>${esc(x.level)}</td><td>${esc(x.team_name||'Lega')}</td><td>${x.is_active?'Attivo':'Disattivo'}</td><td><div class="admin-row-actions"><button class="btn small edit-sponsor" data-id="${x.id}">Modifica</button><button class="btn small danger delete-sponsor" data-id="${x.id}">Elimina</button></div></td></tr>`).join('');set(dashLayout(`<div class="admin-page-head"><div><span class="eyebrow">Gestione completa</span><h2>Sponsor</h2></div><button class="btn primary" id="new-sponsor">Nuovo sponsor</button></div><div id="editor"></div><div class="admin-table-card"><table class="table"><thead><tr><th>Nome</th><th>Tipo</th><th>Squadra</th><th>Stato</th><th>Azioni</th></tr></thead><tbody>${rows}</tbody></table></div>`,'sponsors'),'');bindLogout();const form=(x={})=>`<div class="admin-editor-card"><h3>${x.id?'Modifica sponsor':'Nuovo sponsor'}</h3><form class="form-grid"><div class="field"><label>Nome</label><input class="input" name="name" value="${esc(x.name||'')}" required></div><div class="field"><label>Tipo</label><select class="input" name="level"><option value="league" ${x.level==='league'?'selected':''}>Lega</option><option value="team" ${x.level==='team'?'selected':''}>Squadra</option></select></div><div class="field"><label>Squadra</label><select class="input" name="team_id"><option value="">Nessuna</option>${state.teams.map(t=>`<option value="${t.id}" ${Number(x.team_id)===Number(t.id)?'selected':''}>${esc(t.name)}</option>`).join('')}</select></div><div class="field"><label>URL logo</label><input class="input" name="logo_url" value="${esc(x.logo_url||'')}"></div><div class="field"><label>Sito web</label><input class="input" name="website_url" value="${esc(x.website_url||'')}"></div><div class="field"><label class="admin-check"><input type="checkbox" name="is_featured" value="1" ${x.is_featured?'checked':''}> In evidenza</label></div>${x.id?`<div class="field"><label class="admin-check"><input type="checkbox" name="is_active" value="1" ${x.is_active?'checked':''}> Attivo</label></div>`:'<input type="hidden" name="is_active" value="1">'}<div class="field full"><button class="btn primary">Salva</button></div></form></div>`;const open=(x={})=>showForm('editor',form(x),async f=>{f.is_featured=f.is_featured==='1'?1:0;f.is_active=f.is_active==='1'?1:0;await api(x.id?`${isTeam?'team':'admin'}/sponsors/${x.id}`:endpoint,{method:x.id?'PUT':'POST',body:JSON.stringify(f)});sponsors()});document.querySelector('#new-sponsor').onclick=()=>open();document.querySelectorAll('.edit-sponsor').forEach(b=>b.onclick=()=>open(d.sponsors.find(x=>Number(x.id)===Number(b.dataset.id))));document.querySelectorAll('.delete-sponsor').forEach(b=>b.onclick=async()=>{if(confirm('Eliminare definitivamente questo sponsor?')){await api(`${isTeam?'team':'admin'}/sponsors/${b.dataset.id}`,{method:'DELETE'});sponsors()}})}

async function manageMedia(){
  const d=await api('admin/media');
  const objects=[...(d.objects||[])].sort((a,b)=>new Date(b.uploaded)-new Date(a.uploaded));
  const categoryLabels={players:'Giocatori',teams:'Squadre',sponsors:'Sponsor',news:'News',other:'Altro'};
  const formatSize=n=>n<1024?`${n} B`:n<1048576?`${(n/1024).toFixed(1)} KB`:`${(n/1048576).toFixed(1)} MB`;
  const cards=objects.map(o=>`<article class="media-library-card" data-category="${esc(o.category)}" data-search="${esc(o.key.toLowerCase())}">
    <div class="media-library-image"><img src="${esc(o.url)}" alt="${esc(o.key)}" loading="lazy"></div>
    <div class="media-library-info"><span>${esc(categoryLabels[o.category]||o.category)}</span><strong title="${esc(o.key)}">${esc(o.key.split('/').pop())}</strong><small>${formatSize(o.size)} · ${new Intl.DateTimeFormat('it-IT',{day:'2-digit',month:'short',year:'numeric'}).format(new Date(o.uploaded))}</small></div>
    <button class="btn small danger delete-media-object" data-key="${esc(o.key)}">Elimina</button>
  </article>`).join('');
  set(dashLayout(`<div class="admin-page-head"><div><span class="eyebrow">Archivio R2</span><h2>Media</h2><p>Gestisci foto giocatori, stemmi, sponsor e copertine news.</p></div></div>
    <section class="media-library-summary"><div><span>File totali</span><b>${objects.length}</b></div><div><span>Giocatori</span><b>${objects.filter(o=>o.category==='players').length}</b></div><div><span>Squadre</span><b>${objects.filter(o=>o.category==='teams').length}</b></div><div><span>Altri contenuti</span><b>${objects.filter(o=>!['players','teams'].includes(o.category)).length}</b></div></section>
    <section class="media-library-filters"><div class="field"><label>Cerca file</label><input class="input" id="media-search" placeholder="Nome del file"></div><div class="field"><label>Categoria</label><select class="input" id="media-category"><option value="">Tutte</option>${Object.entries(categoryLabels).map(([v,l])=>`<option value="${v}">${l}</option>`).join('')}</select></div></section>
    <div class="media-library-grid" id="media-grid">${cards||'<div class="media-library-empty">Nessun file caricato.</div>'}</div>
    <div class="media-library-empty" id="media-empty" hidden>Nessun file corrisponde ai filtri.</div>`,'media'),'');
  bindLogout();
  const apply=()=>{
    const search=(document.querySelector('#media-search').value||'').toLowerCase().trim();
    const category=document.querySelector('#media-category').value;
    let visible=0;
    document.querySelectorAll('.media-library-card').forEach(card=>{
      const show=(!search||card.dataset.search.includes(search))&&(!category||card.dataset.category===category);
      card.hidden=!show;if(show)visible++;
    });
    document.querySelector('#media-empty').hidden=visible>0||objects.length===0;
  };
  document.querySelector('#media-search').addEventListener('input',apply);
  document.querySelector('#media-category').addEventListener('change',apply);
  document.querySelectorAll('.delete-media-object').forEach(btn=>btn.onclick=async()=>{
    if(confirm('Eliminare definitivamente questo file da R2?')){await api('admin/media/delete',{method:'POST',body:JSON.stringify({key:btn.dataset.key})});manageMedia()}
  });
}

async function manageNews(){const d=await api('admin/news');const cards=d.news.map(n=>`<article class="card"><span class="pill">${n.is_published?'Pubblicata':'Bozza'}</span><h3>${esc(n.title)}</h3><p>${esc(n.excerpt||'')}</p><div class="admin-row-actions"><button class="btn small edit-news" data-id="${n.id}">Modifica</button><button class="btn small danger delete-news" data-id="${n.id}">Elimina</button></div></article>`).join('');set(dashLayout(`<div class="admin-page-head"><div><span class="eyebrow">Gestione completa</span><h2>News</h2></div><button class="btn primary" id="new-news">Nuova news</button></div><div id="editor"></div><div class="grid two">${cards}</div>`,'news'),'');bindLogout();const form=(n={})=>`<div class="admin-editor-card"><h3>${n.id?'Modifica news':'Nuova news'}</h3><form class="form-grid"><div class="field full"><label>Titolo</label><input class="input" name="title" value="${esc(n.title||'')}" required></div><div class="field full"><label>Riassunto</label><input class="input" name="excerpt" value="${esc(n.excerpt||'')}"></div>${mediaPicker({name:'cover_file',current:n.cover_url||'',label:'Immagine di copertina',shape:'cover'})}<div class="field full"><label>Testo</label><textarea class="input" name="body" required>${esc(n.body||'')}</textarea></div><div class="field"><label>Stato</label><select class="input" name="is_published"><option value="0" ${!n.is_published?'selected':''}>Bozza</option><option value="1" ${n.is_published?'selected':''}>Pubblicata</option></select></div><div class="field full"><button class="btn primary">Salva</button></div></form></div>`;const open=(n={})=>showForm('editor',form(n),async f=>{f.is_published=f.is_published==='1';await api(n.id?`admin/news/${n.id}`:'admin/news',{method:n.id?'PUT':'POST',body:JSON.stringify(f)});manageNews()});document.querySelector('#new-news').onclick=()=>open();document.querySelectorAll('.edit-news').forEach(b=>b.onclick=()=>open(d.news.find(x=>Number(x.id)===Number(b.dataset.id))));document.querySelectorAll('.delete-news').forEach(b=>b.onclick=async()=>{if(confirm('Eliminare questa news?')){await api(`admin/news/${b.dataset.id}`,{method:'DELETE'});manageNews()}})}
async function managePolls(){const d=await api('admin/polls');const cards=d.polls.map(p=>`<article class="card"><span class="pill">${esc(p.status)}</span><h3>${esc(p.title)}</h3><div class="muted">${p.options.length} opzioni</div><div class="admin-row-actions"><button class="btn small edit-poll" data-id="${p.id}">Modifica</button><button class="btn small danger delete-poll" data-id="${p.id}">Elimina</button></div></article>`).join('');set(dashLayout(`<div class="admin-page-head"><div><span class="eyebrow">Gestione completa</span><h2>Votazioni</h2></div><button class="btn primary" id="new-poll">Nuova votazione</button></div><div id="editor"></div><div class="grid two">${cards}</div>`,'polls'),'');bindLogout();const form=(p={})=>`<div class="admin-editor-card"><h3>${p.id?'Modifica votazione':'Nuova votazione'}</h3><form class="form-grid"><div class="field full"><label>Titolo</label><input class="input" name="title" value="${esc(p.title||'')}" required></div><div class="field full"><label>Descrizione</label><input class="input" name="description" value="${esc(p.description||'')}"></div><div class="field"><label>Tipo</label><select class="input" name="poll_type">${['mvp','goal','save','custom'].map(x=>`<option value="${x}" ${p.poll_type===x?'selected':''}>${x}</option>`).join('')}</select></div><div class="field"><label>Stato</label><select class="input" name="status">${['draft','open','closed'].map(x=>`<option value="${x}" ${p.status===x?'selected':''}>${x}</option>`).join('')}</select></div><div class="field"><label>Inizio</label><input class="input" type="datetime-local" name="starts_at" value="${esc((p.starts_at||'').slice(0,16))}" required></div><div class="field"><label>Fine</label><input class="input" type="datetime-local" name="ends_at" value="${esc((p.ends_at||'').slice(0,16))}" required></div><div class="field full"><label>Opzioni, una per riga</label><textarea class="input" name="options_text" required>${esc((p.options||[]).map(o=>o.label).join('\n'))}</textarea></div><div class="field full"><button class="btn primary">Salva</button></div></form></div>`;const open=(p={})=>showForm('editor',form(p),async f=>{f.options=f.options_text.split('\n').map(label=>({label:label.trim()})).filter(x=>x.label);delete f.options_text;await api(p.id?`admin/polls/${p.id}`:'admin/polls',{method:p.id?'PUT':'POST',body:JSON.stringify(f)});managePolls()});document.querySelector('#new-poll').onclick=()=>open();document.querySelectorAll('.edit-poll').forEach(b=>b.onclick=()=>open(d.polls.find(x=>Number(x.id)===Number(b.dataset.id))));document.querySelectorAll('.delete-poll').forEach(b=>b.onclick=async()=>{if(confirm('Eliminare questa votazione e tutti i voti?')){await api(`admin/polls/${b.dataset.id}`,{method:'DELETE'});managePolls()}})}

async function loadUser(){try{state.user=(await api('me')).user}catch{state.user=null}}
async function router(){const [route,...parts]=(location.hash.replace('#/','')||'home').split('/');try{if(route==='home')return home();if(route==='partite')return matches();if(route==='partita')return matchDetail(parts[0]);if(route==='classifica')return table();if(route==='squadre')return teams();if(route==='squadra')return team(parts[0]);if(route==='giocatori')return players();if(route==='giocatore')return player(parts[0]);if(route==='statistiche')return stats();if(route==='vota')return polls();if(route==='news')return news();if(route==='login')return login();if(route==='recupera-password')return forgotPassword();if(route==='reset-password')return resetPassword(parts[0]);if(route==='registrazione')return register();if(route==='setup')return setup();if(route==='dashboard')return dashboard(parts[0]||'overview');return home()}catch(e){set(`<div class="card">${message(e.message,'error')}<div class="actions"><a class="btn" href="#/home">Torna alla home</a></div></div>`,'')}}
window.addEventListener('hashchange',router);await loadUser();router();
