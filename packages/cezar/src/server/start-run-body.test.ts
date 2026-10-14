import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RunStore } from '../runs/store.ts';
import type { RunManager, StartRunInput } from '../workflows/run.ts';
import type { WorkflowDef } from '../workflows/types.ts';
import { createApp } from './server.ts';
import { apiRequest } from './loopback-request.testkit.ts';
import { connectedProviderAuth } from './provider-auth.testkit.ts';

/**
 * `POST /runs` body validation, pinned input by input (#1109 point 4). The route validates the
 * contract's `createRunInputSchema`; these answers were recorded against the route's former local
 * `startRunSchema` and must not move: status, error text, and what reaches the manager.
 */
describe('POST /api/v1/runs body validation', () => {
  let repoRoot: string;
  let store: RunStore;
  let app: Hono;
  let calls: { workflow: WorkflowDef; input: StartRunInput; variants?: number }[];
  const savedFollowups = process.env.CEZ_FOLLOWUPS;
  const savedDispatch = process.env.CEZ_DISPATCH;

  beforeEach(() => {
    repoRoot = mkdtempSync(join(tmpdir(), 'cez-startrun-body-'));
    mkdirSync(join(repoRoot, '.ai/cezar'), { recursive: true });
    // Variants need a repository with a HEAD (the route's own precondition).
    execFileSync('git', ['init', '-q', repoRoot]);
    execFileSync('git', ['-C', repoRoot, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'init']);
    store = RunStore.open(join(repoRoot, '.ai/cezar'));
    calls = [];
    process.env.CEZ_FOLLOWUPS = '1';
    delete process.env.CEZ_DISPATCH;
    const record = (task: string) =>
      store.createRun({ title: 't', workflow: '(planned)', task, steps: [] });
    const manager = {
      startRun: (workflow: WorkflowDef, input: StartRunInput) => {
        calls.push({ workflow, input });
        return record(input.task);
      },
      startVariants: (workflow: WorkflowDef, input: StartRunInput, variants: number) => {
        calls.push({ workflow, input, variants });
        return Array.from({ length: variants }, () => record(input.task));
      },
    } as unknown as RunManager;
    app = createApp({ repoRoot, store, manager, version: '0.0.0-test', providerAuth: connectedProviderAuth() });
  });

  afterEach(() => {
    store.flush();
    rmSync(repoRoot, { recursive: true, force: true });
    if (savedFollowups === undefined) delete process.env.CEZ_FOLLOWUPS;
    else process.env.CEZ_FOLLOWUPS = savedFollowups;
    if (savedDispatch === undefined) delete process.env.CEZ_DISPATCH;
    else process.env.CEZ_DISPATCH = savedDispatch;
  });

  /** Status, the `{error}` text on a refusal, and on success what the manager was handed. */
  async function outcome(body: unknown) {
    const res = await apiRequest(app, '/api/v1/runs', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    });
    const json = (await res.json()) as { error?: string };
    if (res.status !== 201) return { status: res.status, error: json.error, called: calls.length };
    const call = calls[0];
    if (!call) throw new Error('201 without a manager call');
    const { deviceSid: _sid, images, ...input } = call.input;
    return {
      status: res.status,
      workflow: call.workflow.name === '(planned)' ? call.workflow : call.workflow.name,
      input: { ...input, task: input.task.length > 20 ? `<${input.task.length} chars>` : input.task, images: images?.map((i) => i.type) },
      variants: call.variants,
    };
  }

  const steps = [{ id: 'work', prompt: '{{task}}' }];
  const png = { mediaType: 'image/png', data: Buffer.from('not really a png').toString('base64') };

  const cases: [string, unknown][] = [
    ['valid: inline steps', { task: 'do it', steps }],
    ['valid: named workflow', { task: 'do it', workflow: 'quick-task' }],
    ['valid: every optional key', {
      task: 'do it',
      steps,
      model: 'sonnet',
      runner: 'codex',
      worktree: false,
      autonomous: true,
      generateFollowups: false,
      systemPrompt: '  be brief  ',
      dispatch: { maxSubtasks: 3 },
    }],
    ['valid: whitespace-only systemPrompt degrades to absent', { task: 'do it', steps, systemPrompt: '   ' }],
    ['valid: check step gets onFail.max default', {
      task: 'do it',
      steps: [{ id: 'work', prompt: '{{task}}' }, { id: 'test', command: 'npm test', onFail: { retry: 'work' } }],
    }],
    ['missing task', { steps }],
    ['empty task', { task: '', steps }],
    ['task too long', { task: 'x'.repeat(100_001), steps }],
    ['task at the bound', { task: 'x'.repeat(100_000), steps }],
    ['neither workflow nor steps', { task: 'do it' }],
    ['both workflow and steps', { task: 'do it', workflow: 'quick-task', steps }],
    ['unknown workflow', { task: 'do it', workflow: 'no-such-workflow' }],
    ['empty steps', { task: 'do it', steps: [] }],
    ['nine steps', { task: 'do it', steps: Array.from({ length: 9 }, (_, i) => ({ id: `s${i}`, prompt: 'p' })) }],
    ['step refine: agent and check at once', { task: 'do it', steps: [{ id: 'a', prompt: 'p', command: 'c' }] }],
    ['step refine: neither agent nor check', { task: 'do it', steps: [{ id: 'a' }] }],
    ['step refine: secrets on an agent step', { task: 'do it', steps: [{ id: 'a', prompt: 'p', secrets: ['X'] }] }],
    ['step: legacy claude-cli runner', { task: 'do it', steps: [{ id: 'a', prompt: 'p', runner: 'claude-cli' }] }],
    ['step: retry onto a later step', {
      task: 'do it',
      steps: [{ id: 'test', command: 'npm test', onFail: { retry: 'work' } }, { id: 'work', prompt: 'p' }],
    }],
    ['step: retryOn 0', { task: 'do it', steps: [{ id: 'a', prompt: 'p' }, { id: 't', command: 'c', onFail: { retry: 'a', retryOn: [0] } }] }],
    ['unknown runner', { task: 'do it', steps, runner: 'gpt' }],
    ['variants 2', { task: 'do it', steps, variants: 2 }],
    ['variants 0', { task: 'do it', steps, variants: 0 }],
    ['variants 4', { task: 'do it', steps, variants: 4 }],
    ['variants 1.5', { task: 'do it', steps, variants: 1.5 }],
    ['images: one png', { task: 'do it', steps, images: [png] }],
    ['images: five', { task: 'do it', steps, images: Array.from({ length: 5 }, () => png) }],
    ['images: unsupported type', { task: 'do it', steps, images: [{ mediaType: 'application/zip', data: 'AA==' }] }],
    ['images: empty data', { task: 'do it', steps, images: [{ mediaType: 'image/png', data: '' }] }],
    ['systemPrompt too long', { task: 'do it', steps, systemPrompt: 'x'.repeat(20_001) }],
    ['agentProfile too long', { task: 'do it', steps, agentProfile: 'x'.repeat(65) }],
    ['todoId too long', { task: 'do it', steps, todoId: 'x'.repeat(201) }],
    ['dispatch: unknown key', { task: 'do it', steps, dispatch: { maxSubtask: 3 } }],
    ['unknown top-level fields are stripped', { task: 'do it', steps, totalNonsense: 12345 }],
    ['unknown step fields are stripped', { task: 'do it', steps: [{ id: 'a', prompt: 'p', colour: 'red' }] }],
    ['wrong type: task', { task: 42, steps }],
    ['malformed JSON', '{"task": '],
    ['JSON array body', '[]'],
  ];

  it('answers every case as it did before the route moved onto the contract schema', async () => {
    const answers: Record<string, unknown> = {};
    for (const [name, body] of cases) {
      calls = [];
      answers[name] = await outcome(body);
    }
    expect(answers).toMatchInlineSnapshot(`
      {
        "JSON array body": {
          "called": 0,
          "error": "Invalid input: expected object, received array",
          "status": 400,
        },
        "agentProfile too long": {
          "called": 0,
          "error": "agentProfile: Too big: expected string to have <=64 characters",
          "status": 400,
        },
        "both workflow and steps": {
          "called": 0,
          "error": "provide either "workflow" or "steps", not both",
          "status": 400,
        },
        "dispatch: unknown key": {
          "called": 0,
          "error": "dispatch: Unrecognized key: "maxSubtask"",
          "status": 400,
        },
        "empty steps": {
          "called": 0,
          "error": "steps: Too small: expected array to have >=1 items",
          "status": 400,
        },
        "empty task": {
          "called": 0,
          "error": "task: Too small: expected string to have >=1 characters",
          "status": 400,
        },
        "images: empty data": {
          "called": 0,
          "error": "images.0.data: Too small: expected string to have >=1 characters",
          "status": 400,
        },
        "images: five": {
          "called": 0,
          "error": "images: Too big: expected array to have <=4 items",
          "status": 400,
        },
        "images: one png": {
          "input": {
            "agentProfile": undefined,
            "autonomous": undefined,
            "generateFollowups": undefined,
            "images": [
              "image",
            ],
            "model": undefined,
            "runner": undefined,
            "systemPrompt": undefined,
            "task": "do it",
            "worktree": undefined,
          },
          "status": 201,
          "variants": undefined,
          "workflow": {
            "name": "(planned)",
            "source": "built-in",
            "steps": [
              {
                "id": "work",
                "prompt": "{{task}}",
              },
            ],
          },
        },
        "images: unsupported type": {
          "called": 0,
          "error": "images.0.mediaType: unsupported attachment type — images, plain text, markdown and PDF only",
          "status": 400,
        },
        "malformed JSON": {
          "called": 0,
          "error": "Invalid input: expected object, received null",
          "status": 400,
        },
        "missing task": {
          "called": 0,
          "error": "task: Invalid input: expected string, received undefined",
          "status": 400,
        },
        "neither workflow nor steps": {
          "called": 0,
          "error": "provide either "workflow" or "steps", not both",
          "status": 400,
        },
        "nine steps": {
          "called": 0,
          "error": "steps: Too big: expected array to have <=8 items",
          "status": 400,
        },
        "step refine: agent and check at once": {
          "called": 0,
          "error": "steps.0: a step is either an agent step (prompt/skill) or a check step (command), not both",
          "status": 400,
        },
        "step refine: neither agent nor check": {
          "called": 0,
          "error": "steps.0: a step is either an agent step (prompt/skill) or a check step (command), not both",
          "status": 400,
        },
        "step refine: secrets on an agent step": {
          "called": 0,
          "error": "steps.0: secrets: is for check steps only — an agent step never receives a secret",
          "status": 400,
        },
        "step: legacy claude-cli runner": {
          "called": 0,
          "error": "steps.0.runner: Invalid option: expected one of "claude"|"codex"|"opencode"|"cursor"|"pi"|"junie"|"copilot"",
          "status": 400,
        },
        "step: retry onto a later step": {
          "called": 0,
          "error": "step "test": onFail.retry must reference an earlier step (got "work")",
          "status": 400,
        },
        "step: retryOn 0": {
          "called": 0,
          "error": "steps.1.onFail.retryOn.0: Too small: expected number to be >0",
          "status": 400,
        },
        "systemPrompt too long": {
          "called": 0,
          "error": "systemPrompt: must be at most 20000 characters",
          "status": 400,
        },
        "task at the bound": {
          "input": {
            "agentProfile": undefined,
            "autonomous": undefined,
            "generateFollowups": undefined,
            "images": undefined,
            "model": undefined,
            "runner": undefined,
            "systemPrompt": undefined,
            "task": "<100000 chars>",
            "worktree": undefined,
          },
          "status": 201,
          "variants": undefined,
          "workflow": {
            "name": "(planned)",
            "source": "built-in",
            "steps": [
              {
                "id": "work",
                "prompt": "{{task}}",
              },
            ],
          },
        },
        "task too long": {
          "called": 0,
          "error": "task: must be at most 100000 characters",
          "status": 400,
        },
        "todoId too long": {
          "called": 0,
          "error": "todoId: must be at most 200 characters",
          "status": 400,
        },
        "unknown runner": {
          "called": 0,
          "error": "runner: Invalid option: expected one of "claude"|"codex"|"opencode"|"cursor"|"pi"|"junie"|"copilot"",
          "status": 400,
        },
        "unknown step fields are stripped": {
          "input": {
            "agentProfile": undefined,
            "autonomous": undefined,
            "generateFollowups": undefined,
            "images": undefined,
            "model": undefined,
            "runner": undefined,
            "systemPrompt": undefined,
            "task": "do it",
            "worktree": undefined,
          },
          "status": 201,
          "variants": undefined,
          "workflow": {
            "name": "(planned)",
            "source": "built-in",
            "steps": [
              {
                "id": "a",
                "prompt": "p",
              },
            ],
          },
        },
        "unknown top-level fields are stripped": {
          "input": {
            "agentProfile": undefined,
            "autonomous": undefined,
            "generateFollowups": undefined,
            "images": undefined,
            "model": undefined,
            "runner": undefined,
            "systemPrompt": undefined,
            "task": "do it",
            "worktree": undefined,
          },
          "status": 201,
          "variants": undefined,
          "workflow": {
            "name": "(planned)",
            "source": "built-in",
            "steps": [
              {
                "id": "work",
                "prompt": "{{task}}",
              },
            ],
          },
        },
        "unknown workflow": {
          "called": 0,
          "error": "unknown workflow: no-such-workflow",
          "status": 404,
        },
        "valid: check step gets onFail.max default": {
          "input": {
            "agentProfile": undefined,
            "autonomous": undefined,
            "generateFollowups": undefined,
            "images": undefined,
            "model": undefined,
            "runner": undefined,
            "systemPrompt": undefined,
            "task": "do it",
            "worktree": undefined,
          },
          "status": 201,
          "variants": undefined,
          "workflow": {
            "name": "(planned)",
            "source": "built-in",
            "steps": [
              {
                "id": "work",
                "prompt": "{{task}}",
              },
              {
                "command": "npm test",
                "id": "test",
                "onFail": {
                  "max": 2,
                  "retry": "work",
                },
              },
            ],
          },
        },
        "valid: every optional key": {
          "input": {
            "agentProfile": undefined,
            "autonomous": true,
            "dispatchIntent": {
              "maxSubtasks": 3,
            },
            "generateFollowups": false,
            "images": undefined,
            "model": "sonnet",
            "runner": "codex",
            "systemPrompt": "be brief",
            "task": "do it",
            "worktree": false,
          },
          "status": 201,
          "variants": undefined,
          "workflow": {
            "name": "(planned)",
            "source": "built-in",
            "steps": [
              {
                "id": "work",
                "prompt": "{{task}}",
              },
            ],
          },
        },
        "valid: inline steps": {
          "input": {
            "agentProfile": undefined,
            "autonomous": undefined,
            "generateFollowups": undefined,
            "images": undefined,
            "model": undefined,
            "runner": undefined,
            "systemPrompt": undefined,
            "task": "do it",
            "worktree": undefined,
          },
          "status": 201,
          "variants": undefined,
          "workflow": {
            "name": "(planned)",
            "source": "built-in",
            "steps": [
              {
                "id": "work",
                "prompt": "{{task}}",
              },
            ],
          },
        },
        "valid: named workflow": {
          "input": {
            "agentProfile": undefined,
            "autonomous": undefined,
            "generateFollowups": undefined,
            "images": undefined,
            "model": undefined,
            "runner": undefined,
            "systemPrompt": undefined,
            "task": "do it",
            "worktree": undefined,
          },
          "status": 201,
          "variants": undefined,
          "workflow": "quick-task",
        },
        "valid: whitespace-only systemPrompt degrades to absent": {
          "input": {
            "agentProfile": undefined,
            "autonomous": undefined,
            "generateFollowups": undefined,
            "images": undefined,
            "model": undefined,
            "runner": undefined,
            "systemPrompt": undefined,
            "task": "do it",
            "worktree": undefined,
          },
          "status": 201,
          "variants": undefined,
          "workflow": {
            "name": "(planned)",
            "source": "built-in",
            "steps": [
              {
                "id": "work",
                "prompt": "{{task}}",
              },
            ],
          },
        },
        "variants 0": {
          "called": 0,
          "error": "variants: Too small: expected number to be >=1",
          "status": 400,
        },
        "variants 1.5": {
          "called": 0,
          "error": "variants: Invalid input: expected int, received number",
          "status": 400,
        },
        "variants 2": {
          "input": {
            "agentProfile": undefined,
            "autonomous": undefined,
            "generateFollowups": undefined,
            "images": undefined,
            "model": undefined,
            "runner": undefined,
            "systemPrompt": undefined,
            "task": "do it",
            "worktree": undefined,
          },
          "status": 201,
          "variants": 2,
          "workflow": {
            "name": "(planned)",
            "source": "built-in",
            "steps": [
              {
                "id": "work",
                "prompt": "{{task}}",
              },
            ],
          },
        },
        "variants 4": {
          "called": 0,
          "error": "variants: Too big: expected number to be <=3",
          "status": 400,
        },
        "wrong type: task": {
          "called": 0,
          "error": "task: Invalid input: expected string, received number",
          "status": 400,
        },
      }
    `);
  });
});
