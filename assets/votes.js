
const API_BASE='/api';

function escapeHtml(value=''){
  return String(value).replace(/[&<>"']/g,char=>({
    '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'
  })[char]);
}

function initials(value=''){
  return value.trim().split(/\s+/).slice(0,2).map(x=>x[0]||'').join('').toUpperCase()||'PL';
}

function formatDate(value){
  if(!value)return 'Data da definire';
  const date=new Date(value);
  if(Number.isNaN(date.getTime()))return value;
  return new Intl.DateTimeFormat('it-IT',{
    day:'2-digit',month:'short',year:'numeric',hour:'2-digit',minute:'2-digit'
  }).format(date);
}

function cookieValue(name){
  const row=document.cookie.split('; ').find(item=>item.startsWith(`${name}=`));
  return row?decodeURIComponent(row.split('=').slice(1).join('=')):'';
}

function createToken(){
  const bytes=new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return [...bytes].map(x=>x.toString(16).padStart(2,'0')).join('');
}

function getVoterToken(){
  const storageKey='prime_league_anonymous_voter';
  let token='';
  try{token=localStorage.getItem(storageKey)||''}catch{}
  if(!token)token=cookieValue('pl_voter');
  if(!token)token=createToken();
  try{localStorage.setItem(storageKey,token)}catch{}
  document.cookie=`pl_voter=${encodeURIComponent(token)}; Max-Age=31536000; Path=/; SameSite=Lax; Secure`;
  return token;
}

async function request(path,options={}){
  const response=await fetch(`${API_BASE}/${path}`,{
    ...options,
    headers:{'Content-Type':'application/json',...(options.headers||{})}
  });
  const data=await response.json().catch(()=>({}));
  if(!response.ok)throw new Error(data.error||'Si è verificato un errore');
  return data;
}

function loadStyle(){
  if(document.querySelector('link[data-votes-module]'))return;
  const link=document.createElement('link');
  link.rel='stylesheet';
  link.href='/assets/votes.css?v=20260726-2';
  link.dataset.votesModule='1';
  document.head.appendChild(link);
}

function pollType(type){
  return ({
    mvp:'MVP della partita',
    goal:'Gol della giornata',
    save:'Parata della giornata',
    custom:'Sondaggio Prime League'
  })[type]||'Votazione Prime League';
}

function pollCard(poll){
  const total=Number(poll.votes_count||0);
  const showResults=Boolean(poll.user_voted)||!poll.is_open;

  const options=(poll.options||[]).map(option=>{
    const votes=Number(option.votes||0);
    const percentage=total?Math.round(votes/total*100):0;
    const selected=Number(poll.selected_option_id)===Number(option.id);

    return `<button class="pl-vote-option ${selected?'is-selected':''}"
      data-vote-option="${option.id}" ${poll.user_voted||!poll.is_open?'disabled':''}>
      <span class="pl-vote-image">
        ${option.image_url
          ?`<img src="${escapeHtml(option.image_url)}" alt="${escapeHtml(option.label)}">`
          :`<b>${escapeHtml(initials(option.label))}</b>`}
      </span>
      <span class="pl-vote-copy">
        <strong>${escapeHtml(option.label)}</strong>
        ${showResults?`
          <span class="pl-vote-progress"><i style="width:${percentage}%"></i></span>
          <small>${percentage}% · ${votes} ${votes===1?'voto':'voti'}</small>
        `:'<small>Seleziona per votare</small>'}
      </span>
      ${selected?'<span class="pl-vote-selected">✓</span>':''}
    </button>`;
  }).join('');

  return `<article class="pl-poll-card" data-poll-id="${poll.id}">
    <header class="pl-poll-header">
      <div>
        <span>${escapeHtml(pollType(poll.poll_type))}</span>
        <h2>${escapeHtml(poll.title)}</h2>
      </div>
      <b class="pl-poll-status ${poll.is_open?'is-open':'is-closed'}">
        ${poll.is_open?'Vota ora':'Conclusa'}
      </b>
    </header>

    ${poll.description?`<p class="pl-poll-description">${escapeHtml(poll.description)}</p>`:''}
    <div class="pl-vote-options">${options}</div>

    <footer class="pl-poll-footer">
      <span><b>${total}</b> ${total===1?'voto espresso':'voti espressi'}</span>
      <span>${poll.is_open?`Chiusura: ${formatDate(poll.ends_at)}`:'Risultato finale'}</span>
    </footer>

    ${poll.user_voted?`
      <div class="pl-vote-success">
        <span>✓</span>
        <div><strong>Voto registrato</strong><small>Per questa votazione hai già espresso la tua preferenza.</small></div>
      </div>`:''}
  </article>`;
}

async function draw(){
  const bridge=window.PrimeLeagueVoteBridge;
  if(!bridge)throw new Error('Modulo Vota non collegato alla piattaforma');

  loadStyle();
  const token=getVoterToken();
  const data=await request('public/polls',{
    headers:{'X-Prime-Voter':token}
  });

  const polls=data.polls||[];
  const open=polls.filter(x=>x.is_open);
  const closed=polls.filter(x=>!x.is_open);

  bridge.render(`
    <main class="pl-votes-page">
      <section class="pl-votes-hero">
        <div class="pl-votes-hero-content">
          <span>La voce del pubblico</span>
          <h1>Vota Prime League</h1>
          <p>Scegli il protagonista della giornata. Non serve registrarsi e puoi votare una sola volta per ogni sondaggio.</p>
          <div class="pl-votes-hero-stats">
            <div><b>${open.length}</b><span>Votazioni aperte</span></div>
            <div><b>${polls.reduce((sum,p)=>sum+Number(p.votes_count||0),0)}</b><span>Voti raccolti</span></div>
          </div>
        </div>
        <div class="pl-votes-hero-mark">★</div>
      </section>

      <section class="pl-votes-section">
        <div class="pl-votes-title">
          <div><span>Partecipa adesso</span><h2>Votazioni aperte</h2></div>
          <small>Un voto per dispositivo e browser</small>
        </div>
        <div class="pl-polls-grid">
          ${open.length?open.map(pollCard).join(''):`
            <div class="pl-votes-empty">
              <b>Non ci sono votazioni aperte</b>
              <span>Torna presto per scegliere i protagonisti della Prime League.</span>
            </div>`}
        </div>
      </section>

      ${closed.length?`
        <section class="pl-votes-section pl-votes-archive">
          <div class="pl-votes-title"><div><span>Archivio</span><h2>Risultati precedenti</h2></div></div>
          <div class="pl-polls-grid">${closed.map(pollCard).join('')}</div>
        </section>`:''}
    </main>
  `);

  document.querySelectorAll('[data-vote-option]:not([disabled])').forEach(button=>{
    button.addEventListener('click',async()=>{
      const card=button.closest('.pl-poll-card');
      card?.classList.add('is-submitting');
      card?.querySelectorAll('[data-vote-option]').forEach(item=>item.disabled=true);
      try{
        await request('public/vote',{
          method:'POST',
          headers:{'X-Prime-Voter':token},
          body:JSON.stringify({
            option_id:Number(button.dataset.voteOption),
            voter_token:token
          })
        });
        await draw();
      }catch(error){
        card?.classList.remove('is-submitting');
        card?.querySelectorAll('[data-vote-option]').forEach(item=>item.disabled=false);
        alert(error.message);
      }
    });
  });
}

export async function renderVotes(){
  try{
    await draw();
  }catch(error){
    console.error('Prime League Votes:',error);
    window.PrimeLeagueVoteBridge?.showError(error.message||'Impossibile caricare le votazioni');
  }
}
