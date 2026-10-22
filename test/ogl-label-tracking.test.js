import assert from 'node:assert/strict';
import test from 'node:test';
import { PDFDocument, PDFName, StandardFonts } from 'pdf-lib';
import { extractOglLabelTracking } from '../src/services/ogl-label-tracking.js';

const TRACKING = 'YT1234567890123';
const OTHER = 'YT9876543210987';
const mapping = `begincmap
1 begincodespacerange <0000> <ffff> endcodespacerange
2 beginbfchar <003C> <0059> <00A7> <0054> endbfchar
1 beginbfrange <0100> <0109> <0030> endbfrange
endcmap`;
const glyphs = text => [...text].map(char => char === 'Y' ? '003C' : char === 'T' ? '00A7' : (0x100 + Number(char)).toString(16).padStart(4, '0')).join('');

async function fixture(contents, { cmap = null, type0 = false, form = false } = {}) {
  const doc = await PDFDocument.create();
  const standard = await doc.embedFont(StandardFonts.Helvetica);
  const font = cmap || type0 ? doc.context.register(doc.context.obj({
    Type: 'Font', Subtype: 'Type0', BaseFont: 'SyntheticTrackingFont', Encoding: 'Identity-H', DescendantFonts: [],
    ...(cmap ? { ToUnicode: doc.context.register(doc.context.flateStream(cmap)) } : {})
  })) : standard.ref;
  for (const content of contents) {
    const page = doc.addPage([300, 200]);
    const resources = doc.context.obj({ Font: { F6: font } });
    page.node.set(PDFName.of('Resources'), resources);
    if (form) {
      const object = doc.context.register(doc.context.flateStream(content, { Type: 'XObject', Subtype: 'Form', BBox: [0, 0, 300, 200], Resources: resources }));
      page.node.set(PDFName.of('Resources'), doc.context.obj({ XObject: { LabelForm: object } }));
      page.node.set(PDFName.of('Contents'), doc.context.register(doc.context.flateStream('q /LabelForm Do Q')));
    } else page.node.set(PDFName.of('Contents'), doc.context.register(doc.context.flateStream(content)));
  }
  return doc.save();
}

test('standard-font literal, escaped octal, hex and TJ text are recognized without searching metadata', async () => {
  const bytes = await fixture([`BT /F6 12 Tf 1 0 0 1 10 100 Tm (YT12\\0634567890123) Tj ET`,
    `BT /F6 12 Tf [<${Buffer.from('YT123456').toString('hex')}> -20 (7890123)] TJ ET`]);
  const result = await extractOglLabelTracking(bytes, { containersCount: 7 });
  assert.equal(result.status, 'found');
  assert.equal(result.source, 'official_container_label');
  assert.equal(result.carrier_name, '圆通');
  assert.equal(result.master_tracking_number, TRACKING);
  assert.deepEqual(result.tracking_numbers, [TRACKING]);
  assert.equal(result.page_count, 2);
  assert.equal(result.containers_count, 7);
  assert.equal(result.container_mapping_confirmed, false);
  assert.deepEqual(result.labels, [1, 2].map(label_page => ({ label_page, tracking_numbers: [TRACKING] })));
});

test('embedded font ToUnicode bfchar and sequential bfrange map glyphs instead of assuming a fixed offset', async () => {
  const bytes = await fixture([`BT /F6 12 Tf <${glyphs(TRACKING)}> Tj ET`], { cmap: mapping });
  const result = await extractOglLabelTracking(bytes);
  assert.equal(result.master_tracking_number, TRACKING);
  assert.equal(result.containers_count, null);
});

test('ToUnicode bfrange arrays, literal glyph bytes, and TJ segments work in nested Form resources', async () => {
  const arrayMap = mapping.replace('<0030>', `[${Array.from({ length: 10 }, (_, index) => `<${(0x30 + index).toString(16).padStart(4, '0')}>`).join(' ')}]`);
  const prefix = glyphs('YT12345');
  const suffix = glyphs('67890123');
  const bytes = await fixture([`BT /F6 12 Tf [<${prefix}> 10 <${suffix}>] TJ ET`], { cmap: arrayMap, form: true });
  assert.equal((await extractOglLabelTracking(bytes)).master_tracking_number, TRACKING);
});

