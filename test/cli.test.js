import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, cp, symlink, writeFile, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const source = fileURLToPath(new URL('..', import.meta.url));
const preload = `
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
const file = process.env.PROBE_QUESTIONS;
const questions = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
globalThis.fetch = async (raw, init) => {
  if (process.env.PROBE_OFFLINE === 'yes') throw new Error('Offline command attempted a request');
  const url = new URL(raw);
  assert.equal(url.origin, 'https://api.pingroom.io');
  assert.equal(init.redirect, 'manual');
  if (init.method === 'GET' && url.pathname === '/api/agent/rooms') return Response.json([{ invite_code: 'DEMO12345678', type: 'standard', is_public: false, members: [{ user_id: '11111111-1111-4111-8111-111111111111' }] }]);
  if (init.method === 'POST' && url.pathname === '/api/agent/rooms/DEMO12345678/questions') {
    const body = JSON.parse(init.body), now = new Date().toISOString();
    assert.equal(body.options, undefined);
    assert.deepEqual(body.text_input, {placeholder:body.data.task_id==='binding'?'Left, Right, or Unknown':'4, 8, 12, 16, or Unknown',max_length:60});
    assert.equal(new Headers(init.headers).get('idempotency-key'), body.correlation_id);
    const id = '01990000-0000-7000-8000-' + String(Object.keys(questions).length + 1).padStart(12, '0');
    const q = { ...body, id, kind: 'question', is_handoff: false, resolution_policy: 'first', room_code: 'DEMO12345678', room: { code: 'DEMO12345678' },
      asker: { type: 'agent', id: '33333333-3333-4333-8333-333333333333' }, results: null, options: [],
      state: 'pending', created_at: now, expires_at: new Date(Date.parse(now) + 900000).toISOString(), resolved_at: null, answer: null, reply_to: null };
    questions[id] = q; writeFileSync(file, JSON.stringify(questions));
    if (process.env.PROBE_LOST === 'yes') throw new Error('Lost creation response');
    return Response.json(q, { status: 201 });
  }
  if (init.method === 'GET' && url.pathname === '/api/agent/questions') return Response.json({questions:Object.values(questions)});
  if (init.method === 'GET' && url.pathname.startsWith('/api/agent/questions/')) {
    const q = questions[url.pathname.split('/').at(-1)];
    if (!q) throw new Error('Unexpected Question');
    if (process.env.PROBE_ANSWER !== undefined) {
      q.state = 'answered'; q.resolved_at = new Date().toISOString();
      q.answer = { value:null, label:null, text:process.env.PROBE_ANSWER, responder:{id:q.target_user_id}, answered_at:q.resolved_at };
    } else if (process.env.PROBE_CANCEL === 'yes') { q.state = 'cancelled'; q.resolved_at = new Date().toISOString(); }
    writeFileSync(file, JSON.stringify(questions)); return Response.json(q);
  }
  throw new Error('Unexpected mocked request');
};
`;
async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'booklet-imposition-cli-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await cp(join(source, 'src'), join(directory, 'src'), { recursive: true });
  await cp(join(source, 'package.json'), join(directory, 'package.json'));
  await cp(join(source, 'config.example.json'), join(directory, 'config.json'));
  await symlink(join(source, 'node_modules'), join(directory, 'node_modules'));
  await writeFile(join(directory, 'preload.mjs'), preload);
  await cp(join(source, 'examples/document.json'), join(directory, 'document.json'));
  return directory;
}
function run(directory, command = ['run'], extra = {}) {
  const env = { ...process.env, PINGROOM_TOKEN: 'offline-fixture', PINGROOM_ROOM: 'DEMO12345678', PROBE_QUESTIONS: join(directory, 'questions.json') };
  for (const key of ['NODE_OPTIONS','PROBE_ANSWER','PROBE_CANCEL','PROBE_LOST','PROBE_OFFLINE']) delete env[key];
  Object.assign(env,extra);
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', join(directory, 'preload.mjs'), join(directory, 'src/cli.js'), ...command], { cwd: tmpdir(), env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', data => { stdout += data; }); child.stderr.on('data', data => { stderr += data; });
    const timer = setTimeout(() => child.kill('SIGKILL'), 8000);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', code => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
  });
}
async function collect(directory, values) {
  let answer;
  for(const [i,value] of values.entries()) {
    const pending=await run(directory);assert.equal(pending.code,3,pending.stderr);assert.equal(JSON.parse(pending.stdout).status,'pending');
    answer=await run(directory,['run'],{PROBE_ANSWER:value});
    if(i<values.length-1)assert.ok([2,3].includes(answer.code),answer.stderr);
  }
  return answer;
}


