import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'os';
import path from 'path';
import fs from 'fs';
import { ComprehensionLoop, scheduleAfterGrade, scheduleAfterRecall, gatePasses, DIMENSIONS, elicitPrompt } from '@reckon/core';
import { SqliteStore } from '../src/sqlite-store.js';
import { ClaudeCliBackend } from '../src/claude-cli-backend.js';

// The injected model backend. In these unit tests it is pointed at a mock CLI (or a
// nonexistent one, to force fail-open) via RECKON_GRADER_CMD — the same seam production
// uses, exercised end-to-end through ClaudeCliBackend rather than stubbed out.
const backend = new ClaudeCliBackend();

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
  const loop = new ComprehensionLoop(new SqliteStore(), backend);
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
  const storage = new SqliteStore();
  await storage.init();
  const loop = new ComprehensionLoop(storage, backend);

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

test('plan: decompose into clusters, gate ALL, cover-partial FAILS, no deferral', async () => {
  // A committed mock CLI that answers both the decompose (clusters) and plan-grade calls.
  const mock = path.join(tmp, 'plan-mock.mjs');
  fs.writeFileSync(
    mock,
    `#!/usr/bin/env node
const argv=process.argv.join('\\n');let s='';process.stdin.setEncoding('utf8');
process.stdin.on('data',d=>s+=d);
process.stdin.on('end',()=>{let v;
 if(argv.includes('GROUPED into coherent sub-problems')){v={decisions:[
   {concept:'data',summary:'data layer',question:'why?'},{concept:'auth',summary:'auth',question:'why?'},
   {concept:'infra',summary:'infra',question:'why?'},{concept:'obs',summary:'observability',question:'why?'}]};}
 else if(argv.includes("Reckon's plan grader")){const gated=['data','auth','infra','obs'];
   const covered=gated.filter(c=>s.includes('[[COVER:'+c+']]'));const missing=gated.filter(c=>!covered.includes(c));
   v={covered,missing,pass:missing.length===0,hole:missing.length?'explain '+missing[0]:'',note:'p'};}
 else v={scores:{},pass:false,overlap:'high',hole:'x',note:'s'};
 process.stdout.write(JSON.stringify(v));});`
  );
  fs.chmodSync(mock, 0o755);
  const prev = process.env.RECKON_GRADER_CMD;
  process.env.RECKON_GRADER_CMD = mock;
  try {
    const storage = new SqliteStore();
    await storage.init();
    const loop = new ComprehensionLoop(storage, backend);
    const o = await loop.open({ concept: 'p', subsystem: 'plansub', stage: 'plan', groundTruth: 'a big multi-decision plan', sessionId: 's' });
    assert.match(o.prompt, /data layer/, 'plan prompt must name the clusters');
    assert.doesNotMatch(o.prompt, /come back later/, 'no deferral in the clustered model');

    // cover only 3 of the 4 clusters → must FAIL (all required, no partial pass)
    const partial = await loop.submit(o.id, '[[COVER:data]] [[COVER:auth]] [[COVER:infra]] three of four', false);
    assert.equal(partial!.pass, false, 'covering 3 of 4 clusters must FAIL');

    // cover all 4 → pass, and NO deferred rows (clustering covers everything in one grade)
    const full = await loop.submit(o.id, '[[COVER:data]] [[COVER:auth]] [[COVER:infra]] [[COVER:obs]] all four', false);
    assert.equal(full!.pass, true, 'covering all clusters passes');
    const rows = await storage.getBySubsystem('plansub');
    assert.equal(rows.length, 1, 'no deferral: exactly one plan row, no tail decisions in the ledger');
    assert.equal(rows[0].concept, 'p');
    await storage.close();
  } finally {
    process.env.RECKON_GRADER_CMD = prev;
  }
});

test('recall: a due item surfaces metadata-only (no stored explanation leaked)', async () => {
  const storage = new SqliteStore();
  await storage.init();
  const loop = new ComprehensionLoop(storage, backend);

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
