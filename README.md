# abaninja-mcp

Inoffizieller MCP-Server für [AbaNinja](https://www.abaninja.ch). KI-Assistenten greifen damit über die offizielle REST-API auf ein AbaNinja-Konto zu: Kunden, Rechnungen, Offerten, Produkte und fast alles Weitere, was die API anbietet.

> **Status:** in Entwicklung, noch nicht auf npm veröffentlicht. Bis dahin wird der Server aus diesem Repository installiert (siehe Einrichtung).

## Tools

| Tool | Zweck |
| --- | --- |
| `abaninja_list_endpoints` | Endpunkte der API finden, nach Bereich oder Stichwort |
| `abaninja_describe_endpoint` | Parameter und Felder eines Endpunkts, inklusive bedingter Pflichtfelder |
| `abaninja_request` | Einen beliebigen Endpunkt aufrufen, im Rahmen des eingestellten Modus |
| `abaninja_search_addresses` | Kunden und Lieferanten nach Name, Kundennummer, E-Mail, Telefon, Strasse, Ort oder Tag suchen, unabhängig von Akzenten und Umlauten |
| `abaninja_find_documents` | Rechnungen, Offerten, Gutschriften und andere Dokumente nach Nummer, Text, Kunde oder Status finden |
| `abaninja_open_invoices` | Offene Rechnungen mit Betrag, Fälligkeit und Mahnstufe, Summen pro Währung, auf Wunsch pro Kunde |

Nicht möglich sind Datei-Uploads (Anhänge, Logos, Bilder). Dateien wie PDFs werden nur mit Typ und Grösse angezeigt, nicht als Inhalt. Offene Gutschriften werden bei den offenen Rechnungen nicht abgezogen.

## Modi

Standardmässig kann der Server nur lesen. Alles Weitere schaltet man über `ABANINJA_MODE` bewusst frei.

| Modus | Erlaubt | Gesperrt |
| --- | --- | --- |
| `read` (Standard) | nur Lesen | alles, was etwas ändert |
| `write` | zusätzlich Anlegen und Ändern | Löschen, Stornieren, Versenden (auch Zahlungsbestätigungen), Mahnen, Mahnwesen-Einstellungen und automatisches Mahnen, Massenaktionen, Bankverbindungen, ausgehende Webhooks, Import über eine URL |
| `full` | die ganze API | nichts |

Der Modus `write` schützt vor versehentlichen Aktionen, ist aber keine vollständige Sicherheitsgrenze gegen gezielt manipulierte Anfragen (zum Beispiel Anweisungen, die in Dokumenten oder Daten versteckt sind). Sicher ist nur `read`. Für `write` und `full` am besten ein eigenes Token mit möglichst wenigen Bereichen verwenden und jede Änderung bestätigen.

Der Server arbeitet immer nur mit einem Konto. Hat das Token Zugriff auf mehrere, legt `ABANINJA_ACCOUNT_UUID` fest, welches.

## Voraussetzungen

- Node.js ab Version 22
- Ein kostenpflichtiges AbaNinja-Abo
- Ein API-Token aus AbaNinja, erstellt in den Einstellungen im Bereich Automatisierung ([Anleitung](https://docs.abaninja.ch/guide/authentication.html)). Am besten ein eigenes Token nur mit den nötigen Bereichen und mit Ablaufdatum. Ohne den Bereich `profile` muss `ABANINJA_ACCOUNT_UUID` gesetzt sein.

## Einrichtung

Installation aus diesem Repository (`npm install` baut den Server gleich mit):

```bash
git clone https://github.com/ingeniumdesign/abaninja-mcp.git
cd abaninja-mcp
npm install
```

Eintrag für Claude Desktop (`claude_desktop_config.json`). Andere MCP-Clients werden analog eingerichtet, der Pfad zeigt auf `dist/index.js` im geklonten Ordner:

```json
{
  "mcpServers": {
    "abaninja": {
      "command": "node",
      "args": ["C:/Pfad/zu/abaninja-mcp/dist/index.js"],
      "env": {
        "ABANINJA_API_TOKEN": "dein-token",
        "ABANINJA_MODE": "read"
      }
    }
  }
}
```

In Claude Code gehört das Token nicht in eine `.mcp.json`, die im Projekt eingecheckt wird. Entweder den Server für den eigenen Benutzer eintragen (`claude mcp add --scope user …`) oder in der `.mcp.json` auf eine Umgebungsvariable verweisen: `"ABANINJA_API_TOKEN": "${ABANINJA_API_TOKEN}"`.

Hinter einem Proxy nutzt Node.js die Variable `HTTPS_PROXY` nur, wenn zusätzlich `NODE_USE_ENV_PROXY=1` gesetzt ist.

## Konfiguration

| Variable | Pflicht | Bedeutung |
| --- | --- | --- |
| `ABANINJA_API_TOKEN` | ja | API-Token aus AbaNinja |
| `ABANINJA_ACCOUNT_UUID` | nein | Das Konto, mit dem der Server arbeitet; ohne Angabe das einzige Konto des Tokens |
| `ABANINJA_MODE` | nein | `read` (Standard), `write` oder `full` |

## Entwicklung

```bash
npm install
npm test                    # Tests ohne Netz, mit erfundenen Daten
npm run catalog             # Endpunkt-Katalog aus den aktuellen OpenAPI-Specs neu erzeugen
npm run live                # Live-Test gegen ein echtes Konto, nur lesend
npm run live -- --write     # zusätzlich Testdaten anlegen, ändern und wieder löschen
```

Der Live-Test liest das Token aus `ABANINJA_API_TOKEN`. Bestehende Daten liest er nur. Mit `--write` legt er eine Test-Firma, eine Test-Person, ein Test-Produkt sowie eine Offerte und eine Rechnung als Entwurf an, alle mit dem Namen «ZZ-Test abaninja-mcp», und löscht sie am Ende wieder. Die Entwürfe belegen dabei je eine Nummer im Nummernkreis. Bricht ein Lauf ab, räumt `npm run live -- --cleanup` die übrig gebliebenen Testdaten auf.

Eigenheiten der AbaNinja-API, die beim Bau aufgefallen sind: [docs/abaninja-api.md](docs/abaninja-api.md)

## Hinweis und Haftungsausschluss

Dieses Projekt ist inoffiziell und steht in keiner Verbindung zur DeepCloud AG oder zur Abacus Research AG. «AbaNinja» ist eine Marke der jeweiligen Inhaberin.

Die Nutzung erfolgt auf eigene Verantwortung. Wer diesen MCP-Server einsetzt, handelt selbst und ist für alle Aktionen verantwortlich, die darüber ausgelöst werden. Das gilt insbesondere für angelegte oder geänderte Daten und Dokumente und deren Folgen. Von einer KI vorgeschlagene Änderungen sind vor der Verwendung zu prüfen.

Die Software wird ohne jede Gewähr bereitgestellt. Soweit gesetzlich zulässig, übernehmen die Autorinnen, Autoren und Herausgeber keine Haftung für Schäden, Datenverlust, fehlerhafte Buchungen oder Dokumente, die aus der Nutzung entstehen.

Für den Datenschutz ist die nutzende Person oder Organisation selbst verantwortlich, auch für die Verarbeitung von Kundendaten durch den angebundenen KI-Dienst.

## Lizenz

[MIT](LICENSE) © INGENIUMDESIGN