test('CLI collects settings and exports attributed imposition from another directory', async t => {
  const directory=await fixture(t),validation=await run(directory,['validate'],{PROBE_OFFLINE:'yes'});assert.equal(validation.code,0,validation.stderr);
  assert.equal(JSON.parse(validation.stdout).tasks.length,2);assert.equal(JSON.parse(validation.stdout).documentId,'practice-guide-v1');
  const finished=await collect(directory,['Left','8']);assert.equal(finished.code,0,finished.stderr);const report=JSON.parse(finished.stdout);assert.equal(report.status,'complete');assert.equal(report.plan.signatureCount,2);assert.equal(report.plan.sheetCount,3);assert.equal(report.plan.blankCount,3);
  for(const command of ['status','report']){const result=await run(directory,[command],{PROBE_OFFLINE:'yes'});assert.equal(result.code,0,result.stderr);assert.deepEqual(JSON.parse(result.stdout).proposal,report.proposal);}
  const exported=await run(directory,['export'],{PROBE_OFFLINE:'yes',PINGROOM_TOKEN:undefined,PINGROOM_ROOM:undefined});assert.equal(exported.code,0,exported.stderr);
  const proposal=JSON.parse(exported.stdout),path=join(directory,'.booklet/proposal.json');assert.deepEqual(proposal,report.proposal);assert.equal(proposal.source.documentId,'practice-guide-v1');assert.equal(proposal.printingExecuted,false);
  assert.ok(proposal.answers.every(answer=>answer.questionId&&answer.responderId&&answer.askerId&&answer.answeredAt));const bytes=await readFile(path,'utf8');assert.deepEqual(JSON.parse(bytes),proposal);assert.equal((await stat(path)).mode&0o777,0o600);
  assert.equal((await run(directory,['export'],{PROBE_OFFLINE:'yes'})).code,0);assert.equal(await readFile(path,'utf8'),bytes);assert.equal(Object.keys(JSON.parse(await readFile(join(directory,'questions.json'),'utf8'))).length,2);
});

test('CLI uncertain creation recovers the exact original Question without a second POST', async t => {
  const directory=await fixture(t);assert.equal((await run(directory,['run'],{PROBE_LOST:'yes'})).code,4);assert.equal((await run(directory)).code,4);
  const found=await run(directory,['find']);assert.equal(found.code,4,found.stderr);const id=JSON.parse(found.stdout).candidates[0].id;
  const recovered=await run(directory,['recover',id],{PROBE_ANSWER:'Left'});assert.equal(recovered.code,3,recovered.stderr);assert.equal(JSON.parse(recovered.stdout).status,'ready');
  assert.equal(Object.keys(JSON.parse(await readFile(join(directory,'questions.json'),'utf8'))).length,1);assert.equal((await run(directory,['recover','not-a-uuid'])).code,1);
});

test('CLI Unknown and malformed settings withhold the plan and proposal export', async t => {
  for(const values of [['Unknown','8'],['Right','Unknown'],['left','8'],['Left','08']]){
    const directory=await fixture(t);assert.equal((await run(directory,['export'],{PROBE_OFFLINE:'yes'})).code,1);const result=await collect(directory,values);assert.equal(result.code,2,result.stderr);
    const report=JSON.parse(result.stdout);assert.equal(report.status,'incomplete');assert.equal(report.proposal,null);assert.equal(report.plan,null);
    assert.equal((await run(directory,['export'],{PROBE_OFFLINE:'yes'})).code,1);await assert.rejects(readFile(join(directory,'.booklet/proposal.json')),{code:'ENOENT'});
  }
});

test('CLI cancellation and invalid returned text preserve the later ready setting', async t => {
  for(const extra of [{PROBE_CANCEL:'yes'},{PROBE_ANSWER:'left'},{PROBE_ANSWER:'Unknown\n'},{PROBE_ANSWER:'Left\u2028'}]){
    const directory=await fixture(t);await run(directory);const result=await run(directory,['run'],extra);assert.equal(result.code,2,result.stderr);assert.equal(JSON.parse(result.stdout).status,'ready');assert.equal(JSON.parse(result.stdout).proposal,null);
  }
});

test('CLI rejects incomplete credential pairs and loads dotenv only when neither shell value is present', async t => {
  const directory=await fixture(t);await writeFile(join(directory,'.env'),'PINGROOM_TOKEN=offline-fixture\nPINGROOM_ROOM=DEMO12345678\n');
  for(const extra of [{PINGROOM_TOKEN:''},{PINGROOM_ROOM:''},{PINGROOM_TOKEN:'has whitespace'},{PINGROOM_ROOM:undefined}]){const result=await run(directory,['run'],extra);assert.equal(result.code,1);assert.equal(result.stdout,'');}
  const complete=await run(directory,['run'],{PINGROOM_TOKEN:undefined,PINGROOM_ROOM:undefined});assert.equal(complete.code,3,complete.stderr);
  assert.equal((await run(directory,['export','/tmp/not-allowed.json'],{PROBE_OFFLINE:'yes'})).code,1);
});

test('CLI right binding mirrors each face and pads a short final signature only as needed', async t => {
  const directory=await fixture(t),finished=await collect(directory,['Right','16']);assert.equal(finished.code,0,finished.stderr);const result=JSON.parse(finished.stdout),plan=result.plan;
  assert.equal(plan.signatureCount,1);assert.equal(plan.paddedPageCount,12);assert.equal(plan.sheetCount,3);assert.equal(plan.blankCount,3);
  const sheet=plan.signatures[0].sheets[0];assert.equal(sheet.front.left.sourceIndex,1);assert.equal(sheet.front.right.kind,'blank');assert.equal(sheet.back.left.kind,'blank');assert.equal(sheet.back.right.sourceIndex,2);
  assert.equal((await run(directory,['export'],{PROBE_OFFLINE:'yes'})).code,0);
});

test('CLI changed page order cannot reuse a pending session or send a replacement question', async t => {
  const directory=await fixture(t);assert.equal((await run(directory)).code,3);const path=join(directory,'document.json'),input=JSON.parse(await readFile(path,'utf8'));input.pages.reverse();await writeFile(path,JSON.stringify(input));
  assert.equal((await run(directory)).code,1);assert.equal(Object.keys(JSON.parse(await readFile(join(directory,'questions.json'),'utf8'))).length,1);
});
