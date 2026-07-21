# Configurazione accessi Prime League

La piattaforma usa tre profili:

- **Admin**: controllo completo;
- **Squadra**: accesso limitato alla squadra associata;
- **Arbitro**: inserimento e invio dei referti.

## Cloudflare

Mantieni configurati come segreti `SESSION_SECRET` e `SETUP_TOKEN`, quindi esegui un nuovo deploy.

## Primo Admin

Apri `https://TUO-DOMINIO/#/setup`, inserisci il `SETUP_TOKEN` e crea l’account. L’utente viene salvato direttamente con ruolo `admin`, compatibile con la tabella esistente.

## Accesso

Apri `https://TUO-DOMINIO/#/login`. Dalla voce **Account**, l’Admin può creare gli accessi Squadra e Arbitro.
