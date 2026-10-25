# Release

1. Neue Version setzen:
   ```bash
   npm version 0.1.2 --no-git-tag-version
   ```
2. Committen, taggen, pushen. GitHub Actions testet, baut `abaninja-mcp.mcpb` und erstellt das Release:
   ```bash
   git commit -am "Release 0.1.2" && git tag -a v0.1.2 -m "Release 0.1.2" && git push --follow-tags
   ```
