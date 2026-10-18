# abaninja-mcp

Inoffizieller MCP-Server für [AbaNinja](https://www.abaninja.ch). KI-Assistenten greifen damit über die offizielle REST-API auf ein AbaNinja-Konto zu: Kunden, Rechnungen, Offerten, Produkte und alles Weitere, was die API anbietet.

> **Status:** in Entwicklung, noch nicht auf npm veröffentlicht.

## Tools

| Tool | Zweck |
| --- | --- |
| `abaninja_list_endpoints` | Endpunkte der API finden, nach Bereich oder Stichwort |
| `abaninja_describe_endpoint` | Parameter und Felder eines Endpunkts |
| `abaninja_request` | Einen beliebigen Endpunkt aufrufen, im Rahmen des eingestellten Modus |
| `abaninja_search_addresses` | Kunden und Lieferanten nach Name, Kundennummer, E-Mail, Ort oder Tag suchen |
| `abaninja_open_invoices` | Offene Rechnungen mit Betrag, Fälligkeit und Mahnstufe, auf Wunsch pro Kunde |

## Modi

Standardmässig kann der Server nur lesen. Alles Weitere schaltet man über `ABANINJA_MODE` bewusst frei.

| Modus | Erlaubt | Gesperrt |
| --- | --- | --- |
| `read` (Standard) | nur Lesen | alles, was etwas ändert |
| `write` | zusätzlich Anlegen und Ändern | Löschen, Versenden (auch Zahlungsbestätigungen), Mahnen, Stornieren, Massenaktionen, ausgehende Webhooks |
| `full` | die ganze API | nichts |

## Voraussetzungen

- Node.js ab Version 22
- Ein kostenpflichtiges AbaNinja-Abo
- Ein API-Token aus AbaNinja, erstellt in den Einstellungen im Bereich Automatisierung ([Anleitung](https://docs.abaninja.ch/guide/authentication.html)). Am besten ein eigenes Token nur mit den nötigen Bereichen und mit Ablaufdatum.

## Einrichtung

Beispiel für Claude Desktop (`claude_desktop_config.json`) oder Claude Code (`.mcp.json`). Andere MCP-Clients werden analog eingerichtet.

```json
{
  "mcpServers": {
    "abaninja": {
      "command": "npx",
      "args": ["-y", "abaninja-mcp"],
      "env": {
        "ABANINJA_API_TOKEN": "dein-token",
        "ABANINJA_MODE": "read"
      }
    }
  }
}
```

## Konfiguration

| Variable | Pflicht | Bedeutung |
| --- | --- | --- |
| `ABANINJA_API_TOKEN` | ja | API-Token aus AbaNinja |
| `ABANINJA_ACCOUNT_UUID` | nein | Konto; wird automatisch gewählt, wenn das Token genau ein Konto hat |
| `ABANINJA_MODE` | nein | `read` (Standard), `write` oder `full` |

## Entwicklung

```bash
npm install
npm run build
npm test          # Tests ohne Netz, mit erfundenen Daten
npm run catalog   # Endpunkt-Katalog aus den aktuellen OpenAPI-Specs neu erzeugen
```

Eigenheiten der AbaNinja-API, die beim Bau aufgefallen sind: [docs/abaninja-api.md](docs/abaninja-api.md)

## Hinweis und Haftungsausschluss

Dieses Projekt ist inoffiziell und steht in keiner Verbindung zur DeepCloud AG oder zur Abacus Research AG. «AbaNinja» ist eine Marke der jeweiligen Inhaberin.

Die Nutzung erfolgt auf eigene Verantwortung. Wer diesen MCP-Server einsetzt, handelt selbst und ist für alle Aktionen verantwortlich, die darüber ausgelöst werden. Das gilt insbesondere für angelegte oder geänderte Daten und Dokumente und deren Folgen. Von einer KI vorgeschlagene Änderungen sind vor der Verwendung zu prüfen.

Die Software wird ohne jede Gewähr bereitgestellt. Soweit gesetzlich zulässig, übernehmen die Autorinnen, Autoren und Herausgeber keine Haftung für Schäden, Datenverlust, fehlerhafte Buchungen oder Dokumente, die aus der Nutzung entstehen.

Für den Datenschutz ist die nutzende Person oder Organisation selbst verantwortlich, auch für die Verarbeitung von Kundendaten durch den angebundenen KI-Dienst.

## Lizenz

[MIT](LICENSE) © INGENIUMDESIGN
