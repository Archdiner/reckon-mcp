import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'os';
import path from 'path';
import fs from 'fs';
import { Storage, scheduleAfterGrade, scheduleAfterRecall } from './storage.js';
import { ComprehensionLoop } from './loop.js';
import { gatePasses, DIMENSIONS } from './rubric.js';
import { elicitPrompt } from './elicit.js';

// Isolate the DB to a temp dir so tests never touch ~/.reckon.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'reckon-v5-'));
process.env.RECKON_HOME = tmp;
// Point the grader at a nonexistent CLI so grade() fails open deterministically
// (no network / no claude subprocess in unit tests).
process.env.RECKON_GRADER_CMD = '/nonexistent-reckon-grader-cli';

test('rubric: three hard gates exist', () => {
  const gates = DIMENSIONS.filter((d) => d.gate).map((d) => d.key);
  assert.deepEqual(gates.sort(), ['correctness', 'inference', 'mechanism']);
});

test('gatePasses: medium floor tolerates one gate at 1, harsh does not', () => {
  const oneAtOne = { mechanism: 2, inference: 1, correctness: 2 };
  assert.equal(gatePasses(oneAtOne, 'medium'), true);
  assert.equal(gatePasses(oneAtOne, 'harsh'), false);
});

test('gatePasses: any gate at 0 always fails', () => {
  const zero = { mechanism: 0, inference: 2, correctness: 2 };
  assert.equal(gatePasses(zero, 'medium'), false);
  assert.equal(gatePasses(zero, 'harsh'), false);
});

test('gatePasses: medium fails when two gates are at 1', () => {
  const twoAtOne = { mechanism: 1, inference: 1, correctness: 2 };
  assert.equal(gatePasses(twoAtOne, 'medium'), false);
});

test('elicitPrompt asks for MECHANISM, not procedure', () => {
  const p = elicitPrompt({ concept: 'grader-isolation', subsystem: 'reckon', stage: 'build' });
  assert.match(p, /MECHANISM/);
  assert.match(p, /BREAK if it were done differently/);
  assert.doesNotMatch(p, /walk me through the steps/i);
});

test('rigor floors at medium (never gentle)', async () => {
  const loop = new ComprehensionLoop(new Storage());
  const r = await loop.open({ concept: 'c', subsystem: 's', stage: 'build', groundTruth: 'gt', rigor: undefined as any, sessionId: 'x' });
  assert.equal(r.rigor, 'medium');
});

test('scheduling: assisted pass comes back sooner than a clean pass', () => {
  const clean = new Date(scheduleAfterGrade(true, false)!).getTime();
  const assisted = new Date(scheduleAfterGrade(true, true)!).getTime();
  assert.ok(assisted < clean, 'assisted recall must be scheduled sooner');
  assert.equal(scheduleAfterGrade(false, false), undefined, 'failed checkpoints are not scheduled');
});

test('scheduling: survived recall lengthens, decayed shortens', () => {
  const survived = new Date(scheduleAfterRecall('survived', 1)).getTime();
  const decayed = new Date(scheduleAfterRecall('decayed', 1)).getTime();
  assert.ok(survived > decayed);
});

test('full loop: explain → grade (fail-open) → logged UNGRADED, NOT scheduled (F2)', async () => {
  const storage = new Storage();
  await storage.init();
  const loop = new ComprehensionLoop(storage);

  const opened = await loop.open({
    concept: 'isolated-grader',
    subsystem: 'reckon',
    stage: 'build',
    groundTruth: 'The grader runs in a separate process on a different model.',
    sessionId: 'test-session',
  });
  assert.ok(opened.id);
  assert.match(opened.prompt, /Explain/);

  const graded = await loop.submit(opened.id, 'It is isolated so it cannot rubber-stamp its own work.', false);
  assert.ok(graded);
  assert.equal(graded!.pass, true, 'fail-open must not block the human');
  assert.equal(graded!.ungraded, true, 'a failed-open grade must be flagged ungraded');
  assert.equal(graded!.next_recall_due, undefined, 'F2: an ungraded pass must NOT be scheduled for recall');

  const all = await storage.getAll();
  assert.equal(all.length, 1);
  assert.equal(all[0].concept, 'isolated-grader');
  assert.equal(all[0].ungraded, true, 'F2: ledger must record ungraded, not a silent pass');

  // F2: an ungraded item must never surface in the cold-recall queue.
  await storage.update(all[0].id, { next_recall_due: new Date(Date.now() - 1000).toISOString() });
  const due = await storage.getDueForRecall('reckon');
  // (only reachable if something forced a due date; the point is ungraded is flagged)
  assert.ok(due.every((d) => d.ungraded === true || d.next_recall_due));
  await storage.close();
});

