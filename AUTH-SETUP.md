# Prime League — configurazione accesso Admin

## 1. Aggiorna il progetto
Carica tutti i file della ZIP su GitHub e attendi il deploy di Cloudflare Pages.

## 2. Imposta il token di prima configurazione
In Cloudflare apri **Workers & Pages → progetto Prime League → Settings → Variables and Secrets**.
Crea la variabile segreta:

- `SETUP_TOKEN`: una stringa lunga e casuale, diversa da password personali.

La variabile `ALLOW_RESET_LINK_RESPONSE` deve rimanere assente o `false` in produzione. Il recupero password viene gestito dal Super Admin attraverso la pagina Account.

## 3A. Database nuovo
Esegui lo schema completo:

```bash
npx wrangler d1 execute prime-league-db --remote --file=schema.sql
```

Sostituisci `prime-league-db` con il nome del database indicato in `wrangler.toml`, se diverso.

## 3B. Database già esistente
Esegui solamente la migrazione:

```bash
npx wrangler d1 execute prime-league-db --remote --file=migrations/0002_auth_roles.sql
```

La migrazione converte automaticamente:

- `admin` → `super_admin`
- `team` → `team_manager`

## 4. Crea il primo Super Admin
Apri:

```text
https://TUO-DOMINIO/#/setup
```

Inserisci il valore di `SETUP_TOKEN`, nome, username, email e una password sicura.
La configurazione può essere eseguita una sola volta.

## 5. Accedi
Apri:

```text
https://TUO-DOMINIO/#/login
```

Dopo il login sarai reindirizzato alla dashboard:

```text
https://TUO-DOMINIO/#/dashboard
```

## Ruoli disponibili

- **Super Admin**: accesso completo, inclusa gestione account e link di recupero.
- **Organizzatore**: squadre, giocatori, stagioni, partite, referti, sponsor, news e votazioni.
- **Team Manager**: rosa, gare della propria squadra, referti e sponsor del club.
- **Arbitro**: partite e invio referti.
- **Tifoso**: accesso alle votazioni pubbliche.

## Recupero password

Il Super Admin apre **Dashboard → Account**, preme **Link reset** e invia privatamente il collegamento all’utente. Il link scade dopo 30 minuti e può essere usato una sola volta. Al cambio password tutte le vecchie sessioni vengono revocate.
