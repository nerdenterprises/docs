#!/usr/bin/env node
/**
 * Extracts readable text from ScanSnap iX500 PDFs.
 * Handles both encoding types used by ScanSnap:
 *   1. Unicode hex sequences: <00520065006600660020> (e.g. lawyer-hardened scans)
 *   2. Direct text in TJ operators: [ CITY ] TJ (standard ScanSnap output)
 * Usage: node read-pdf.mjs <path-to-pdf>
 * Output: plain text, one token per line merged into paragraphs
 */
import { readFileSync } from 'fs';
import { inflateSync } from 'zlib';

const filePath = process.argv[2];
if (!filePath) { console.error('Usage: node read-pdf.mjs <path>'); process.exit(1); }

const buf = readFileSync(filePath);
const raw = buf.toString('binary');

const allWords = [];

// Extract all FlateDecode-compressed stream sections
const streamRe = /stream\r?\n([\s\S]*?)\r?\nendstream/g;
let m;
while ((m = streamRe.exec(raw)) !== null) {
  const bytes = Buffer.from(m[1], 'binary');
  try {
    const decompressed = inflateSync(bytes).toString('binary');

    // Method 1: Hex sequences in TJ arrays — handles both Unicode (4 hex/char) and ASCII (2 hex/char)
    const hexWords = [];
    const hexRe = /<([0-9A-Fa-f]{2,})>/g;
    let hm;
    while ((hm = hexRe.exec(decompressed)) !== null) {
      const hex = hm[1];
      if (hex.length < 2) continue;
      let str = '';
      // Detect encoding: if pairs are mostly 0x00 leading bytes → Unicode (4 hex/char)
      // otherwise ASCII (2 hex/char)
      const isUnicode = hex.length % 4 === 0 &&
        (parseInt(hex.slice(0,2),16) === 0 || parseInt(hex.slice(4,6),16) === 0);
      if (isUnicode) {
        for (let i = 0; i < hex.length; i += 4) {
          const cp = parseInt(hex.slice(i, i + 4), 16);
          if (cp >= 0x20) str += String.fromCharCode(cp);
        }
      } else {
        for (let i = 0; i < hex.length; i += 2) {
          const cp = parseInt(hex.slice(i, i + 2), 16);
          if (cp >= 0x20 && cp <= 0x7E) str += String.fromCharCode(cp);
        }
      }
      const clean = str.trim();
      if (clean.length > 0) hexWords.push(clean);
    }

    // Method 2: TJ operator arrays [ word ] TJ
    const tjWords = [];
    const tjRe = /\[\s+([^\[\]]+?)\s+\]\s+TJ/g;
    let tm;
    while ((tm = tjRe.exec(decompressed)) !== null) {
      const word = tm[1].replace(/[^\x20-\x7E]/g, '').trim();
      if (word.length > 0 && !/^\d+(\.\d+)?$/.test(word)) tjWords.push(word);
    }

    // Use whichever method yielded more content
    const words = hexWords.length >= tjWords.length ? hexWords : tjWords;
    if (words.length > 0) allWords.push(...words);
  } catch { /* not a compressed stream, skip */ }
}

// Merge into readable text, inserting spaces between tokens
console.log(allWords.join(' '));
