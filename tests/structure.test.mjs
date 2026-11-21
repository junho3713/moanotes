import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  emptyStructure, encodeStructure, decodeStructure, structureText, structurePrefix,
  addStructureNode, removeStructureNode, structureHasContent, validStructure, swipeDirection,
} from '../structure-model.js';

test('structure survives the existing note body and backup JSON', () => {
  let value = emptyStructure();
  assert.equal(structureHasContent(value), false);
  value.nodes[0].text = '게임 기획\n"플레이어"와 <아이템>';
  const result = addStructureNode(value, value.nodes[0].id, 'right');
  value = result.document;
  value.nodes[1].text = 'AI 3D 픽셀 아트 툴';
  assert.equal(structureHasContent(value), true);
  const body = encodeStructure(value);
  assert.deepEqual(decodeStructure(body), value);
  const backup = JSON.parse(JSON.stringify({ version: 2, notes: [{ body, tags: ['개발'] }] }));
  assert.deepEqual(decodeStructure(backup.notes[0].body), value);
  assert.match(structureText(body), /픽셀 아트/);
  assert.equal(structureText('일반 메모'), '일반 메모');
  assert.equal(decodeStructure(structurePrefix + '{bad json'), null);
});

test('right/down additions never overlap and deleting one node keeps the rest', () => {
  let value = emptyStructure();
  const root = value.nodes[0].id;
  value = addStructureNode(value, root, 'right').document;
  value = addStructureNode(value, root, 'down').document;
  const down = value.nodes[2].id;
  value = addStructureNode(value, down, 'right').document;
  value = addStructureNode(value, value.nodes[1].id, 'down').document;
  assert.equal(new Set(value.nodes.map(({ col, row }) => col + ':' + row)).size, value.nodes.length);
  assert.ok(validStructure(value));
  value.nodes[3].text = '남겨둘 칸';
  const next = removeStructureNode(value, down);
  assert.equal(next.nodes.length, value.nodes.length - 1);
  assert.ok(next.nodes.some(({ text }) => text === '남겨둘 칸'));
  assert.ok(next.edges.every(({ from, to }) => from !== down && to !== down));
  assert.ok(validStructure(next));
  const blank = emptyStructure();
  assert.equal(removeStructureNode(blank, blank.nodes[0].id).nodes.length, 1);
});

test('limits and selected-card gesture directions reject accidental swipes', () => {
  let value = emptyStructure();
  for (let i = 1; i < 64; i++) value = addStructureNode(value, value.nodes[0].id, 'right').document;
  assert.equal(value.nodes.length, 64);
  assert.throws(() => addStructureNode(value, value.nodes[0].id, 'down'), /64/);
  const malformed = emptyStructure(); malformed.nodes[0].col = -1;
  assert.equal(validStructure(malformed), false);
  const duplicated = emptyStructure(); duplicated.nodes.push({ ...duplicated.nodes[0], id: 'another' });
  assert.equal(validStructure(duplicated), false);
  const long = emptyStructure(); long.nodes[0].text = 'a'.repeat(1001);
  assert.throws(() => encodeStructure(long));
  assert.equal(swipeDirection(90, 10), 'right');
  assert.equal(swipeDirection(5, 90), 'down');
  for (const [x, y] of [[30, 0], [0, 20], [-90, 0], [0, -90], [80, 80]]) assert.equal(swipeDirection(x, y), null);
});

test('opening a structure from AI results preserves its original editable graph', async () => {
  const documentValue = emptyStructure();
  documentValue.nodes[0].text = '게임 기획';
  const original = { id: 'structure-note', title: '기획', body: encodeStructure(documentValue), tags: [] };
  const state = { notes: [original] };
  const source = await readFile(new URL('../app.js', import.meta.url), 'utf8');
  const start = source.indexOf('const relatedNotes = createRelatedNotes({');
  const end = source.indexOf('\n});', start) + 4;
  let opened;
  const options = new Function('createRelatedNotes', 'byId', 'state', 'structureText', 'ensureClassificationWorker', 'showEditor',
    source.slice(start, end) + '\nreturn relatedNotes;'
  )((value) => value, () => ({}), state, structureText, () => {}, (note) => { opened = note; });
  const result = options.getNotes()[0];
  assert.equal(result.body, '게임 기획', 'AI compares readable text');
  options.openNote(result);
  assert.equal(opened, original, 'editor receives the original stored note');
  assert.deepEqual(decodeStructure(opened.body), documentValue);
  opened = null;
  state.notes = [];
  options.openNote(result);
  assert.equal(opened, null, 'stale results cannot open deleted notes');
});
