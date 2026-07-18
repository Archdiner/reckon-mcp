#!/usr/bin/env node
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { Storage } from './storage.js';
import { Classifier } from './classifier.js';
import { ComprehensionLoop } from './loop.js';
import crypto from 'crypto';

const storage = new Storage();
const classifier = new Classifier();
const loop = new ComprehensionLoop(storage);

let currentSessionId = crypto.randomUUID();

// How Claude decides when to reach for these tools. Trigger keywords first.
const INSTRUCTIONS = [
  'Reckon makes sure you actually UNDERSTAND what your coding agent builds — Feynman',
  'technique, enforced. It does not interrupt you to commit positions; it asks you to',
  'EXPLAIN, then an isolated grader checks the explanation against the real artifact.',
  '',
  'CALL reckon_explain at a plan-worthy or build-worthy moment: before building something',
  'non-trivial (stage="plan", to catch "should we build this at all"), or after a',
  'significant change shipped (stage="build"). Pass the plan/diff as ground_truth. Put the',
  'returned prompt to the user; take their explanation and call reckon_grade. On a fail,',
  'relay the retry prompt and let them re-explain (they may open the source — pass',
  'assisted=true). Medium rigor is the floor; harsh is opt-in.',
  '',
  'At the start of work in a subsystem, call reckon_recall_due — past explanations come',
  'back COLD for a retention check (that is where the learning compounds).',
].join('\n');

const server = new Server(
  { name: 'reckon-mcp', version: '0.5.0' },
  { capabilities: { tools: {} }, instructions: INSTRUCTIONS }
);

function addedLines(diff: string): string {
  return diff
    .split('\n')
    .filter((l) => l.startsWith('+') && !l.startsWith('+++'))
    .map((l) => l.slice(1))
    .join('\n')
    .trim();
}

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'reckon_explain',
      _meta: { 'anthropic/alwaysLoad': true, 'anthropic/requiresUserInteraction': true },
      description:
        'Open a comprehension checkpoint: ask the user to EXPLAIN (mechanism, not procedure) ' +
        'what the agent planned or built, so an isolated grader can verify they understand it. ' +
        'Use before building something non-trivial (stage="plan") or after a significant change ' +
        '(stage="build"). Pass the plan or diff as ground_truth. Returns a prompt to put to the user.',
      inputSchema: {
        type: 'object',
        properties: {
          concept: { type: 'string', description: 'Short slug for what is being explained' },
          subsystem: { type: 'string', description: 'The area/subsystem it lives in' },
          stage: { type: 'string', enum: ['plan', 'build'], description: 'plan = before building; build = after a change' },
          ground_truth: { type: 'string', description: 'The plan or the diff — the reference the explanation is graded against' },
          rigor: { type: 'string', enum: ['medium', 'harsh'], description: 'medium (floor, default) | harsh (opt-in, stricter)' },
          gate_key: {
            type: 'string',
            description:
              'The opaque clearance key from a Reckon gate DENY message (Mode A). Pass it back EXACTLY. ' +
              'On a PASS the gate clears and the blocked write/plan may proceed. Omit for a proactive, ' +
              'non-gated checkpoint.',
          },
        },
        required: ['concept', 'subsystem', 'stage', 'ground_truth'],
      },
    },
    {
      name: 'reckon_grade',
      _meta: { 'anthropic/alwaysLoad': true },
      description:
        "Submit the user's explanation for grading by the isolated grader. Returns pass + feedback, " +
        'or a single re-explanation prompt to relay if they missed the mechanism. Set assisted=true if ' +
        'they opened the source to answer (it will be re-checked cold, sooner).',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          explanation: { type: 'string', description: "The user's explanation, in their own words" },
          assisted: { type: 'boolean', description: 'True if the user consulted the source/doc to answer' },
        },
        required: ['id', 'explanation'],
      },
    },
    {
      name: 'reckon_recall_due',
      _meta: { 'anthropic/alwaysLoad': true },
      description: 'List past explanations due for a COLD recall check (metadata only — do not surface the stored explanation).',
      inputSchema: { type: 'object', properties: { subsystem: { type: 'string' } } },
    },
    {
      name: 'reckon_recall_answer',
      description: "Submit the user's cold-recall answer for a due item; grades against stored ground truth and reschedules.",
      inputSchema: {
        type: 'object',
        properties: { id: { type: 'string' }, answer: { type: 'string' } },
        required: ['id', 'answer'],
      },
    },
    {
      name: 'classify',
      description: 'Classify whether a diff is explanation-worthy (deserves a comprehension checkpoint).',
      inputSchema: {
        type: 'object',
        properties: { diff: { type: 'string' }, context: { type: 'string' }, filePath: { type: 'string' } },
        required: ['diff', 'filePath'],
      },
    },
    {
      name: 'get_log',
      description: 'Read the explanation log (optionally scoped to a subsystem).',
      inputSchema: { type: 'object', properties: { subsystem: { type: 'string' }, limit: { type: 'number' } } },
    },
    {
      name: 'set_session',
      description: 'Set or create a new session ID.',
      inputSchema: { type: 'object', properties: { sessionId: { type: 'string' } } },
    },
  ],
}));

