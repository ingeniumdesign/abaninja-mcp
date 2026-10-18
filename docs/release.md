# Release

## Einmalig vor dem ersten Release

1. In `package.json` die Zeile `"private": true` entfernen.
2. Repository auf GitHub öffentlich schalten.
3. Bei npm anmelden: `npm login`.

## Jedes Release

1. Neue Version setzen und dieselbe Nummer in `server.json` (zweimal) eintragen:
   ```bash
   npm version 0.1.1 --no-git-tag-version
   ```
2. Committen, taggen, pushen. GitHub Actions testet, baut `abaninja-mcp.mcpb` und erstellt das Release:
   ```bash
   git commit -am "Release 0.1.1" && git tag v0.1.1 && git push --follow-tags
   ```
3. Auf npm veröffentlichen:
   ```bash
   npm publish
   ```
4. Im offiziellen MCP-Verzeichnis eintragen ([mcp-publisher](https://github.com/modelcontextprotocol/registry/releases/latest)):
   ```bash
   mcp-publisher login github
   mcp-publisher publish
   ```
