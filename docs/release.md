# Release

## Einmalig

Bei npm anmelden (`npm login`) und [mcp-publisher](https://github.com/modelcontextprotocol/registry/releases/latest) installieren.

## Jedes Release

1. Neue Version setzen und dieselbe Nummer in `server.json` (zweimal) eintragen:
   ```bash
   npm version 0.1.1 --no-git-tag-version
   ```
2. Committen, taggen, pushen. GitHub Actions testet, baut `abaninja-mcp.mcpb` und erstellt das Release:
   ```bash
   git commit -am "Release 0.1.1" && git tag -a v0.1.1 -m "Release 0.1.1" && git push --follow-tags
   ```
3. Auf npm veröffentlichen:
   ```bash
   npm publish
   ```
4. Im offiziellen MCP-Verzeichnis eintragen:
   ```bash
   mcp-publisher login github
   mcp-publisher publish
   ```
