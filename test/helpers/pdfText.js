'use strict';
// Extracts the rendered text of a pdfkit-generated PDF, line by line, for
// snapshot/freeze comparisons. pdfkit (standard-14 fonts) writes each visual
// line as a `[<hex...> kern <hex...>] TJ` array inside a FlateDecode content
// stream, with the text bytes in WinAnsi (CP1252) encoding — so we inflate
// every stream, pull the hex strings out of each TJ array, and decode CP1252.

const zlib = require('node:zlib');

// CP1252 0x80–0x9F specials (0x00–0x7F is ASCII, 0xA0–0xFF matches Latin-1).
const CP1252_HIGH = {
    0x80: '€', 0x82: '‚', 0x83: 'ƒ', 0x84: '„',
    0x85: '…', 0x86: '†', 0x87: '‡', 0x88: 'ˆ',
    0x89: '‰', 0x8a: 'Š', 0x8b: '‹', 0x8c: 'Œ',
    0x8e: 'Ž', 0x91: '‘', 0x92: '’', 0x93: '“',
    0x94: '”', 0x95: '•', 0x96: '–', 0x97: '—',
    0x98: '˜', 0x99: '™', 0x9a: 'š', 0x9b: '›',
    0x9c: 'œ', 0x9e: 'ž', 0x9f: 'Ÿ',
};

function decodeWinAnsiHex(hex) {
    let out = '';
    for (let i = 0; i + 1 < hex.length; i += 2) {
        const b = parseInt(hex.slice(i, i + 2), 16);
        out += CP1252_HIGH[b] || String.fromCharCode(b);
    }
    return out;
}

// Returns every rendered text line (one per TJ array), in stream order —
// pdfkit flushes pages in order, so this is page order top-to-bottom.
function extractPdfTextLines(pdf) {
    const lines = [];
    let idx = 0;
    while ((idx = pdf.indexOf('stream', idx)) !== -1) {
        // Skip the 'stream' inside 'endstream'.
        if (idx >= 3 && pdf.slice(idx - 3, idx).toString('latin1') === 'end') {
            idx += 'stream'.length;
            continue;
        }
        let start = idx + 'stream'.length;
        if (pdf[start] === 0x0d) start++;
        if (pdf[start] === 0x0a) start++;
        const end = pdf.indexOf('endstream', start);
        if (end === -1) break;
        // Trim the trailing EOL pdfkit writes before 'endstream'.
        let dataEnd = end;
        while (dataEnd > start && (pdf[dataEnd - 1] === 0x0a || pdf[dataEnd - 1] === 0x0d)) dataEnd--;
        let content = null;
        try {
            content = zlib.inflateSync(pdf.slice(start, dataEnd));
        } catch {
            // Not a FlateDecode stream (or not a content stream) — skip.
        }
        if (content) {
            const text = content.toString('latin1');
            const tjRe = /\[((?:<[0-9a-fA-F]*>|[^\]])*)\]\s*TJ/g;
            let m;
            while ((m = tjRe.exec(text)) !== null) {
                let line = '';
                const hexRe = /<([0-9a-fA-F]*)>/g;
                let h;
                while ((h = hexRe.exec(m[1])) !== null) line += decodeWinAnsiHex(h[1]);
                lines.push(line);
            }
        }
        idx = end + 'endstream'.length;
    }
    return lines;
}

module.exports = { extractPdfTextLines };
