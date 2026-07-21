# Accesso Prime League

Questa versione utilizza tre soli profili operativi:

- `admin`: controllo completo della piattaforma;
- `team_manager`: accesso limitato alla propria squadra;
- `referee`: inserimento e invio dei referti.

## Primo accesso Admin

1. Mantieni configurati su Cloudflare `SESSION_SECRET` e `SETUP_TOKEN`.
2. Pubblica il progetto.
3. Apri `https://TUO-DOMINIO/#/setup`.
4. Inserisci il valore di `SETUP_TOKEN`, nome, username, email e password.
5. Accedi da `https://TUO-DOMINIO/#/login`.

L’Admin viene salvato direttamente nella tabella `users` con ruolo `admin`, già accettato dal database esistente.

## Account Squadra e Arbitro

Dopo il login apri **Dashboard > Account**.

- Per una squadra scegli `Squadra` e collega il club corretto.
- Per un arbitro scegli `Arbitro`; non collegare alcuna squadra.

I ruoli specializzati sono conservati nella tabella compatibile `auth_roles`, creata automaticamente.
