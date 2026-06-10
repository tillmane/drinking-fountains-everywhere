const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const backupFile = process.argv[2];
if (!backupFile) {
  process.stderr.write("Usage: npm run db:restore-local -- <path-to-backup.sql>\n");
  process.stderr.write("Example: npm run db:restore-local -- worker/prod-backup-2026-06-10T23-22-29Z.sql\n");
  process.exit(1);
}

if (!fs.existsSync(backupFile)) {
  process.stderr.write(`File not found: ${backupFile}\n`);
  process.exit(1);
}

const d1Dir = ".wrangler/state/v3/d1/miniflare-D1DatabaseObject";

process.stderr.write("Wiping local D1...\n");
for (const f of fs.readdirSync(d1Dir)) {
  if (f.endsWith(".sqlite") || f.endsWith(".sqlite-shm") || f.endsWith(".sqlite-wal")) {
    fs.rmSync(path.join(d1Dir, f));
  }
}

process.stderr.write(`Restoring from ${backupFile}...\n`);
execSync(`npx wrangler d1 execute drinking-fountains-db --local --file=${backupFile}`, { stdio: "inherit" });
process.stderr.write("Done.\n");
