// Reads a Word document of FAQs ("FAQ12: Question?" headings followed by the answer) and returns
// [{ no, question, answer }] with the answer in the plain-text format the site shows:
// 4 spaces per level, • ◦ ▪ bullets, **bold** for labels.
const mammoth = require('mammoth');

const ENT = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&nbsp;': ' ' };
const decode = s => String(s).replace(/&(amp|lt|gt|quot|nbsp|#39);/g, m => ENT[m]).replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n));
const BUL = ['•', '◦', '▪'];

function htmlToText(html) {
  const lines = [];
  let depth = 0, cur = '', inLi = false, bold = 0, liDepthStack = [];
  const flush = (kind) => {
    let t = cur.replace(/\*\*(\s*)\*\*/g, '$1').replace(/\*\*(\s*)([^*]*?)(\s*)\*\*/g, (_, a, b, c) => (b.trim() ? `${a}**${b}**${c}` : `${a}${c}`));
    t = decode(t).replace(/[\t ]+/g, ' ').replace(/ {2,}/g, ' ').trim();
    cur = '';
    if (!t) return;
    if (kind === 'li') lines.push('    '.repeat(Math.max(0, depth - 1)) + BUL[Math.min(2, Math.max(0, depth - 1))] + ' ' + t);
    else lines.push(t);
  };
  const re = /<(\/?)([a-z0-9]+)([^>]*?)(\/?)>|([^<]+)/gi;
  let m, lastKind = 'p';
  while ((m = re.exec(html))) {
    if (m[5] !== undefined) { cur += m[5]; continue; }
    const close = m[1] === '/', tag = m[2].toLowerCase();
    if (tag === 'strong' || tag === 'b') { cur += '**'; }
    else if (tag === 'ul' || tag === 'ol') { if (!close) { if (inLi && cur.trim()) flush('li'); depth++; } else { depth = Math.max(0, depth - 1); if (!depth) lines.push(''); } }
    else if (tag === 'li') { if (!close) { if (cur.trim()) flush(inLi ? 'li' : 'p'); inLi = true; } else { flush('li'); inLi = depth > 1; } }
    else if (tag === 'p' || /^h\d$/.test(tag)) { if (close) { flush(inLi ? 'li' : 'p'); if (!depth) lines.push(''); } else if (cur.trim()) flush('p'); }
    else if (tag === 'br') { cur += ' '; }
    // em, sup, a, img: keep the text only
  }
  flush('p');
  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

async function parseFaqDocx(buffer) {
  const { value } = await mammoth.convertToHtml({ buffer }, { styleMap: ['u => span'] });
  const clean = value.replace(/<img[^>]*>/g, '');
  const parts = clean.split(/(?=<h[1-6]>)/);
  const items = [];
  for (const part of parts) {
    const mh = part.match(/^<h[1-6]>([\s\S]*?)<\/h[1-6]>/);
    if (!mh) continue;
    const title = decode(mh[1].replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim();
    const t = title.match(/^FAQ\s*(\d+)\s*[:.\-–]\s*(.+)$/i);
    if (!t) continue;
    const answer = htmlToText(part.slice(mh[0].length));
    items.push({ no: +t[1], question: t[2].trim(), answer });
  }
  return items;
}

module.exports = { parseFaqDocx, htmlToText };
