// Builds abaninja-mcp.mcpb for Claude Desktop: the built server, the catalog and its runtime dependencies.
// Usage: npm run bundle (runs the build first)
import { execSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const stage = mkdtempSync(join(tmpdir(), "abaninja-mcpb-"));
try {
  for (const file of ["manifest.json", "icon.png", "package.json", "package-lock.json", "LICENSE", "README.md", "dist", "catalog"]) {
    cpSync(join(root, file), join(stage, file), { recursive: true });
  }
  // The bundle carries the package version.
  const { version } = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  const manifest = JSON.parse(readFileSync(join(stage, "manifest.json"), "utf8"));
  writeFileSync(join(stage, "manifest.json"), JSON.stringify({ ...manifest, version }, null, 2));
  execSync("npm ci --omit=dev --ignore-scripts --no-audit --no-fund", { cwd: stage, stdio: "inherit" });
  execSync(`npx --yes @anthropic-ai/mcpb@2.1.2 pack "${stage}" "${join(root, "abaninja-mcp.mcpb")}"`, { cwd: root, stdio: "inherit" });
} finally {
  rmSync(stage, { recursive: true, force: true });
}