test('multiple distinct tracking numbers are ambiguous and never assigned an invented parent or container ID', async () => {
  const bytes = await fixture([`BT /F6 12 Tf (${TRACKING}) Tj ET`, `BT /F6 12 Tf (${OTHER}) Tj ET`]);
  const result = await extractOglLabelTracking(bytes, { containersCount: 2 });
  assert.equal(result.status, 'ambiguous');
  assert.equal(result.master_tracking_number, null);
  assert.deepEqual(result.tracking_numbers, [TRACKING, OTHER]);
  assert.equal(result.container_mapping_confirmed, false);
  assert.ok(result.labels.every(label => !Object.hasOwn(label, 'container_no')));
});

test('blank or image-only pages and an unmapped composite font do not guess numbers', async () => {
  const doc = await PDFDocument.create();
  const image = await doc.embedPng(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a3ioAAAAASUVORK5CYII=', 'base64'));
  doc.addPage().drawImage(image, { x: 0, y: 0, width: 20, height: 20 });
  doc.setTitle(TRACKING);
  assert.equal((await extractOglLabelTracking(await doc.save())).status, 'not_found');
  const unmapped = await fixture([`BT /F6 12 Tf (${TRACKING}) Tj ET`], { type0: true });
  assert.equal((await extractOglLabelTracking(unmapped)).status, 'not_found');
});

test('unknown glyphs or line breaks cannot manufacture a tracking number', async () => {
  const bytes = await fixture([`BT /F6 12 Tf <${glyphs('YT12345')}ABCD${glyphs('67890123')}> Tj ET`], { cmap: mapping });
  assert.equal((await extractOglLabelTracking(bytes)).status, 'not_found');
  const separated = await fixture(['BT /F6 12 Tf (YT12345) Tj 0 -10 Td (67890123) Tj ET']);
  assert.equal((await extractOglLabelTracking(separated)).status, 'not_found');
  const gap = await fixture(['BT /F6 12 Tf [(YT12345) -5000 (67890123)] TJ ET']);
  assert.equal((await extractOglLabelTracking(gap)).status, 'not_found');
  const outsideText = await fixture([`/F6 12 Tf (${TRACKING}) Tj`]);
  assert.equal((await extractOglLabelTracking(outsideText)).status, 'not_found');
});

test('invalid input, large files, excessive pages and decompression limits return explicit not-found results', async () => {
  for (const bytes of [null, Buffer.from('not a PDF'), Buffer.alloc(8 * 1024 * 1024 + 1)]) {
    const result = await extractOglLabelTracking(bytes);
    assert.equal(result.status, 'not_found');
    assert.equal(result.master_tracking_number, null);
    assert.deepEqual(result.tracking_numbers, []);
  }
  const doc = await PDFDocument.create();
  for (let index = 0; index < 201; index++) doc.addPage();
  const many = await extractOglLabelTracking(await doc.save());
  assert.equal(many.status, 'not_found');
  assert.equal(many.page_count, 201);
  assert.match(many.notice, /200/);
  const hugeStream = await fixture([' '.repeat(2 * 1024 * 1024 + 10)]);
  const huge = await extractOglLabelTracking(hugeStream);
  assert.equal(huge.status, 'not_found');
  assert.match(huge.notice, /解析上限/);
});

test('unsupported pages discard partial results and overlong tracking-like numbers are not accepted', async () => {
  const bytes = await fixture([`BT /F6 12 Tf (${TRACKING}) Tj ET`, 'BI /W 1 /H 1 ID fake-data EI']);
  const result = await extractOglLabelTracking(bytes);
  assert.equal(result.status, 'not_found');
  assert.equal(result.master_tracking_number, null);
  assert.deepEqual(result.labels, []);
  const overlong = await fixture([`BT /F6 12 Tf (YT${'1'.repeat(25)}) Tj ET`]);
  assert.equal((await extractOglLabelTracking(overlong)).status, 'not_found');
});
