import { describe, expect, it } from 'vitest';
import type { z } from 'zod';
import { runnerSchema, workflowStepDefSchema } from '@open-mercato/cezar-contract';
import { RUNNER_IDS } from '../core/agent-runner.ts';
import { workflowStepSchema } from './types.ts';

/**
 * The step schema exists twice on purpose: `workflowStepSchema` validates workflow YAML and the
 * persisted `workflowDef`, while the contract's `workflowStepDefSchema` validates `POST /runs`'
 * inline `steps` (#1109) and the catalog the routes serve. They stay separate, so this keeps them
 * equivalent — same verdict, same parsed value, same issues — or `POST /runs` accepts a chain the
 * runner then refuses, or the reverse.
 */
describe('workflowStepSchema ≡ workflowStepDefSchema', () => {
  type Mutual<A, B> = [A] extends [B] ? ([B] extends [A] ? true : 'server-is-wider') : 'contract-is-wider';
  type Assert<T extends true> = T;
  type _Checks = [
    Assert<Mutual<z.input<typeof workflowStepSchema>, z.input<typeof workflowStepDefSchema>>>,
    Assert<Mutual<z.output<typeof workflowStepSchema>, z.output<typeof workflowStepDefSchema>>>,
  ];

  it('offers the same runners', () => {
    expect(runnerSchema.options).toEqual([...RUNNER_IDS]);
  });

  const corpus: [string, unknown][] = [
    ['agent step', { id: 'work', prompt: '{{task}}' }],
    ['skill step', { id: 'review', skill: 'om-code-review', model: 'opus', runner: 'codex' }],
    ['every agent key', { id: 'a', name: 'A', prompt: 'p', skill: 's', model: 'm', runner: 'claude', allowedTools: ['Read'], bashAllowlist: ['npm test'] }],
    ['check step', { id: 'test', command: 'npm test' }],
    ['check with onFail, default max', { id: 't', command: 'c', onFail: { retry: 'work' } }],
    ['check with onFail, every key', { id: 't', command: 'c', onFail: { retry: 'work', max: 5, retryOn: [1, 3] } }],
    ['check with secrets', { id: 't', command: 'c', secrets: ['API_KEY', { name: 'TOKEN', as: 'GH_TOKEN' }] }],
    ['unknown keys', { id: 'a', prompt: 'p', colour: 'red', onFail: undefined }],
    ['empty id', { id: '', prompt: 'p' }],
    ['missing id', { prompt: 'p' }],
    ['agent and check', { id: 'a', prompt: 'p', command: 'c' }],
    ['skill and check', { id: 'a', skill: 's', command: 'c' }],
    ['neither', { id: 'a' }],
    ['empty prompt is no prompt', { id: 'a', prompt: '', command: 'c' }],
    ['secrets on an agent step', { id: 'a', prompt: 'p', secrets: ['X'] }],
    ['empty secrets', { id: 't', command: 'c', secrets: [] }],
    ['secret with an extra key', { id: 't', command: 'c', secrets: [{ name: 'X', alias: 'Y' }] }],
    ['legacy claude-cli runner', { id: 'a', prompt: 'p', runner: 'claude-cli' }],
    ['unknown runner', { id: 'a', prompt: 'p', runner: 'gpt' }],
    ['onFail without retry', { id: 't', command: 'c', onFail: { max: 2 } }],
    ['onFail max 0', { id: 't', command: 'c', onFail: { retry: 'a', max: 0 } }],
    ['onFail max 1.5', { id: 't', command: 'c', onFail: { retry: 'a', max: 1.5 } }],
    ['retryOn 0', { id: 't', command: 'c', onFail: { retry: 'a', retryOn: [0] } }],
    ['retryOn empty', { id: 't', command: 'c', onFail: { retry: 'a', retryOn: [] } }],
    ['allowedTools not an array', { id: 'a', prompt: 'p', allowedTools: 'Read' }],
    ['wrong types', { id: 1, prompt: 2, command: false }],
    ['null', null],
    ['array', []],
    ['string', 'step'],
  ];

  /** What a caller can observe: the verdict, the parsed value, and each issue's path and text. */
  const observe = (schema: z.ZodType, input: unknown) => {
    const result = schema.safeParse(input);
    return result.success
      ? { success: true, data: result.data }
      : { success: false, issues: result.error.issues.map((i) => ({ path: i.path, message: i.message })) };
  };

  it.each(corpus)('%s', (_name, input) => {
    expect(observe(workflowStepDefSchema, input)).toEqual(observe(workflowStepSchema, input));
  });

  it('the corpus covers both verdicts', () => {
    const verdicts = new Set(corpus.map(([, input]) => workflowStepSchema.safeParse(input).success));
    expect(verdicts).toEqual(new Set([true, false]));
  });
});
