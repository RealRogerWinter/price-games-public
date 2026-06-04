// Extract all image URLs from seed.ts and check them
import { readFileSync } from 'fs';
const seed = readFileSync('apps/server/src/seed.ts', 'utf-8');
const urls = [...seed.matchAll(/image_url:\s*"([^"]+)"/g)].map(m => m[1]);

let broken = 0;
for (const url of urls) {
  const res = await fetch(url, { method: 'HEAD' });
  if (!res.ok) {
    console.log(`BROKEN (${res.status}): ${url}`);
    broken++;
  }
}
console.log(`\nChecked ${urls.length} URLs, ${broken} broken.`);
