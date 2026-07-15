# Prime League Platform

Prima versione completa e pubblicabile della piattaforma Prime League, progettata per Cloudflare Pages + D1 e GitHub.

## Funzioni incluse

### Area pubblica
- Home con prossime partite, risultati, classifica e marcatori
- Calendario partite
- Classifica calcolata automaticamente
- Pagine squadre e rose
- Schede giocatori essenziali
- Classifiche marcatori, assist e MVP
- News
- Votazioni tifosi
- Design mobile-first installabile come web app

### Area Admin
- Creazione squadre
- Creazione giocatori
- Creazione partite
- Approvazione o rifiuto referti inviati dalle squadre
- Creazione account squadra/admin/tifoso
- Sponsor generali della lega e sponsor squadra
- News
- Votazioni

### Area Squadra
- Gestione rosa
- Visualizzazione partite
- Invio referti all'Admin
- Gestione sponsor personali

## Pubblicazione su GitHub e Cloudflare

### 1. Carica il progetto su GitHub
Crea un repository nuovo e carica tutti i file contenuti nella cartella principale dello ZIP.

### 2. Crea il progetto Cloudflare Pages
- Accedi a Cloudflare
- Vai su **Workers & Pages**
- Seleziona **Create application > Pages > Connect to Git**
- Collega il repository GitHub
- Framework preset: **None**
- Build command: lascia vuoto
- Build output directory: `.`
- Avvia il deploy

### 3. Crea il database D1
- Cloudflare > **Storage & Databases > D1 SQL Database**
- Crea un database chiamato `prime-league-db`
- Copia il Database ID
- Sostituisci `INSERISCI_QUI_DATABASE_ID` dentro `wrangler.toml`

### 4. Collega D1 al progetto Pages
Nel progetto Cloudflare Pages:
- **Settings > Bindings > Add binding > D1 database**
- Variable name: `DB`
- Seleziona `prime-league-db`
- Salva e ridistribuisci il progetto

### 5. Importa il database
Apri la console SQL del database D1 e incolla tutto il contenuto di `schema.sql`.

Per avere dati dimostrativi iniziali, esegui successivamente anche `seed-demo.sql`.

### 6. Variabili ambiente
In **Settings > Variables and Secrets** crea:
- `SETUP_TOKEN`: una chiave lunga scelta da te
- `SESSION_SECRET`: un'altra chiave lunga

Impostale sia per Production sia per Preview.

### 7. Crea il primo Admin
Apri:

`https://nome-progetto.pages.dev/#/setup`

Inserisci il valore di `SETUP_TOKEN`, email, username e password. La pagina di configurazione smetterà di funzionare dopo la creazione del primo Admin.

## Accesso

Pagina login:

`/#/login`

L'Admin può creare gli account delle singole squadre e consegnare direttamente le credenziali.

## Google e Apple

La struttura attuale supporta account email/password. Google e Apple richiedono Client ID, Client Secret, URL callback e configurazione dei rispettivi portali sviluppatori. I pulsanti non sono stati simulati: verranno attivati quando saranno disponibili le credenziali reali.

## Foto e loghi

In questa prima versione i campi accettano URL pubblici. Il caricamento diretto su Cloudflare R2 verrà collegato nel modulo successivo, perché richiede la creazione del bucket e il relativo binding.

## Nota sui referti

Le squadre inviano risultato e note. L'Admin approva il referto e il risultato diventa ufficiale. Per la prima release, marcatori, assist e cartellini possono essere inseriti dall'Admin tramite API; l'editor visuale dettagliato degli eventi sarà il prossimo miglioramento operativo.

## File principali
- `index.html`: ingresso applicazione
- `assets/app.js`: interfaccia e navigazione
- `assets/styles.css`: design
- `functions/api/[[path]].js`: backend Cloudflare Pages Functions
- `schema.sql`: struttura database
- `seed-demo.sql`: dati dimostrativi
- `wrangler.toml`: configurazione Cloudflare
