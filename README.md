# Codex via WhatsApp

Lokales Gateway, das WhatsApp-Nachrichten (nur von deiner Nummer) an `codex exec` weiterleitet.

## Architektur

1. WhatsApp linked device (QR) -> Baileys Socket
2. Nummernfilter (`ALLOWED_WHATSAPP_NUMBER`)
3. Queue + Runner
4. `codex exec -C <WORKDIR> ...` auf deinem Rechner
5. Antwort in WhatsApp zurueck

## Setup

1. `.env` anlegen:
   - `Copy-Item .env.example .env`
2. In `.env` setzen:
   - `ALLOWED_WHATSAPP_NUMBER` (deine Nummer, nur Ziffern, mit Landesvorwahl; `0049...` wird automatisch zu `49...` normalisiert)
   - `CODEX_WORKDIR` (Ordner, den du per WhatsApp steuern willst)
3. Dependencies installieren:
   - `npm install`
4. Config pruefen:
   - `npm run verify-config`
5. Starten:
   - `npm start`
6. QR-Code im Terminal mit WhatsApp -> Verknuepfte Geraete scannen.
7. Nur eine Instanz gleichzeitig starten (kein zweites `npm start` parallel).

## Nutzung

- Jede normale Nachricht (ohne `/`) wird als Prompt an Codex gesendet.
- Auch "Message yourself" ist moeglich (eigene Nummer), Echo-Loop durch Gateway-Antworten wird geblockt.
- Steuerbefehle:
  - `/help` (schnelle Uebersicht)
  - `/guide` (Schritt-fuer-Schritt fuer Non-Tech)
  - `/status`
  - `/session` (zeigt gespeicherte Codex-Session-ID)
  - `/pwd` (zeigt aktuellen Codex-Workdir)
  - `/cd <path>` (wechselt den Codex-Workdir)
  - `/cd-reset` (setzt Workdir auf `.env`-Default zurueck)
  - `/fav-list` (listet Favorite-Ordner)
  - `/fav-add <name> <path>` (speichert Favorite-Ordner)
  - `/fav-rm <name>` (entfernt Favorite-Ordner)
  - `/fav <name>` (wechselt zum Favorite-Ordner)
  - `/pc` (oeffnet Codex-Terminal auf deinem PC; resume wenn Session vorhanden)
  - `/stop` (stoppt aktiven Run und leert Queue)
  - `/new` (startet frischen Codex-Kontext)

## Wichtige Hinweise

- Dieses Setup nutzt WhatsApp Web via Baileys (OpenClaw-Ansatz), nicht die offizielle Meta Business API.
- Inbound wird hart auf genau eine Nummer gefiltert.
- Nur Direct Chats (`@s.whatsapp.net`) werden verarbeitet, keine Gruppen.
- Session und Runtime-Dateien landen standardmaessig in `%USERPROFILE%\\memory\\whatsapp-codex`.
- Codex-Kontext wird ueber `session id` gespeichert, damit du wie in einem fortlaufenden Chat arbeiten kannst.
- Das Gateway setzt eine globale Lock-Datei unter `%TEMP%\\codex-via-whatsapp-<nummer>.lock`, damit nicht aus Versehen mehrere Instanzen parallel laufen.
- Bei hartem Absturz ggf. einmal aufraeumen: `del %TEMP%\\codex-via-whatsapp-<nummer>.lock`

## Validation (maschinencheckbar)

- Syntaxcheck: `npm run check`
- Configcheck: `npm run verify-config`

## Open Source

- Lizenz: `MIT` (siehe `LICENSE`)
- Mitmachen: `CONTRIBUTING.md`
- Sicherheit: `SECURITY.md`
- Verhaltensregeln: `CODE_OF_CONDUCT.md`
- Release-Checkliste: `OPEN_SOURCE_CHECKLIST.md`
