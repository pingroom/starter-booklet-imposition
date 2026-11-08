import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile, stat, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { step, localReport, exportProposal } from '../src/engine.js';
import { readJson, atomicJson, acquireLock, atomicText } from '../src/storage.js';
import { validateInput, validateState, tasksFor, parseSetting, bookletImposition, impose, SIGNATURE_SIZES, POLICY, POLICY_HASH, TOKEN, requestFor, validateConfig, hash, iso, isId, ROOM } from '../src/model.js';
import { loadConnection, loadEnvironment, validateConnection } from '../src/config.js';
import { makeClient } from '../src/client.js';
import { mockApi, CONFIG, ROOM_CODE, OTHER, ASKER, id } from '../src/mock.js';

const example = await readJson(new URL('../examples/document.json', import.meta.url), 65536);
const simple = () => structuredClone(example);
const twoItems = () => structuredClone(example);
async function setup(t, input = simple()) {
  const directory = await mkdtemp(join(tmpdir(), 'pingroom-booklet-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const clock = { value: '2026-01-01T09:00:00.000Z' }, now = () => clock.value;
  const api = mockApi(now);
  const options = { client: api.client, directory, input, config: structuredClone(CONFIG), token: 'offline-fixture-token', room: ROOM_CODE, now };
  return { directory, clock, api, options, run: (extra = {}) => step({ ...options, ...extra }), saved: () => readJson(join(directory, 'state.json')) };
}
const sends = (api) => api.calls.filter((call) => call.method === 'POST').length;
async function decide(s, decisions) {
  let result;
  for (const value of decisions) {
    result = await s.run();
    const pending = result.answers.find(item => item.status === 'pending');
    s.api.answer(pending.questionId, value); result = await s.run();
  }
  return result;
}

test('lost response blocks later settings; exact-ID recovery reads the original request without resend', async (t) => {
  const s = await setup(t, twoItems()); s.api.controls.loseNext = true;
  assert.equal((await s.run()).status, 'create_unknown'); assert.equal((await s.run()).status, 'create_unknown');
  assert.deepEqual((await s.run({ command: 'find' })).candidates, [{ id: id(1), state: 'pending' }]);
  s.api.answer(id(1), 'Left'); assert.equal((await s.run({ command: 'recover', attachId: id(1) })).status, 'ready');
  assert.equal(sends(s.api), 1);
});

test('malformed create response and empty search never authorize a new POST', async (t) => {
  const s = await setup(t); s.api.controls.malformedNext = true; await assert.rejects(s.run());
  assert.equal((await s.saved()).attempts[0].status, 'creating'); s.api.questions.clear();
  assert.deepEqual((await s.run({ command: 'find' })).candidates, []);
  assert.equal((await s.run()).status, 'create_unknown'); assert.equal(sends(s.api), 1);
});

test('recovery validates exact target, room, request, options, data and non-handoff provenance', async (t) => {
  for (const mutate of [
    (q) => { q.target_user_id = OTHER; }, (q) => { q.room.code = 'WRONG1234567'; }, (q) => { q.prompt = 'Other prompt'; },
    (q) => { q.options = [{value:'yes',label:'Yes'}]; }, (q) => { q.text_input.max_length = 30; }, (q) => { q.text_input = null; },
    (q) => { q.data.task_id = 'other'; }, (q) => { q.data.input_hash = 'changed'; }, (q) => { delete q.is_handoff; },
    (q) => { q.is_handoff = true; }, (q) => { q.asker.type = 'user'; }, (q) => { q.resolution_policy = 'all'; },
  ]) {
    const s = await setup(t); s.api.controls.loseNext = true; await s.run(); mutate(s.api.questions.get(id(1)));
    await assert.rejects(s.run({ command: 'recover', attachId: id(1) })); assert.equal((await s.saved()).attempts[0].status, 'creating');
    assert.equal(sends(s.api), 1);
  }
});

test('misattributed, malformed or non-text answers never resolve a setting', async (t) => {
  for (const mutate of [
    (q) => { q.answer.responder.id = OTHER; }, (q) => { q.answer.responder = null; },
    (q) => { q.answer.text = '1e2'; }, (q) => { q.answer.value = 'unsupported'; }, (q) => { q.answer.label = 'Wrong'; },
  ]) {
    const s = await setup(t); await s.run(); s.api.answer(id(1), 'Left'); mutate(s.api.questions.get(id(1)));
    const result = await s.run(); assert.equal(result.observedStatus, 'invalid_answer'); assert.equal(result.proposal, null);
    assert.equal(sends(s.api), 1);
  }
});

test('original asker, lifetime and intent remain bound across reads and across settings', async (t) => {
  for (const mutate of [
    (q) => { q.asker.id = OTHER; },
    (q) => { q.created_at = '2026-01-01T09:00:01.000Z'; q.expires_at = '2026-01-01T09:15:01.000Z'; },
  ]) {
    const s = await setup(t); await s.run(); mutate(s.api.questions.get(id(1))); await assert.rejects(s.run(), /identity or lifetime/);
  }
  const s = await setup(t, twoItems()); await s.run(); s.api.answer(id(1), 'Left'); await s.run();
  s.api.controls.loseNext = true; await s.run(); s.api.questions.get(id(2)).asker.id = OTHER;
  await assert.rejects(s.run({ command: 'recover', attachId: id(2) }), /different asking registrations/);
  const other = await setup(t); other.api.controls.loseNext = true; await other.run();
  const q = other.api.questions.get(id(1)); q.created_at = '2026-01-01T08:58:59.000Z'; q.expires_at = '2026-01-01T09:13:59.000Z';
  await assert.rejects(other.run({ command: 'recover', attachId: id(1) }), /predates/);
});

test('expiry accepts delayed processing but rejects premature and implausibly future resolution on replay', async (t) => {
  const s = await setup(t); await s.run(); s.clock.value = '2026-01-01T09:16:00.000Z';
  s.api.terminal(id(1), 'expired'); s.api.questions.get(id(1)).resolved_at = '2026-01-01T09:15:30.000Z';
  assert.equal((await s.run()).observedStatus, 'expired'); assert.equal((await localReport(s.directory, s.options.input)).proposal, null);
  const original = await s.saved();
  for (const timestamp of ['2026-01-01T09:14:59.999Z', '2026-01-01T09:17:00.001Z']) {
    const saved = structuredClone(original); saved.attempts[0].observation.resolvedAt = timestamp;
    await atomicJson(s.directory, 'state.json', saved); const calls = s.api.calls.length;
    await assert.rejects(s.run(), /resolution time/); assert.equal(s.api.calls.length, calls);
    const live = await setup(t); await live.run(); live.clock.value = s.clock.value; live.api.terminal(id(1), 'expired');
    live.api.questions.get(id(1)).resolved_at = timestamp; await assert.rejects(live.run(), /resolution time/);
  }
});

test('answer and resolution times must agree and answer/cancellation cannot occur after expiry', async (t) => {
  const s = await setup(t); await s.run(); s.api.answer(id(1), 'Left');
  s.api.questions.get(id(1)).answer.answered_at = '2026-01-01T09:00:01.000Z';
  assert.equal((await s.run()).observedStatus, 'invalid_answer');
  for (const terminal of ['answered', 'cancelled']) {
    const other = await setup(t); await other.run(); other.clock.value = '2026-01-01T09:16:00.000Z';
    if (terminal === 'answered') other.api.answer(id(1), 'Left'); else other.api.terminal(id(1), terminal);
    await assert.rejects(other.run(), /resolution time/);
  }
});

test('checked time follows response; future creation, wrong TTL and answer on pending fail', async (t) => {
  const s = await setup(t); await s.run(); const get = s.api.client.questions.get.bind(s.api.client.questions);
  s.api.client.questions.get = async (...args) => { s.clock.value = '2026-01-01T09:02:00.000Z'; s.api.answer(id(1), 'Left'); return get(...args); };
  await s.run(); assert.equal((await s.saved()).attempts[0].observation.checkedAt, s.clock.value);
  for (const mutate of [
    (q) => { q.created_at = '2027-01-01T09:00:00.000Z'; q.expires_at = '2027-01-01T09:15:00.000Z'; },
    (q) => { q.expires_at = '2026-01-01T10:00:00.000Z'; }, (q) => { q.answer = {}; },
  ]) { const other = await setup(t); await other.run(); mutate(other.api.questions.get(id(1))); await assert.rejects(other.run()); }
  assert.equal(iso('2026-01-01T09:00:00+00:00'), '2026-01-01T09:00:00.000Z'); assert.throws(() => iso('2026-02-30T09:00:00Z'));
});

test('room preflight refuses public/unsupported rooms and missing operator before a POST', async (t) => {
  for (const mutate of [(rooms) => { rooms[0].is_public = true; }, (rooms) => { rooms[0].type = 'dm'; }, (rooms) => { rooms[0].members = [{ user_id: OTHER }]; }]) {
    const s = await setup(t); mutate(s.api.rooms); await assert.rejects(s.run()); assert.equal(sends(s.api), 0);
  }
});

test('reservation write failure sends nothing; answer save failure resumes the original question', async (t) => {
  const s = await setup(t); let writes = 0;
  await assert.rejects(s.run({ write: async (...args) => { if (++writes === 2) throw new Error('disk full'); await atomicJson(...args); } }), /disk full/);
  assert.equal(sends(s.api), 0); await s.run(); s.api.answer(id(1), 'Left');
  await assert.rejects(s.run({ write: async () => { throw new Error('disk full'); } }), /disk full/);
  assert.equal((await s.saved()).attempts[0].status, 'pending'); assert.equal((await s.run()).status, 'ready'); assert.equal(sends(s.api), 1);
});

test('post-create save failure leaves uncertain intent for verified recovery without another POST', async (t) => {
  const s = await setup(t); let writes = 0;
  await assert.rejects(s.run({ write: async (...args) => { if (++writes === 3) throw new Error('disk full'); await atomicJson(...args); } }), /disk full/);
  assert.equal((await s.run()).status, 'create_unknown');
  assert.equal((await s.run({ command: 'recover', attachId: id(1) })).status, 'pending'); assert.equal(sends(s.api), 1);
});

test('failed reads preserve evidence and corrupted request/provenance fail before network', async (t) => {
  const s = await setup(t); await s.run(); const before = await readFile(join(s.directory, 'state.json'), 'utf8');
  s.api.controls.readError = true; await assert.rejects(s.run()); assert.equal(await readFile(join(s.directory, 'state.json'), 'utf8'), before);
  s.api.controls.readError = false; s.api.answer(id(1), 'Left'); await s.run(); const original = await s.saved();
  for (const mutate of [
    (saved) => { saved.attempts[0].request.ttl = 60; }, (saved) => { saved.attempts.push(saved.attempts[0]); },
    (saved) => { saved.attempts[0].pair = 'other::pair'; }, (saved) => { saved.attempts[0].observation.answer.responderId = OTHER; },
  ]) {
    const saved = structuredClone(original); mutate(saved); assert.throws(() => validateState(saved, s.options.input));
    await atomicJson(s.directory, 'state.json', saved); const calls = s.api.calls.length;
    await assert.rejects(s.run()); assert.equal(s.api.calls.length, calls);
  }
});

test('bounded file reads reject malformed, oversized, invalid UTF-8 and symlink data without revealing contents', async (t) => {
  const s = await setup(t), path = join(s.directory, 'bad.json');
  await writeFile(path, '{"secret":"PRIVATE_TOKEN",bad');
  await assert.rejects(readJson(path), (error) => !error.message.includes('PRIVATE_TOKEN') && error.message.includes('malformed'));
  await writeFile(path, Buffer.from([0xff])); await assert.rejects(readJson(path), /UTF-8/);
  await writeFile(path, 'x'.repeat(100)); await assert.rejects(readJson(path, 50), /size limit/);
  await symlink(path, join(s.directory, 'linked')); await assert.rejects(readJson(join(s.directory, 'linked')));
});

test('private lock excludes other commands; report is offline and private', async (t) => {
  const s = await setup(t); await s.run(); const release = await acquireLock(s.directory);
  await assert.rejects(s.run(), /lock exists/); await assert.rejects(localReport(s.directory, s.options.input), /lock exists/);
  await release(); const before = s.api.calls.length;
  assert.equal((await localReport(s.directory, s.options.input, { save: true })).proposal, null); assert.equal(s.api.calls.length, before);
  assert.equal((await stat(join(s.directory, 'report.json'))).mode & 0o777, 0o600);
});

test('partial or blank environment overrides never combine with saved credentials', async (t) => {
  const s = await setup(t); await atomicJson(s.directory, 'credentials.json', { token: 'saved', room: ROOM_CODE });
  await assert.rejects(loadConnection(s.directory, { PINGROOM_TOKEN: '' })); await assert.rejects(loadConnection(s.directory, { PINGROOM_ROOM: ROOM_CODE }));
  assert.equal((await loadConnection(s.directory, { PINGROOM_TOKEN: 'explicit', PINGROOM_ROOM: ROOM_CODE.toLowerCase() })).token, 'explicit');
});

test('transport rejects unrelated writes, redirects and oversized responses', async () => {
  let count = 0; const client = makeClient({ token: 'fixture', fetchImpl: async () => { count++; return new Response(null, { status: 302 }); } });
  await assert.rejects(client.questions.get(id(1))); assert.equal(count, 1); await assert.rejects(client.questions.cancel(id(1))); assert.equal(count, 1);
  const large = makeClient({ token: 'fixture', fetchImpl: async () => new Response('x'.repeat(512 * 1024 + 1)) }); await assert.rejects(large.questions.get(id(1)));
});

test('transport deadlines bound stalled fetch/body and allow abort through infinite ready empty chunks', async () => {
  const stalled = makeClient({ token: 'fixture', deadlineMs: 20, fetchImpl: () => new Promise(() => {}) }); await assert.rejects(stalled.questions.get(id(1)));
  const body = makeClient({ token: 'fixture', deadlineMs: 20, fetchImpl: async () => new Response(new ReadableStream({ pull: () => new Promise(() => {}) })) }); await assert.rejects(body.questions.get(id(1)));
  const controller = new AbortController();
  const empty = makeClient({ token: 'fixture', signal: controller.signal, fetchImpl: async () => new Response(new ReadableStream({ pull: (out) => out.enqueue(new Uint8Array()) })) });
  const timer = setTimeout(() => controller.abort(), 20); try { await assert.rejects(empty.questions.get(id(1))); } finally { clearTimeout(timer); }
});

test('abort before reservation sends nothing; after reservation it preserves unresolved intent', async (t) => {
  const s = await setup(t), stopped = new AbortController(); stopped.abort(); await assert.rejects(s.run({ signal: stopped.signal })); assert.equal(sends(s.api), 0);
  const controller = new AbortController(); let writes = 0;
  await assert.rejects(s.run({ signal: controller.signal, write: async (...args) => { await atomicJson(...args); if (++writes === 2) controller.abort(); } }));
  assert.equal(sends(s.api), 0); assert.equal((await s.run()).status, 'create_unknown');
});


test('partial external credentials cannot borrow the room from dotenv', async (t) => {
  const s = await setup(t), path = join(s.directory, '.env');
  await writeFile(path, 'PINGROOM_TOKEN=file-token\nPINGROOM_ROOM=DEMO12345678\n');
  const partial = { PINGROOM_TOKEN: 'shell-token' }; await loadEnvironment(partial, path);
  assert.equal(partial.PINGROOM_ROOM, undefined); await assert.rejects(loadConnection(s.directory, partial));
  const env = {}; await loadEnvironment(env, path); assert.deepEqual(await loadConnection(s.directory, env), { token: 'file-token', room: ROOM_CODE });
});



const answersFor = values => ['binding','signature-size'].map((settingId,i)=>({settingId,text:values[i]}));
const documentFor = count => ({documentId:'fixture-v1',title:'Practice booklet',pages:Array.from({length:count},(_,i)=>({id:`page-${i+1}`,label:`Page ${i+1}`}))});

// Reconstruct reading order by visiting the leaves after each signature is folded.
function foldedReading(signature,binding) {
  const inner=binding==='Left'?'right':'left',outer=binding==='Left'?'left':'right';
  return [...signature.sheets.flatMap(sheet=>[sheet.front[inner],sheet.back[outer]]),
    ...[...signature.sheets].reverse().flatMap(sheet=>[sheet.back[inner],sheet.front[outer]])];
}

test('setting grammar is exact, task-specific and rejects alternate Unicode or whitespace',()=>{
  assert.deepEqual(parseSetting('binding','Left'),{kind:'binding',selection:'Left'});
  assert.deepEqual(parseSetting('binding','Right'),{kind:'binding',selection:'Right'});
  for(const size of SIGNATURE_SIZES)assert.deepEqual(parseSetting('signature-size',String(size)),{kind:'signature_size',selection:size});
  for(const task of ['binding','signature-size']){
    assert.deepEqual(parseSetting(task,'Unknown'),{kind:'unknown',selection:null});
    for(const text of ['',null,4,'unknown','Unknown\n','Unknown\r\n','Unknown\u2028','Unknown\u2029',' Unknown','Unknown ','\ud800'])assert.throws(()=>parseSetting(task,text));
  }
  for(const text of ['left','LEFT',' Left','Left\n','0','４','08','+4','4.0','4e0','4\n',' 4','4 ', '20'])assert.throws(()=>parseSetting(text.includes('Left')||['left','LEFT'].includes(text)?'binding':'signature-size',text));
  assert.throws(()=>parseSetting('binding','8'));assert.throws(()=>parseSetting('signature-size','Left'));assert.throws(()=>parseSetting('other','Unknown'));
});

test('eight-page sheet faces match the fixed outside-to-inside reference for both bindings',()=>{
  const left=impose(documentFor(8),'Left',8),right=impose(documentFor(8),'Right',8);
  const numbers=plan=>plan.signatures[0].sheets.map(sheet=>({front:[sheet.front.left.sourceIndex,sheet.front.right.sourceIndex],back:[sheet.back.left.sourceIndex,sheet.back.right.sourceIndex]}));
  assert.deepEqual(numbers(left),[{front:[8,1],back:[2,7]},{front:[6,3],back:[4,5]}]);
  assert.deepEqual(numbers(right),[{front:[1,8],back:[7,2]},{front:[3,6],back:[5,4]}]);
});

test('512 page-count, binding and size combinations reconstruct all ordered pages exactly once',()=>{
  let checked=0;
  for(let count=1;count<=64;count++)for(const binding of ['Left','Right'])for(const max of SIGNATURE_SIZES){
    const input=documentFor(count),plan=impose(input,binding,max),collected=[];let sheetNumber=0,offset=0;
    assert.equal(plan.signatureCount,Math.ceil(count/max));assert.equal(plan.sourcePageCount,count);
    assert.equal(plan.paddedPageCount,count+(4-count%4)%4);assert.equal(plan.sheetCount,plan.paddedPageCount/4);assert.equal(plan.blankCount,plan.paddedPageCount-count);
    for(const [i,signature] of plan.signatures.entries()){
      const actual=Math.min(max,count-offset),reading=foldedReading(signature,binding);
      assert.equal(signature.signatureIndex,i+1);assert.equal(signature.sourcePageCount,actual);assert.equal(signature.paddedPageCount,Math.ceil(actual/4)*4);
      assert.equal(signature.sourceStartIndex,offset+1);assert.equal(signature.sourceEndIndex,offset+actual);
      assert.equal(signature.blankCount,signature.paddedPageCount-actual);
      assert.deepEqual(reading.map(slot=>slot.signaturePage),Array.from({length:signature.paddedPageCount},(_,j)=>j+1));
      for(const [j,slot] of reading.entries()){
        if(j<actual){assert.deepEqual(slot,{kind:'page',pageId:input.pages[offset+j].id,label:input.pages[offset+j].label,sourceIndex:offset+j+1,signaturePage:j+1});collected.push(slot.pageId);}
        else assert.deepEqual(slot,{kind:'blank',pageId:null,label:null,sourceIndex:null,signaturePage:j+1});
      }
      for(const [j,sheet] of signature.sheets.entries()){assert.equal(sheet.sheetIndex,j+1);assert.equal(sheet.sheetNumber,++sheetNumber);}
      if(i<plan.signatures.length-1)assert.equal(signature.blankCount,0);
      offset+=actual;
    }
    assert.deepEqual(collected,input.pages.map(page=>page.id));assert.equal(new Set(collected).size,count);assert.equal(sheetNumber,plan.sheetCount);checked++;
  }
  assert.equal(checked,512);
});

test('single-page and partial-tail signatures pad only at the end to the next multiple of four',()=>{
  const one=impose(documentFor(1),'Left',16);assert.equal(one.paddedPageCount,4);assert.equal(one.sheetCount,1);
  assert.equal(one.signatures[0].sheets[0].front.right.pageId,'page-1');assert.equal(one.signatures[0].sheets[0].front.left.kind,'blank');
  for(const [count,max,lengths] of [[9,8,[8,4]],[13,12,[12,4]],[17,16,[16,4]],[64,12,[12,12,12,12,12,4]]]){
    const result=impose(documentFor(count),'Left',max);assert.deepEqual(result.signatures.map(row=>row.paddedPageCount),lengths);
  }
  for(const max of SIGNATURE_SIZES)assert.equal(impose(documentFor(max),'Right',max).blankCount,0);
});

test('manifest order is semantic; property-key order is not, and metadata stays bound',()=>{
  const input=documentFor(8),before=structuredClone(input),reordered=structuredClone(input);reordered.pages.reverse();
  const plan=impose(input,'Left',8);assert.deepEqual(input,before);assert.notEqual(hash(input),hash(reordered));
  assert.deepEqual(foldedReading(impose(reordered,'Left',8).signatures[0],'Left').map(row=>row.pageId),reordered.pages.map(row=>row.id));
  assert.deepEqual(plan,impose({pages:input.pages.map(({id,label})=>({label,id})),title:input.title,documentId:input.documentId},'Left',8));
  assert.equal(hash(input),hash({pages:input.pages,title:input.title,documentId:input.documentId}));
});

test('schemas bound page counts, IDs, labels, Unicode and unexpected properties',()=>{
  const input=documentFor(64);assert.equal(validateInput(input).pages.length,64);
  for(const mutate of [v=>v.pages=[],v=>v.pages.push({id:'extra',label:'Extra'}),v=>v.pages[1].id=v.pages[0].id,v=>v.pages[0].id='constructor',v=>v.pages[0].id='page\n',v=>v.pages[0].id='a'.repeat(25),v=>v.pages[0].label='x'.repeat(41),v=>v.pages[0].extra=true,v=>v.title='Title\n',v=>v.title='\ud800',v=>v.title='A\u2028B',v=>v.documentId='x\n',v=>v.extra=true]){const bad=structuredClone(input);mutate(bad);assert.throws(()=>validateInput(bad));}
  const unicode=documentFor(1);unicode.title='دليل الممارسة';unicode.pages[0].label='页面';assert.deepEqual(validateInput(unicode),unicode);
  assert.throws(()=>validateConfig({...CONFIG,extra:true}));assert.throws(()=>validateConfig({participant:{...CONFIG.participant,id:CONFIG.participant.id+'\n'}}));
  for(const [binding,size] of [['left',4],['Unknown',4],['Left','4'],['Left',0],['Left',20],['Left',NaN]])assert.throws(()=>impose(input,binding,size));
});

test('both known settings are required and sparse, reordered or surplus evidence is rejected',()=>{
  const input=documentFor(8);assert.equal(bookletImposition(input,answersFor(['Left','8'])).status,'complete');
  for(const values of [[null,'8'],['Left',null],['Unknown','8'],['Right','Unknown'],['Unknown','Unknown']])assert.deepEqual(bookletImposition(input,answersFor(values)),{status:'incomplete',plan:null});
  for(const answers of [[],Array(2),[...answersFor(['Left','8']),{settingId:'extra',text:'Left'}],answersFor(['Left','8']).reverse(),[{settingId:'binding',text:'Left',extra:1},{settingId:'signature-size',text:'8'}],answersFor(['Left',8])])assert.throws(()=>bookletImposition(input,answers));
});

test('full prompts name the manifest and setting within published limits, with all policy hashes',()=>{
  const input=documentFor(64);input.title='t'.repeat(40);input.documentId='d'.repeat(40);
  for(const task of tasksFor(input)){
    const request=requestFor(input,CONFIG,task.id,id(42));assert.ok(request.prompt.length<=500);assert.ok(request.context.length<=40);assert.ok(request.prompt.includes(hash(input.pages)));assert.ok(request.prompt.includes('64 ordered pages'));
    assert.equal(request.data.policy_hash,hash(POLICY));assert.equal(request.data.input_hash,hash(input));assert.equal(request.data.pages_hash,hash(input.pages));assert.equal(request.data.task_id,task.id);
    assert.equal(request.responder_scope,'direct');assert.equal(request.target_user_id,CONFIG.participant.id);assert.equal(request.text_input.max_length,60);assert.equal(request.ttl,900);assert.equal(request.idempotencyKey,request.correlation_id);
  }
  assert.equal(POLICY_HASH,hash(POLICY));
});

test('complete proposal retains both attributed answers and exports deterministic private JSON',async t=>{
  const s=await setup(t),result=await decide(s,['Left','8']);assert.equal(result.status,'complete');assert.equal(result.plan.signatureCount,2);assert.equal(result.plan.sheetCount,3);assert.equal(result.plan.blankCount,3);
  assert.deepEqual(result.proposal.source,s.options.input);assert.equal(result.sourceHash,hash(s.options.input));assert.equal(result.policyHash,POLICY_HASH);
  assert.equal(result.documentBytesRead,false);assert.equal(result.documentRendered,false);assert.equal(result.printingExecuted,false);
  assert.ok(result.answers.every(row=>row.questionId&&row.attemptId&&row.responderId===CONFIG.participant.id&&row.askerId===ASKER&&row.answeredAt&&row.observedAt));
  const calls=s.api.calls.length;assert.deepEqual(await exportProposal(s.directory,s.options.input),result.proposal);assert.equal(s.api.calls.length,calls);
  const path=join(s.directory,'proposal.json'),first=await readFile(path,'utf8');await exportProposal(s.directory,s.options.input);assert.equal(await readFile(path,'utf8'),first);assert.equal((await stat(path)).mode&0o777,0o600);assert.equal(sends(s.api),2);
});

test('Unknown or invalid settings never produce a plan or export after both tasks resolve',async t=>{
  for(const values of [['Unknown','8'],['Right','Unknown'],['left','8'],['Left','08']]){
    const s=await setup(t),result=await decide(s,values);assert.equal(result.status,'incomplete');assert.equal(result.plan,null);assert.equal(result.proposal,null);await assert.rejects(exportProposal(s.directory,s.options.input));assert.equal(sends(s.api),2);
    await assert.rejects(readFile(join(s.directory,'proposal.json')),{code:'ENOENT'});
  }
});

test('cancelled settings stay missing while later settings can still be collected',async t=>{
  const s=await setup(t);await s.run();s.api.terminal(id(1),'cancelled');assert.equal((await s.run()).status,'ready');
  await s.run();s.api.answer(id(2),'8');const result=await s.run();assert.equal(result.status,'incomplete');assert.equal(result.plan,null);await assert.rejects(exportProposal(s.directory,s.options.input));
});

test('changed manifest order or policy and forged typed selections fail before network access',async t=>{
  const s=await setup(t);await s.run();s.api.answer(id(1),'Left');await s.run();const original=await s.saved();
  for(const mutate of [state=>state.attempts[0].observation.answer.selection='Right',state=>state.attempts[0].observation.answer.kind='signature_size',state=>state.attempts[0].request.data.policy_hash='bad',state=>state.attempts[0].request.data.pages_hash='bad']){
    const state=structuredClone(original);mutate(state);await atomicJson(s.directory,'state.json',state);const calls=s.api.calls.length;await assert.rejects(s.run());assert.equal(s.api.calls.length,calls);
  }
  await atomicJson(s.directory,'state.json',original);const changed=structuredClone(s.options.input);changed.pages.reverse();const calls=s.api.calls.length;await assert.rejects(s.run({input:changed}));assert.equal(s.api.calls.length,calls);
});

test('tokens, identifiers and room codes reject trailing line terminators',()=>{
  for(const suffix of ['\n','\r\n','\u2028','\u2029']){assert.equal(TOKEN.test('token'+suffix),false);assert.equal(isId(CONFIG.participant.id+suffix),false);assert.equal(ROOM.test(ROOM_CODE+suffix),false);assert.throws(()=>validateConnection({token:'token'+suffix,room:ROOM_CODE}));}
});
