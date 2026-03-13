/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { CommandContext } from '../lib/hydra-operator-commands.ts';
import * as mod from '../lib/hydra-operator-commands.ts';

function makeCtx(overrides: Partial<CommandContext> = {}): CommandContext {
  return {
    baseUrl: 'http://127.0.0.1:14173',
    agents: ['claude', 'gemini', 'codex'],
    config: {
      projectRoot: '/tmp/hydra-test',
      projectName: 'test',
      coordDir: '/tmp/hydra-test/.hydra',
      statePath: '/tmp/hydra-test/.hydra/state.json',
      logPath: '/tmp/hydra-test/.hydra/log.jsonl',
      statusPath: '/tmp/hydra-test/.hydra/status.json',
      eventsPath: '/tmp/hydra-test/.hydra/events.json',
      archivePath: '/tmp/hydra-test/.hydra/archive',
      runsDir: '/tmp/hydra-test/.hydra/runs',
      hydraRoot: '/home/mikecubed/projects/Hydra',
    },
    rl: {
      prompt: () => {},
      pause: () => {},
      resume: () => {},
      setPrompt: () => {},
      close: () => {},
    } as any,
    HYDRA_ROOT: '/home/mikecubed/projects/Hydra',
    getLoopMode: () => 'auto',
    setLoopMode: () => {},
    initStatusBar: () => {},
    destroyStatusBar: () => {},
    drawStatusBar: () => {},
    ...overrides,
  };
}

function captureLog(fn: () => Promise<void>): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const logs: string[] = [];
    const origLog = console.log;
    console.log = (...args: unknown[]) => {
      logs.push(args.join(' '));
    };
    fn()
      .then(() => {
        console.log = origLog;
        resolve(logs);
      })
      .catch((err: unknown) => {
        console.log = origLog;
        reject(err instanceof Error ? err : new Error(String(err)));
      });
  });
}

