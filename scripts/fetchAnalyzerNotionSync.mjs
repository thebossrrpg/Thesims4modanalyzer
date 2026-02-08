import fs from "node:fs";
import { pipeline } from "node:stream/promises";

function die(msg) {
  console.error(msg);
  process.exit(1);
}

const url = process.env.ANALYZER_NOTIONSYNC_URL;
const out = process.env.ANALYZER_NOTIONSYNC_OUT || "analyzer_notionsync.json";

if (!url) {
  die("Missing env ANALYZER_NOTIONSYNC_URL");
}

const res = await fetch(url, {
  headers: {
    // se precisar token (repo privado / API):
    ...(process.env.GITHUB_TOKEN
      ? { Authorization: `Bearer ${process.env.GITHUB_TOKEN}` }
      : {}),
    Accept: "application/octet-stream",
  },
});

if (!res.ok) {
  die(`Download failed: ${res.status} ${res.statusText}`);
}

await pipeline(res.body, fs.createWriteStream(out));
console.log(`Downloaded -> ${out}`);
