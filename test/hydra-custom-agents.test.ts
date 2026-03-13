/**
 * Tests for lib/hydra-shared/execute-custom-agents.ts
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  expandInvokeArgs,
  assertSafeSpawnCmd,
  parseCliResponse,
} from '../lib/hydra-shared/execute-custom-agents.ts';

describe('expandInvokeArgs', () => {
  it('replaces known placeholders', () => {
    const args = ['{prompt}', '--cwd', '{cwd}'];
    const result = expandInvokeArgs(args, { prompt: 'hello', cwd: '/tmp' });
    assert.deepEqual(result, ['hello', '--cwd', '/tmp']);
  });

  it('leaves unknown placeholders intact', () => {
    const args = ['{prompt}', '{unknown}'];
    const result = expandInvokeArgs(args, { prompt: 'hi' });
    assert.deepEqual(result, ['hi', '{unknown}']);
  });

  it('handles args without placeholders', () => {
    const args = ['--no-color', '--json'];
    const result = expandInvokeArgs(args, { prompt: 'test' });
    assert.deepEqual(result, ['--no-color', '--json']);
  });

  it('handles empty args array', () => {
    const result = expandInvokeArgs([], { prompt: 'test' });
    assert.deepEqual(result, []);
  });

  it('replaces multiple placeholders in one arg', () => {
    const result = expandInvokeArgs(['{a}:{b}'], { a: 'foo', b: 'bar' });
    assert.deepEqual(result, ['foo:bar']);
  });
});

describe('assertSafeSpawnCmd', () => {
  it('accepts safe command names', () => {
    assert.doesNotThrow(() => {
      assertSafeSpawnCmd('my-tool', 'test');
    });
    assert.doesNotThrow(() => {
      assertSafeSpawnCmd('my_tool', 'test');
    });
    assert.doesNotThrow(() => {
      assertSafeSpawnCmd('tool123', 'test');
    });
  });

  it('rejects semicolons', () => {
    assert.throws(() => {
      assertSafeSpawnCmd('cmd; rm -rf /', 'test');
    }, /unsafe characters/);
  });

  it('rejects pipe', () => {
    assert.throws(() => {
      assertSafeSpawnCmd('cmd | cat', 'test');
    }, /unsafe characters/);
  });

  it('rejects backtick', () => {
    assert.throws(() => {
      assertSafeSpawnCmd('`whoami`', 'test');
    }, /unsafe characters/);
  });

  it('rejects dollar sign', () => {
    assert.throws(() => {
      assertSafeSpawnCmd('$HOME/bin/tool', 'test');
    }, /unsafe characters/);
  });

  it('rejects path traversal', () => {
    assert.throws(() => {
      assertSafeSpawnCmd('../../../bin/sh', 'test');
    }, /path traversal/);
  });

  it('rejects ampersand', () => {
    assert.throws(() => {
      assertSafeSpawnCmd('cmd & bg', 'test');
    }, /unsafe characters/);
  });

  it('rejects null byte', () => {
    assert.throws(() => {
      assertSafeSpawnCmd('cmd\0', 'test');
    }, /unsafe characters/);
  });

  it('rejects redirection operator <', () => {
    assert.throws(() => {
      assertSafeSpawnCmd('cmd < /etc/passwd', 'test');
    }, /unsafe characters/);
  });

  it('rejects redirection operator >', () => {
    assert.throws(() => {
      assertSafeSpawnCmd('cmd > /tmp/out', 'test');
    }, /unsafe characters/);
  });

  it('rejects shell subshell syntax (', () => {
    assert.throws(() => {
      assertSafeSpawnCmd('$(cmd)', 'test');
    }, /unsafe characters/);
  });

  it('rejects shell subshell syntax )', () => {
    assert.throws(() => {
      assertSafeSpawnCmd('cmd)', 'test');
    }, /unsafe characters/);
  });

  it('rejects newline \\n', () => {
    assert.throws(() => {
      assertSafeSpawnCmd('cmd\nrm -rf /', 'test');
    }, /unsafe characters/);
  });

  it('rejects carriage return \\r', () => {
    assert.throws(() => {
      assertSafeSpawnCmd('cmd\rrm -rf /', 'test');
    }, /unsafe characters/);
  });

  it('includes context in error message', () => {
    assert.throws(() => {
      assertSafeSpawnCmd('cmd; bad', 'my-context');
    }, /my-context/);
  });
});

describe('parseCliResponse', () => {
  it('returns raw stdout for plaintext parser', () => {
    const result = parseCliResponse('hello world', 'plaintext');
    assert.equal(result, 'hello world');
  });

  it('returns raw stdout for markdown parser', () => {
    const result = parseCliResponse('# Heading\nBody', 'markdown');
    assert.equal(result, '# Heading\nBody');
  });

  it('extracts content field from JSON', () => {
    const json = JSON.stringify({ content: 'extracted content' });
    const result = parseCliResponse(json, 'json');
    assert.equal(result, 'extracted content');
  });

  it('extracts text field from JSON', () => {
    const json = JSON.stringify({ text: 'text value' });
    const result = parseCliResponse(json, 'json');
    assert.equal(result, 'text value');
  });

  it('extracts message field from JSON', () => {
    const json = JSON.stringify({ message: 'msg value' });
    const result = parseCliResponse(json, 'json');
    assert.equal(result, 'msg value');
  });

  it('extracts output field from JSON', () => {
    const json = JSON.stringify({ output: 'output value' });
    const result = parseCliResponse(json, 'json');
    assert.equal(result, 'output value');
  });

  it('prefers content over text in JSON', () => {
    const json = JSON.stringify({ content: 'preferred', text: 'fallback' });
    const result = parseCliResponse(json, 'json');
    assert.equal(result, 'preferred');
  });

  it('falls back to raw stdout on invalid JSON', () => {
    const result = parseCliResponse('not json', 'json');
    assert.equal(result, 'not json');
  });

  it('falls back to raw stdout on JSON without known fields', () => {
    const json = JSON.stringify({ unknown: 'value' });
    const result = parseCliResponse(json, 'json');
    assert.equal(result, json);
  });
});
