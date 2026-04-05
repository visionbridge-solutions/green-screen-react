#!/usr/bin/env node
/**
 * Generate an IBM-Kanji (CCSID 300 host double-byte) → Unicode mapping
 * table for the green-screen proxy.
 *
 * Sources supported:
 *   1. A local or remote `IBM-300.TXT` / `EBCDIC.TXT`-style file in the
 *      Unicode Consortium "MAPPINGS" format. Columns are whitespace-
 *      separated: "<hex_ibm_bytes>\t<hex_unicode>" one entry per line,
 *      with '#' comments.
 *   2. Any other two-column file with the same shape.
 *
 * Output is written as a plain JSON object to stdout (or --out path):
 *
 *   {
 *     "4141": "\u3000",
 *     "4281": "\uff21",
 *     ...
 *   }
 *
 * Keys are four-hex-digit IBM byte pairs (byte1 || byte2 in hex, lower-
 * case or upper-case — the loader accepts either).
 *
 * Usage:
 *   node scripts/generate-ibm-kanji-table.mjs --source IBM-300.TXT --out table.json
 *   node scripts/generate-ibm-kanji-table.mjs --source https://.../IBM-300.TXT
 *
 * The output JSON is consumed by `registerDbcsTable()` from
 * `src/tn5250/ebcdic-jp.ts`:
 *
 *   import { registerDbcsTable } from 'green-screen-proxy/tn5250/ebcdic-jp';
 *   import kanji from './ibm-kanji-table.json' with { type: 'json' };
 *   registerDbcsTable(kanji);
 *
 * Where to get a source file:
 *   - ICU4C source tree: `icu/source/data/mappings/ibm-300_*.ucm`
 *   - Unicode Consortium MAPPINGS/OBSOLETE (historical IBM tables)
 *   - glibc: `localedata/charmaps/IBM300` (note: slightly different format)
 *
 * This script intentionally does NOT fetch any data automatically so the
 * output is reproducible and the source is explicit.
 */

import { readFileSync, writeFileSync } from 'node:fs';

function parseArgs(argv) {
  const out = { source: null, out: null, format: 'auto' };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--source' || a === '-s') out.source = argv[++i];
    else if (a === '--out' || a === '-o') out.out = argv[++i];
    else if (a === '--format') out.format = argv[++i];
    else if (a === '--help' || a === '-h') {
      console.log(readFileSync(new URL(import.meta.url)).toString().slice(2, 1400));
      process.exit(0);
    }
  }
  return out;
}

/**
 * Parse a Unicode MAPPINGS-style two-column file.
 * Each data line: <ibm_hex>\s+<unicode_hex>[\s+#.*]
 * IBM hex may be prefixed with 0x (e.g. "0x4141" or "4141").
 * Unicode hex may be prefixed with 0x or U+ (e.g. "0x3000", "U+3000").
 */
function parseUnicodeMapping(text) {
  const table = {};
  const lines = text.split(/\r?\n/);
  for (const rawLine of lines) {
    const line = rawLine.split('#')[0].trim();
    if (!line) continue;
    const cols = line.split(/\s+/);
    if (cols.length < 2) continue;
    const ibm = cols[0].replace(/^0x/i, '').toUpperCase();
    const uni = cols[1].replace(/^0x/i, '').replace(/^U\+/i, '');
    // Only keep DBCS entries (4-hex-digit IBM bytes)
    if (!/^[0-9A-F]{4}$/.test(ibm)) continue;
    const cp = parseInt(uni, 16);
    if (!Number.isFinite(cp) || cp <= 0) continue;
    try {
      table[ibm] = String.fromCodePoint(cp);
    } catch {
      // skip invalid code points
    }
  }
  return table;
}

/**
 * Parse an ICU .ucm (Universal Character Map) file for double-byte entries.
 * Each relevant line looks like: <U3000> \x42\x41 |0
 */
function parseUcm(text) {
  const table = {};
  const lines = text.split(/\r?\n/);
  let inBody = false;
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (line === 'CHARMAP') { inBody = true; continue; }
    if (line === 'END CHARMAP') break;
    if (!inBody || !line || line.startsWith('#')) continue;
    // <U3000>  \x42\x41 |0
    const m = line.match(/^<U([0-9A-Fa-f]+)>\s+((?:\\x[0-9A-Fa-f]{2}){2,})\s*(?:\|[0-3])?\s*$/);
    if (!m) continue;
    const cp = parseInt(m[1], 16);
    const bytesHex = m[2].replace(/\\x/gi, '').toUpperCase();
    if (bytesHex.length !== 4) continue;
    try {
      table[bytesHex] = String.fromCodePoint(cp);
    } catch {}
  }
  return table;
}

function detectFormat(text) {
  if (/^CHARMAP/m.test(text)) return 'ucm';
  return 'mapping';
}

async function main() {
  const args = parseArgs(process.argv);
  if (!args.source) {
    console.error('error: --source <path-or-url> is required');
    console.error('Run with --help for details.');
    process.exit(2);
  }

  let text;
  if (/^https?:/i.test(args.source)) {
    const res = await fetch(args.source);
    if (!res.ok) {
      console.error(`error: fetch ${args.source}: ${res.status} ${res.statusText}`);
      process.exit(2);
    }
    text = await res.text();
  } else {
    text = readFileSync(args.source, 'utf8');
  }

  const format = args.format === 'auto' ? detectFormat(text) : args.format;
  const table = format === 'ucm' ? parseUcm(text) : parseUnicodeMapping(text);

  const count = Object.keys(table).length;
  if (count === 0) {
    console.error('error: no DBCS entries parsed from source (wrong format?)');
    process.exit(2);
  }

  const json = JSON.stringify(table, null, 0);
  if (args.out) {
    writeFileSync(args.out, json);
    console.error(`wrote ${count} entries to ${args.out}`);
  } else {
    process.stdout.write(json);
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
