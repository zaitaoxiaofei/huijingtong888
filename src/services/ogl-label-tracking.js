import { PDFDocument, PDFName, PDFArray, PDFDict, PDFRawStream, decodePDFRawStream } from 'pdf-lib';

const MAX_PDF_BYTES = 8 * 1024 * 1024;
const MAX_STREAM_BYTES = 2 * 1024 * 1024;
const MAX_TOTAL_BYTES = 16 * 1024 * 1024;
const MAX_TOKENS = 400000;
const MAX_CMAP_ENTRIES = 65536;
const whitespace = char => char === undefined || /[\x00\t\n\f\r ]/.test(char);
const delimiter = char => whitespace(char) || /[()[\]<>/%]/.test(char);
const name = value => PDFName.of(value);

function stop(message) { throw new Error(message); }

// Only content operators are interpreted. Metadata, image data and arbitrary
// PDF byte strings are never searched as evidence of a printed tracking number.
function tokenize(text, budget) {
  const tokens = [];
  let index = 0;
  const push = token => {
    if (++budget.tokens > MAX_TOKENS) stop('标签文本结构超过解析上限，请直接查看官方标签。');
    tokens.push(token);
  };
  while (index < text.length) {
    const char = text[index];
    if (whitespace(char)) { index++; continue; }
    if (char === '%') { while (index < text.length && !/[\r\n]/.test(text[index])) index++; continue; }
    if (char === '(') {
      const bytes = []; let depth = 1; index++;
      while (index < text.length && depth) {
        let value = text[index++];
        if (value === '\\') {
          value = text[index++];
          if (value === '\r' || value === '\n') { if (value === '\r' && text[index] === '\n') index++; continue; }
          if (/[0-7]/.test(value || '')) {
            let octal = value;
            for (let digit = 0; digit < 2 && /[0-7]/.test(text[index] || ''); digit++) octal += text[index++];
            bytes.push(parseInt(octal, 8) & 255); continue;
          }
          const escapes = { n: 10, r: 13, t: 9, b: 8, f: 12 };
          if (value !== undefined) bytes.push(escapes[value] ?? value.charCodeAt(0));
        } else if (value === '(') { depth++; bytes.push(40); }
        else if (value === ')') { if (--depth) bytes.push(41); }
        else if (value === '\r') { if (text[index] === '\n') index++; bytes.push(10); }
        else bytes.push(value.charCodeAt(0));
      }
      if (depth) stop('标签文字格式不受支持，请直接查看官方标签。');
      push({ type: 'bytes', value: Buffer.from(bytes) }); continue;
    }
    if (char === '<' && text[index + 1] !== '<') {
      const end = text.indexOf('>', index + 1);
      if (end < 0) stop('标签文字格式不受支持，请直接查看官方标签。');
      let hex = text.slice(index + 1, end).replace(/\s/g, '');
      if (!/^[\da-f]*$/i.test(hex)) stop('标签文字格式不受支持，请直接查看官方标签。');
      if (hex.length % 2) hex += '0';
      push({ type: 'bytes', value: Buffer.from(hex, 'hex') }); index = end + 1; continue;
    }
    if (char === '[' || char === ']') { push({ type: char }); index++; continue; }
    if (char === '<' || char === '>') { push({ type: 'word', value: text.slice(index, index + 2) }); index += 2; continue; }
    if (char === '/') {
      const start = ++index;
      while (index < text.length && !delimiter(text[index])) index++;
      push({ type: 'name', value: text.slice(start, index).replace(/#([\da-f]{2})/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16))) }); continue;
    }
    const start = index++;
    while (index < text.length && !delimiter(text[index])) index++;
    const value = text.slice(start, index);
    push({ type: /^[+-]?(?:\d+\.?\d*|\.\d+)$/.test(value) ? 'number' : 'word', value });
  }
  return tokens;
}

function decodedStream(stream, budget) {
  if (!(stream instanceof PDFRawStream)) stop('标签文字流格式不受支持，请直接查看官方标签。');
  const bytes = decodePDFRawStream(stream).getBytes(MAX_STREAM_BYTES + 1);
  budget.bytes += bytes.length;
  if (bytes.length > MAX_STREAM_BYTES || budget.bytes > MAX_TOTAL_BYTES) stop('标签解压后的内容超过解析上限，请直接查看官方标签。');
  return Buffer.from(bytes).toString('latin1');
}

function unicode(bytes) {
  if (!bytes?.length || bytes.length % 2) return '';
  if (bytes.length > 256) stop('标签字体映射超过解析上限，请直接查看官方标签。');
  const units = [];
  for (let index = 0; index < bytes.length; index += 2) units.push(bytes.readUInt16BE(index));
  if (units[0] === 0xfeff) units.shift();
  return String.fromCharCode(...units);
}

function cmap(stream, budget) {
  const tokens = tokenize(decodedStream(stream, budget), budget);
  const mapping = new Map();
  const put = (source, target) => {
    if (!source.length || source.length > 4 || !target) return;
    mapping.set(source.toString('hex'), target);
    if (mapping.size > MAX_CMAP_ENTRIES) stop('标签字体映射超过解析上限，请直接查看官方标签。');
  };
  for (let index = 0; index < tokens.length; index++) {
    if (tokens[index].value === 'beginbfchar') {
      while (tokens[index + 1] && tokens[index + 1].value !== 'endbfchar') {
        const source = tokens[++index]; const target = tokens[++index];
        if (source?.type !== 'bytes' || target?.type !== 'bytes') stop('标签字体映射不受支持，请直接查看官方标签。');
        put(source.value, unicode(target.value));
      }
    } else if (tokens[index].value === 'beginbfrange') {
      while (tokens[index + 1] && tokens[index + 1].value !== 'endbfrange') {
        const first = tokens[++index]; const last = tokens[++index]; const target = tokens[++index];
        if (first?.type !== 'bytes' || last?.type !== 'bytes' || !first.value.length || first.value.length > 4 || first.value.length !== last.value.length) stop('标签字体映射不受支持，请直接查看官方标签。');
        const start = parseInt(first.value.toString('hex'), 16); const end = parseInt(last.value.toString('hex'), 16);
        if (end < start || end - start >= MAX_CMAP_ENTRIES) stop('标签字体映射超过解析上限，请直接查看官方标签。');
        if (target?.type === 'bytes' && target.value.length <= 16 && target.value.length) {
          const initial = BigInt(`0x${target.value.toString('hex')}`); const width = target.value.length * 2;
          for (let code = start; code <= end; code++) {
            const hex = (initial + BigInt(code - start)).toString(16).padStart(width, '0');
            if (hex.length > width) stop('标签字体映射不受支持，请直接查看官方标签。');
            put(Buffer.from(code.toString(16).padStart(first.value.length * 2, '0'), 'hex'), unicode(Buffer.from(hex, 'hex')));
          }
        } else if (target?.type === '[') {
          for (let code = start; code <= end; code++) {
            const entry = tokens[++index];
            if (entry?.type !== 'bytes') stop('标签字体映射不受支持，请直接查看官方标签。');
            put(Buffer.from(code.toString(16).padStart(first.value.length * 2, '0'), 'hex'), unicode(entry.value));
          }
          if (tokens[++index]?.type !== ']') stop('标签字体映射不受支持，请直接查看官方标签。');
        } else stop('标签字体映射不受支持，请直接查看官方标签。');
      }
    }
  }
  return mapping;
}

function fontDecoder(resources, fontName, budget) {
  const fonts = resources?.lookupMaybe(name('Font'), PDFDict);
  const font = fonts?.lookupMaybe(name(fontName), PDFDict);
  if (!font) return () => ' ';
  if (budget.fonts.has(font)) return budget.fonts.get(font);
  const toUnicode = font.lookup(name('ToUnicode'));
  let decode;
  if (toUnicode instanceof PDFRawStream) {
    const mapping = cmap(toUnicode, budget);
    const widths = [...new Set([...mapping.keys()].map(key => key.length / 2))].sort((a, b) => b - a);
    decode = bytes => {
      let result = ''; let index = 0;
      while (index < bytes.length) {
        const width = widths.find(size => index + size <= bytes.length && mapping.has(bytes.subarray(index, index + size).toString('hex')));
        const value = width ? mapping.get(bytes.subarray(index, index + width).toString('hex')) : ' ';
        budget.characters += value.length;
        if (budget.characters > MAX_TOTAL_BYTES) stop('标签文字内容超过解析上限，请直接查看官方标签。');
        result += value;
        index += width || widths[widths.length - 1] || 1;
      }
      return result;
    };
  } else {
    const subtype = font.lookup(name('Subtype'))?.toString();
    const encoding = font.lookup(name('Encoding'));
    const base = font.lookup(name('BaseFont'))?.toString() || '';
    const asciiSafe = subtype !== '/Type0' && (encoding?.toString() === '/WinAnsiEncoding'
      || encoding?.toString() === '/MacRomanEncoding'
      || (!encoding && /^\/(Helvetica|Times|Courier)(?:-|$)/.test(base)));
    decode = asciiSafe ? bytes => {
      budget.characters += bytes.length;
      if (budget.characters > MAX_TOTAL_BYTES) stop('标签文字内容超过解析上限，请直接查看官方标签。');
      return Buffer.from(bytes).toString('latin1').replace(/[^\x20-\x7e]/g, ' ');
    } : () => ' ';
  }
  budget.fonts.set(font, decode);
  return decode;
}

function contentText(stream, resources, budget, state, ancestry = new Set()) {
  if (ancestry.has(stream) || ancestry.size >= 8 || ++budget.streams > 1000) stop('标签文字结构超过解析上限，请直接查看官方标签。');
  const parents = new Set(ancestry); parents.add(stream);
  const tokens = tokenize(decodedStream(stream, budget), budget);
  const operands = []; const savedFonts = []; let output = ''; let arrayDepth = 0;
  for (const token of tokens) {
    if (token.type === '[') {
      if (++arrayDepth > 32) stop('标签文字数组结构超过解析上限，请直接查看官方标签。');
      operands.push(token); continue;
    }
    if (token.type === ']') {
      const items = []; let operand;
      while ((operand = operands.pop()) && operand.type !== '[') items.push(operand);
      if (!operand) stop('标签文字数组格式不受支持，请直接查看官方标签。');
      arrayDepth--;
      operands.push({ type: 'array', value: items.reverse() }); continue;
    }
    if (token.type !== 'word') { operands.push(token); continue; }
    if (arrayDepth) stop('标签文字数组格式不受支持，请直接查看官方标签。');
    const last = operands[operands.length - 1];
    if (token.value === 'BT') state.inText = true;
    else if (token.value === 'Tf' && state.inText) {
      const font = operands[operands.length - 2];
      state.font = font?.type === 'name' ? font.value : '';
    } else if (state.inText && (token.value === 'Tj' || token.value === "'" || token.value === '"')) {
      if (token.value !== 'Tj') output += '\n';
      if (last?.type === 'bytes') output += fontDecoder(resources, state.font, budget)(last.value);
    } else if (state.inText && token.value === 'TJ' && last?.type === 'array') {
      const decode = fontDecoder(resources, state.font, budget);
      output += last.value.map(item => item.type === 'bytes' ? decode(item.value) : item.type === 'number' && Math.abs(Number(item.value)) > 1000 ? ' ' : '').join('');
    } else if (['ET', 'T*', 'Td', 'TD', 'Tm'].includes(token.value)) {
      output += '\n';
      if (token.value === 'ET') state.inText = false;
    }
    else if (token.value === 'q') savedFonts.push(state.font);
    else if (token.value === 'Q') state.font = savedFonts.pop() || '';
    else if (token.value === 'Do' && last?.type === 'name') {
      const xobjects = resources?.lookupMaybe(name('XObject'), PDFDict);
      const form = xobjects?.lookup(name(last.value));
      if (form instanceof PDFRawStream && form.dict.lookup(name('Subtype'))?.toString() === '/Form') {
        output += `\n${contentText(form, form.dict.lookupMaybe(name('Resources'), PDFDict) || resources, budget, { font: state.font, inText: false }, parents)}\n`;
      }
    } else if (token.value === 'BI') stop('标签含不支持的内联图像，请直接查看官方标签。');
    operands.length = 0;
  }
  return output;
}

const trackingNumbers = text => [...new Set(text.match(/(?<![A-Za-z0-9])YT\d{10,24}(?![A-Za-z0-9])/g) || [])];

export async function extractOglLabelTracking(buffer, { containersCount } = {}) {
  const count = Number(containersCount);
  const result = {
    status: 'not_found', source: 'official_container_label', carrier_name: null,
    tracking_numbers: [], master_tracking_number: null, labels: [], page_count: 0,
    containers_count: Number.isSafeInteger(count) && count > 0 && count <= 1000 ? count : null,
    container_mapping_confirmed: false,
    notice: '标签未包含可识别的文本运单号，请直接查看官方标签核对。'
  };
  if (!(buffer instanceof Uint8Array) || !buffer.length) return { ...result, notice: '没有可解析的官方货位标签 PDF。' };
  if (buffer.length > MAX_PDF_BYTES) return { ...result, notice: '官方标签 PDF 超过 8 MB 解析上限，请直接查看官方标签。' };
  let document;
  try { document = await PDFDocument.load(buffer, { updateMetadata: false, throwOnInvalidObject: true }); }
  catch { return { ...result, notice: '官方标签 PDF 无法解析或已加密，请直接查看官方标签。' }; }
  result.page_count = document.getPageCount();
  if (result.page_count > 200) return { ...result, notice: '官方标签超过 200 页解析上限，请直接查看官方标签。' };
  const budget = { bytes: 0, tokens: 0, streams: 0, characters: 0, fonts: new WeakMap() };
  try {
    for (const [index, page] of document.getPages().entries()) {
      const content = page.node.Contents(); const resources = page.node.Resources(); const state = { font: '', inText: false };
      let text = '';
      const streams = content instanceof PDFArray ? content.asArray().map(ref => document.context.lookup(ref)) : content ? [content] : [];
      for (const stream of streams) text += contentText(stream, resources, budget, state);
      result.labels.push({ label_page: index + 1, tracking_numbers: trackingNumbers(text) });
    }
  } catch (error) {
    // No partial master number: another unsupported page could contain a
    // different number and change the conclusion to ambiguous.
    return { ...result, labels: [], notice: /^标签/.test(error.message) ? error.message : '官方标签文字无法完整解析，请直接查看官方标签。' };
  }
  result.tracking_numbers = [...new Set(result.labels.flatMap(page => page.tracking_numbers))];
  if (result.tracking_numbers.length) result.carrier_name = '圆通';
  if (result.tracking_numbers.length === 1) {
    result.status = 'found'; result.master_tracking_number = result.tracking_numbers[0];
    result.notice = '已从官方货位标签识别运单号；标签页序不代表官方货位编号，未推定子母单关系。';
  } else if (result.tracking_numbers.length > 1) {
    result.status = 'ambiguous';
    result.notice = '官方标签中包含多个不同运单号，未推定主运单或子母单关系，请逐页核对。';
  }
  return result;
}