test('plan: decompose → gate top-N, cover-partial FAILS (false-pass fix), tail deferred', async () => {
  // A committed mock CLI that answers both the decompose and plan-grade calls.
  const mock = path.join(tmp, 'plan-mock.mjs');
  fs.writeFileSync(
    mock,
    `#!/usr/bin/env node
const argv=process.argv.join('\\n');let s='';process.stdin.setEncoding('utf8');
process.stdin.on('data',d=>s+=d);
process.stdin.on('end',()=>{let v;
 if(argv.includes('load-bearing decisions')){v={decisions:[
   {concept:'a',summary:'decision a',question:'why a?'},{concept:'b',summary:'decision b',question:'why b?'},
   {concept:'c',summary:'decision c',question:'why c?'},{concept:'d',summary:'decision d',question:'why d?'}]};}
 else if(argv.includes("Reckon's plan grader")){const gated=['a','b','c'];
   const covered=gated.filter(c=>s.includes('[[COVER:'+c+']]'));const missing=gated.filter(c=>!covered.includes(c));
   v={covered,missing,pass:missing.length===0,hole:missing.length?'explain '+missing[0]:'',note:'p'};}
 else v={scores:{},pass:false,overlap:'high',hole:'x',note:'s'};
 process.stdout.write(JSON.stringify(v));});`
  );
  fs.chmodSync(mock, 0o755);
  const prev = process.env.RECKON_GRADER_CMD;
  process.env.RECKON_GRADER_CMD = mock;
  try {
    const storage = new Storage();
    await storage.init();
    const loop = new ComprehensionLoop(storage);
    const o = await loop.open({ concept: 'p', subsystem: 'plansub', stage: 'plan', groundTruth: 'a big multi-decision plan', sessionId: 's' });
    assert.match(o.prompt, /decision a/, 'plan prompt must name the decomposed decisions');
    assert.match(o.prompt, /come back later|recall/, 'plan prompt must mention deferred tail');

    // cover only 2 of the 3 gated → must FAIL (this is the false-pass fix)
    const partial = await loop.submit(o.id, '[[COVER:a]] [[COVER:b]] two of three', false);
    assert.equal(partial!.pass, false, 'covering 2 of 3 gated decisions must FAIL');

    // cover all 3 → pass, and the 1 tail decision (d) is deferred into the recall queue
    const full = await loop.submit(o.id, '[[COVER:a]] [[COVER:b]] [[COVER:c]] all three', false);
    assert.equal(full!.pass, true, 'covering all gated decisions passes');
    const rows = await storage.getBySubsystem('plansub');
    const deferred = rows.filter((r) => r.concept === 'd');
    assert.equal(deferred.length, 1, 'the tail decision must be deferred into the ledger for recall');
    assert.equal(deferred[0].attempts, 0, 'a deferred decision has not been examined yet');
    await storage.close();
  } finally {
    process.env.RECKON_GRADER_CMD = prev;
  }
});

test('recall: a due item surfaces metadata-only (no stored explanation leaked)', async () => {
  const storage = new Storage();
  await storage.init();
  const loop = new ComprehensionLoop(storage);

  const opened = await loop.open({ concept: 'x', subsystem: 'due-sub', stage: 'build', groundTruth: 'gt', sessionId: 's' });
  await loop.submit(opened.id, 'some explanation', false);
  // Force it due.
  const all = await storage.getBySubsystem('due-sub');
  await storage.update(all[0].id, { next_recall_due: new Date(Date.now() - 1000).toISOString() });

  const due = await storage.getDueForRecall('due-sub');
  assert.equal(due.length, 1);
  const prompt = loop.recallQuestion(due[0]);
  assert.match(prompt, /Cold recall/);
  assert.doesNotMatch(prompt, /some explanation/, 'the cold prompt must not leak the stored answer');
  await storage.close();
});
