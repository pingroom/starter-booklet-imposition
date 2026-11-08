import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { step, exportProposal } from './engine.js';
import { readJson } from './storage.js';
import { mockApi, CONFIG, ROOM_CODE } from './mock.js';

const input = await readJson(new URL('../examples/document.json', import.meta.url));
for (const scenario of [
  { title: 'Left binding with separately folded eight-page signatures', settings: ['Left','8'], status: 'complete', signatures: 2 },
  { title: 'Right binding with one twelve-page padded signature', settings: ['Right','16'], status: 'complete', signatures: 1 },
  { title: 'Small four-page signatures gathered in order', settings: ['Left','4'], status: 'complete', signatures: 3 },
  { title: 'Unknown binding withholds the page mapping', settings: ['Unknown','8'], status: 'incomplete' },
]) {
  const directory = await mkdtemp(join(tmpdir(), 'pingroom-booklet-demo-'));
  try {
    const now = () => '2026-01-01T09:00:00.000Z', api = mockApi(now);
    const options = { client: api.client, directory, input, config: CONFIG, token: 'offline-fixture-token', room: ROOM_CODE, now };
    let result;
    for (const setting of scenario.settings) {
      result = await step(options); api.answer(result.answers.find(answer => answer.status === 'pending').questionId, setting); result = await step(options);
    }
    assert.equal(result.status, scenario.status);
    if (scenario.signatures !== undefined) { assert.equal(result.plan.signatureCount, scenario.signatures); assert.deepEqual(await exportProposal(directory, input), result.proposal); }
    else { assert.equal(result.proposal, null); await assert.rejects(exportProposal(directory, input)); }
    console.log(JSON.stringify({ scenario: scenario.title, status: result.status, plan: result.plan }, null, 2));
  } finally { await rm(directory, { recursive: true, force: true }); }
}
console.log('Offline demo used the pinned SDK with local mock transport. No live phone delivery, document rendering or printing.');