describe('hydra-operator-commands', () => {
  describe('handleModelCommand', () => {
    it('no args → prints model summary and calls rl.prompt', async () => {
      let prompted = false;
      const ctx = makeCtx({
        rl: {
          prompt: () => {
            prompted = true;
          },
          pause: () => {},
          resume: () => {},
          setPrompt: () => {},
          close: () => {},
        } as any,
      });
      const logs = await captureLog(() => mod.handleModelCommand(ctx, ''));
      assert.ok(prompted, 'rl.prompt should be called');
      assert.ok(
        logs.some((l) => l.includes('Mode:')),
        'Should print Mode:',
      );
    });

    it('reset → prints success message and calls rl.prompt', async () => {
      let prompted = false;
      const ctx = makeCtx({
        rl: {
          prompt: () => {
            prompted = true;
          },
          pause: () => {},
          resume: () => {},
          setPrompt: () => {},
          close: () => {},
        } as any,
      });
      const logs = await captureLog(() => mod.handleModelCommand(ctx, 'reset'));
      assert.ok(prompted, 'rl.prompt should be called');
      assert.ok(
        logs.some((l) => l.includes('overrides cleared') || l.includes('cleared')),
        'Should print cleared message',
      );
    });

    it('unknown key=val → prints Unknown key error', async () => {
      const ctx = makeCtx();
      const logs = await captureLog(() => mod.handleModelCommand(ctx, 'unknownxyz=somevalue'));
      assert.ok(
        logs.some((l) => l.includes('Unknown key')),
        'Should print Unknown key',
      );
    });

    it('mode=economy → does not throw', async () => {
      const ctx = makeCtx();
      await assert.doesNotReject(() => mod.handleModelCommand(ctx, 'mode=economy'));
    });
  });

  describe('handleRolesCommand', () => {
    it('calls rl.prompt', async () => {
      let prompted = false;
      const ctx = makeCtx({
        rl: {
          prompt: () => {
            prompted = true;
          },
          pause: () => {},
          resume: () => {},
          setPrompt: () => {},
          close: () => {},
        } as any,
      });
      await captureLog(() => mod.handleRolesCommand(ctx));
      assert.ok(prompted, 'rl.prompt should be called');
    });
  });

  describe('handleModeCommand', () => {
    it('empty string → shows current mode and calls rl.prompt', async () => {
      let prompted = false;
      const ctx = makeCtx({
        rl: {
          prompt: () => {
            prompted = true;
          },
          pause: () => {},
          resume: () => {},
          setPrompt: () => {},
          close: () => {},
        } as any,
      });
      const logs = await captureLog(() => mod.handleModeCommand(ctx, ''));
      assert.ok(prompted, 'rl.prompt should be called');
      assert.ok(
        logs.some((l) => l.includes('Mode') || l.includes('mode')),
        'Should print mode info',
      );
    });

    it('auto → calls setLoopMode with auto', async () => {
      let newMode = '';
      const ctx = makeCtx({
        setLoopMode: (m) => {
          newMode = m;
        },
      });
      await captureLog(() => mod.handleModeCommand(ctx, 'auto'));
      assert.equal(newMode, 'auto', 'setLoopMode should be called with auto');
    });

    it('invalid → prints Invalid mode error', async () => {
      const ctx = makeCtx();
      const logs = await captureLog(() => mod.handleModeCommand(ctx, 'invalid'));
      assert.ok(
        logs.some((l) => l.includes('Invalid mode')),
        'Should print Invalid mode',
      );
    });
  });

  describe('handleAgentsCommand', () => {
    it('empty string → shows agent registry and calls rl.prompt', async () => {
      let prompted = false;
      const ctx = makeCtx({
        rl: {
          prompt: () => {
            prompted = true;
          },
          pause: () => {},
          resume: () => {},
          setPrompt: () => {},
          close: () => {},
        } as any,
      });
      const logs = await captureLog(() => mod.handleAgentsCommand(ctx, ''));
      assert.ok(prompted, 'rl.prompt should be called');
      assert.ok(
        logs.some((l) => l.includes('Agent') || l.includes('agent')),
        'Should list agents',
      );
    });

    it('info with no name → shows Usage error', async () => {
      const ctx = makeCtx();
      const logs = await captureLog(() => mod.handleAgentsCommand(ctx, 'info'));
      assert.ok(
        logs.some((l) => l.includes('Usage')),
        'Should show Usage error',
      );
    });

    it('enable with no name → shows Usage error', async () => {
      const ctx = makeCtx();
      const logs = await captureLog(() => mod.handleAgentsCommand(ctx, 'enable'));
      assert.ok(
        logs.some((l) => l.includes('Usage')),
        'Should show Usage error',
      );
    });

    it('disable with no name → shows Usage error', async () => {
      const ctx = makeCtx();
      const logs = await captureLog(() => mod.handleAgentsCommand(ctx, 'disable'));
      assert.ok(
        logs.some((l) => l.includes('Usage')),
        'Should show Usage error',
      );
    });

    it('remove with no name → shows Usage error', async () => {
      const ctx = makeCtx();
      const logs = await captureLog(() => mod.handleAgentsCommand(ctx, 'remove'));
      assert.ok(
        logs.some((l) => l.includes('Usage')),
        'Should show Usage error',
      );
    });

    it('test with no name → shows Usage error', async () => {
      const ctx = makeCtx();
      const logs = await captureLog(() => mod.handleAgentsCommand(ctx, 'test'));
      assert.ok(
        logs.some((l) => l.includes('Usage')),
        'Should show Usage error',
      );
    });

    it('unknownsub → shows Unknown subcommand error', async () => {
      const ctx = makeCtx();
      const logs = await captureLog(() => mod.handleAgentsCommand(ctx, 'unknownsub'));
      assert.ok(
        logs.some((l) => l.includes('Unknown subcommand')),
        'Should show Unknown subcommand',
      );
    });
  });

  describe('handlePrCommand', () => {
    it('empty string → shows gh not found OR usage error', async () => {
      const ctx = makeCtx();
      const logs = await captureLog(() => mod.handlePrCommand(ctx, ''));
      // Either gh not available message or usage
      assert.ok(
        logs.some(
          (l) =>
            l.includes('gh') ||
            l.includes('Usage') ||
            l.includes('usage') ||
            l.includes('create') ||
            l.includes('list'),
        ),
        'Should show gh or usage message',
      );
    });
  });

  describe('handleTasksCommand', () => {
    it('empty string → calls rl.prompt (daemon error or empty list)', async () => {
      let prompted = false;
      const ctx = makeCtx({
        rl: {
          prompt: () => {
            prompted = true;
          },
          pause: () => {},
          resume: () => {},
          setPrompt: () => {},
          close: () => {},
        } as any,
      });
      await captureLog(() => mod.handleTasksCommand(ctx, ''));
      assert.ok(prompted, 'rl.prompt should be called');
    });
  });

  describe('handleEvolveCommand', () => {
    it('status → spawns subprocess without throwing', async () => {
      const ctx = makeCtx();
      // This spawns a child process; we just verify no sync throw
      let threw = false;
      try {
        await captureLog(() => mod.handleEvolveCommand(ctx, 'status'));
      } catch {
        threw = true;
      }
      assert.ok(!threw, 'handleEvolveCommand(status) should not throw');
    });
  });

  describe('handleNightlyCommand', () => {
    it('status → spawns subprocess without throwing', async () => {
      const ctx = makeCtx();
      let threw = false;
      try {
        await captureLog(() => mod.handleNightlyCommand(ctx, 'status'));
      } catch {
        threw = true;
      }
      assert.ok(!threw, 'handleNightlyCommand(status) should not throw');
    });
  });

  describe('handleModelSelectCommand', () => {
    it('is exported and is a function', () => {
      assert.equal(typeof mod.handleModelSelectCommand, 'function');
    });
  });

  describe('handleCleanupCommand', () => {
    it('is exported and is a function', () => {
      assert.equal(typeof mod.handleCleanupCommand, 'function');
    });
  });

  describe('CommandContext', () => {
    it('makeCtx produces valid context shape', () => {
      const ctx = makeCtx();
      assert.equal(typeof ctx.baseUrl, 'string');
      assert.ok(Array.isArray(ctx.agents));
      assert.equal(typeof ctx.getLoopMode, 'function');
      assert.equal(typeof ctx.setLoopMode, 'function');
      assert.equal(typeof ctx.rl.prompt, 'function');
    });
  });
});
