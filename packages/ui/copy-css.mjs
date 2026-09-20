// Copies the component stylesheets into dist/ and, from the authored
// src/styles.css import graph, emits a single flattened dist/styles.css.
//
// The flattened file is what consumers link: one request, no @import
// waterfall, and tools that need a compiled stylesheet (the design-system
// converter among them) get real CSS rather than a list of imports.
import { cp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const src = join(root, 'src');
const dist = join(root, 'dist');

async function copyCss(from, to) {
  await mkdir(to, { recursive: true });
  for (const entry of await readdir(from, { withFileTypes: true })) {
    const source = join(from, entry.name);
    const target = join(to, entry.name);
    if (entry.isDirectory()) await copyCss(source, target);
    else if (entry.name.endsWith('.css')) await cp(source, target);
  }
}

const IMPORT = /^@import\s+["']([^"']+)["'];\s*$/gm;

async function flatten(file, seen = new Set()) {
  const path = resolve(file);
  if (seen.has(path)) return '';
  seen.add(path);
  const text = await readFile(path, 'utf8');
  const parts = [];
  let last = 0;
  for (const match of text.matchAll(IMPORT)) {
    parts.push(text.slice(last, match.index));
    parts.push(await flatten(resolve(dirname(path), match[1]), seen));
    last = match.index + match[0].length;
  }
  parts.push(text.slice(last));
  return parts.join('');
}

await copyCss(src, dist);
await writeFile(
  join(dist, 'styles.css'),
  await flatten(join(src, 'styles.css')),
);
