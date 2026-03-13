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

    it('mode=economy → logs success message with Mode arrow economy', async () => {
      const ctx = makeCtx();
      const logs = await captureLog(() => mod.handleModelCommand(ctx, 'mode=economy'));
      assert.ok(
        logs.some((l) => l.includes('Mode') && l.includes('economy')),
        `Should log Mode → economy confirmation, got: ${JSON.stringify(logs)}`,
      );
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

    it('economy → sets routing mode in config and logs Mode set to chip', async () => {
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
      const logs = await captureLog(() => mod.handleModeCommand(ctx, 'economy'));
      assert.ok(prompted, 'rl.prompt should be called');
      assert.ok(
        logs.some((l) => l.includes('Mode set to') || l.includes('ECO')),
        `Should print routing mode confirmation, got: ${JSON.stringify(logs)}`,
      );
    });

    it('performance → logs Mode set to chip with PERF', async () => {
      const ctx = makeCtx();
      const logs = await captureLog(() => mod.handleModeCommand(ctx, 'performance'));
      assert.ok(
        logs.some((l) => l.includes('Mode set to') || l.includes('PERF')),
        `Should print PERF chip, got: ${JSON.stringify(logs)}`,
      );
    });

    it('balanced → logs Mode set to chip', async () => {
      const ctx = makeCtx();
      const logs = await captureLog(() => mod.handleModeCommand(ctx, 'balanced'));
      assert.ok(
        logs.some((l) => l.includes('Mode set to') || l.includes('BAL')),
        `Should print BAL chip, got: ${JSON.stringify(logs)}`,
      );
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
    it('calls destroyStatusBar, initStatusBar, and rl.prompt', async () => {
      let destroyed = false;
      let inited = false;
      let prompted = false;
      const ctx = makeCtx({
        // Non-existent HYDRA_ROOT so spawnHydraNodeSync exits immediately (ENOENT)
        HYDRA_ROOT: '/tmp/hydra-nonexistent-root',
        rl: {
          prompt: () => {
            prompted = true;
          },
          pause: () => {},
          resume: () => {},
          setPrompt: () => {},
          close: () => {},
        } as any,
        destroyStatusBar: () => {
          destroyed = true;
        },
        initStatusBar: () => {
          inited = true;
        },
      });
      await captureLog(() => mod.handleModelSelectCommand(ctx, ''));
      assert.ok(destroyed, 'destroyStatusBar should be called');
      assert.ok(inited, 'initStatusBar should be called');
      assert.ok(prompted, 'rl.prompt should be called');
    });

    it('with valid agent arg does not throw', async () => {
      const ctx = makeCtx({ HYDRA_ROOT: '/tmp/hydra-nonexistent-root' });
      let threw = false;
      try {
        await captureLog(() => mod.handleModelSelectCommand(ctx, 'claude'));
      } catch {
        threw = true;
      }
      assert.ok(!threw, 'handleModelSelectCommand(claude) should not throw');
    });
  });

  describe('handleCleanupCommand', () => {
    it('calls rl.prompt even when action pipeline throws', async () => {
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
        // Use a non-existent baseUrl so daemon calls fail immediately
        baseUrl: 'http://127.0.0.1:1',
      });
      await captureLog(() => mod.handleCleanupCommand(ctx));
      assert.ok(prompted, 'rl.prompt should be called after cleanup (even on error)');
    });

    it('does not throw when scanners encounter errors', async () => {
      const ctx = makeCtx({ baseUrl: 'http://127.0.0.1:1' });
      let threw = false;
      try {
        await captureLog(() => mod.handleCleanupCommand(ctx));
      } catch {
        threw = true;
      }
      assert.ok(!threw, 'handleCleanupCommand should not propagate errors');
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
