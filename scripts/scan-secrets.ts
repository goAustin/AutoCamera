import { readFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { extname } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const binaryExtensions = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.mp4',
  '.woff',
  '.woff2',
  '.ico',
]);

const rules: readonly [string, RegExp][] = [
  ['private key material', /-----BEGIN (?:RSA |OPENSSH |EC )?PRIVATE KEY-----/],
  ['long bearer token', /Bearer\s+[A-Za-z0-9._~-]{20,}/i],
  ['OpenAI-style API key', /(?:^|[^A-Za-z0-9])(?:sk|pk)-[A-Za-z0-9_-]{20,}/],
  [
    'non-placeholder environment credential',
    /^[ \t]*(?:DEV_AUTH_TOKEN|COMFY_AUTH_TOKEN|PI_API_KEY)[ \t]*=[ \t]*(?!$|#|replace-with|fixture|test-token|demo-local-token|<)[^\s#\r\n]{12,}/im,
  ],
  [
    'signed URL query material',
    /(?:X-Amz-Signature|sig|signature)=([A-Za-z0-9%_-]{24,})/i,
  ],
];

const { stdout } = await execFileAsync(
  'git',
  ['ls-files', '--cached', '--others', '--exclude-standard'],
  { encoding: 'utf8' },
);
const files = String(stdout)
  .split('\n')
  .map((file) => file.trim())
  .filter(Boolean);
const findings: string[] = [];

for (const file of files) {
  if (binaryExtensions.has(extname(file).toLowerCase())) continue;
  let content: string;
  try {
    content = await readFile(file, 'utf8');
  } catch {
    continue;
  }
  for (const [name, rule] of rules) {
    if (rule.test(content)) findings.push(`${file}: ${name}`);
  }
}

if (findings.length > 0) {
  console.error('FAIL secret scan: suspicious values were found.');
  for (const finding of findings) console.error(`- ${finding}`);
  process.exitCode = 1;
} else {
  console.log(
    `PASS secret scan: ${files.length} tracked/intentional files inspected.`,
  );
}
