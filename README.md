# abaninja-mcp

MCP-Server für [AbaNinja](https://www.abaninja.ch). Claude und andere KI-Assistenten greifen damit über die offizielle API auf ein AbaNinja-Konto zu. Inoffizielles Projekt.

> Noch nicht veröffentlicht. Bis dahin Installation aus diesem Repository.

## Installation

1. In AbaNinja ein API-Token erstellen ([Anleitung](https://docs.abaninja.ch/guide/authentication.html)). Ohne den Bereich `profile` zusätzlich `ABANINJA_ACCOUNT_UUID` setzen.
2. [Node.js](https://nodejs.org) ab Version 22 installieren, dann:
   ```bash
   git clone https://github.com/ingeniumdesign/abaninja-mcp.git
   cd abaninja-mcp
   npm install
   ```
3. In Claude Desktop unter Einstellungen → Entwickler → Konfiguration bearbeiten eintragen, dann Claude neu starten:
   ```json
   {
     "mcpServers": {
       "abaninja": {
         "command": "node",
         "args": ["C:/Pfad/zu/abaninja-mcp/dist/index.js"],
         "env": { "ABANINJA_API_TOKEN": "dein-token" }
       }
     }
   }
   ```

Claude Code:

```bash
claude mcp add abaninja --scope user -e ABANINJA_API_TOKEN=dein-token -- node /Pfad/zu/abaninja-mcp/dist/index.js
```

## Modi

`ABANINJA_MODE` legt fest, was erlaubt ist:

| Modus | Erlaubt |
| --- | --- |
| `read` (Standard) | nur lesen |
| `write` | auch anlegen und ändern. Gesperrt bleiben: löschen, stornieren, versenden, mahnen, Bankverbindungen, Webhooks, Import per URL |
| `full` | alles |

`write` schützt vor Versehen, nicht vor manipulierten Anweisungen in Daten oder Dokumenten. Sicher ist nur `read`.

Hat das Token Zugriff auf mehrere Konten, wählt `ABANINJA_ACCOUNT_UUID` das Konto.

## Tools

- `abaninja_search_addresses`: Kunden suchen nach Name, Nummer, E-Mail, Telefon oder Ort
- `abaninja_find_documents`: Rechnungen, Offerten, Gutschriften usw. finden
- `abaninja_open_invoices`: offene Rechnungen mit Summen pro Währung
- `abaninja_list_endpoints`, `abaninja_describe_endpoint`, `abaninja_request`: alle weiteren API-Endpunkte

Datei-Uploads sind nicht möglich. PDFs und andere Dateien zeigt der Server nur mit Typ und Grösse an.

## Entwicklung

```bash
npm test                  # Tests ohne Netz
npm run catalog           # Endpunkt-Katalog aus den OpenAPI-Specs neu erzeugen
npm run live              # Live-Test gegen ein echtes Konto, nur lesend
npm run live -- --write   # legt Testdaten an, ändert und löscht sie wieder
```

Eigenheiten der API: [docs/abaninja-api.md](docs/abaninja-api.md)

## Haftungsausschluss

Dieses Projekt ist inoffiziell und steht in keiner Verbindung zur DeepCloud AG oder zur Abacus Research AG. «AbaNinja» ist eine Marke der jeweiligen Inhaberin.

Die Nutzung erfolgt auf eigene Verantwortung. Wer diesen MCP-Server einsetzt, handelt selbst und ist für alle Aktionen verantwortlich, die darüber ausgelöst werden. Das gilt insbesondere für angelegte oder geänderte Daten und Dokumente und deren Folgen. Von einer KI vorgeschlagene Änderungen sind vor der Verwendung zu prüfen.

Die Software wird ohne jede Gewähr bereitgestellt. Soweit gesetzlich zulässig, übernehmen die Autorinnen, Autoren und Herausgeber keine Haftung für Schäden, Datenverlust, fehlerhafte Buchungen oder Dokumente, die aus der Nutzung entstehen.

Für den Datenschutz ist die nutzende Person oder Organisation selbst verantwortlich, auch für die Verarbeitung von Kundendaten durch den angebundenen KI-Dienst.

## Lizenz

[MIT](LICENSE) © INGENIUMDESIGN