function text(obj: unknown) {
  return { content: [{ type: 'text', text: JSON.stringify(obj, null, 2) }] };
}

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  try {
    switch (name) {
      case 'reckon_explain': {
        const { concept, subsystem, stage, ground_truth, rigor, gate_key } = args as any;
        // Enforce required fields (adversarial finding F1: MCP does not validate
        // `required`, and a missing ground_truth silently guts the reference-guided grade).
        const missing = ['concept', 'subsystem', 'stage', 'ground_truth'].filter(
          (k) => typeof (args as any)?.[k] !== 'string' || !(args as any)[k].trim()
        );
        if (missing.length) throw new Error(`reckon_explain missing required field(s): ${missing.join(', ')}`);
        if (stage !== 'plan' && stage !== 'build') throw new Error(`stage must be "plan" or "build", got: ${stage}`);
        const gt = ground_truth.includes('\n+') || ground_truth.startsWith('+') ? addedLines(ground_truth) || ground_truth : ground_truth;
        const r = await loop.open({
          concept,
          subsystem,
          stage,
          groundTruth: gt,
          rigor,
          sessionId: currentSessionId,
          gateKey: typeof gate_key === 'string' && gate_key.trim() ? gate_key.trim() : undefined,
        });
        return text(r);
      }
      case 'reckon_grade': {
        const { id, explanation, assisted = false } = args as any;
        const r = await loop.submit(id, explanation, assisted);
        if (!r) throw new Error('Invalid or expired checkpoint ID');
        return text(r);
      }
      case 'reckon_recall_due': {
        const { subsystem } = args as any;
        const due = await storage.getDueForRecall(subsystem);
        // Metadata only — never leak the stored explanation/ground_truth into the cold check.
        return text(
          due.map((d) => ({ id: d.id, subsystem: d.subsystem, concept: d.concept, prompt: loop.recallQuestion(d) }))
        );
      }
      case 'reckon_recall_answer': {
        const { id, answer } = args as any;
        const r = await loop.recallAnswer(id, answer);
        if (!r) throw new Error('Unknown recall item ID');
        return text(r);
      }
      case 'classify': {
        const { diff, context = '', filePath } = args as any;
        return text(classifier.classify(diff, context, filePath));
      }
      case 'get_log': {
        const { subsystem, limit = 50 } = args as any;
        const rows = subsystem ? await storage.getBySubsystem(subsystem) : await storage.getAll();
        return text(rows.slice(0, limit));
      }
      case 'set_session': {
        const { sessionId } = args as any;
        currentSessionId = sessionId || crypto.randomUUID();
        return text({ sessionId: currentSessionId });
      }
      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  } catch (error: any) {
    return { content: [{ type: 'text', text: `Error: ${error.message}` }], isError: true };
  }
});

async function main() {
  await storage.init();
  console.error('Reckon MCP Server v0.5.0 (comprehension loop) starting...');
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('Server running on stdio');
  process.on('SIGINT', async () => {
    await storage.close();
    process.exit(0);
  });
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
