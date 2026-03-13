/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeSimpleCommandText,
  parseSelfAwarenessPlaintextCommand,
} from '../lib/hydra-operator-self-awareness.ts';

describe('normalizeSimpleCommandText', () => {
  it('lowercases and trims', () => {
    assert.equal(normalizeSimpleCommandText('  Hello World  '), 'hello world');
  });

  it('removes punctuation', () => {
    assert.equal(normalizeSimpleCommandText('Hello, World!'), 'hello world');
  });

  it('collapses whitespace', () => {
    assert.equal(normalizeSimpleCommandText('foo   bar'), 'foo bar');
  });

  it('handles non-string (converts to string)', () => {
    assert.equal(normalizeSimpleCommandText(42 as any), '42');
    assert.equal(normalizeSimpleCommandText(null as any), '');
    assert.equal(normalizeSimpleCommandText(undefined as any), '');
  });

  it('returns empty string for empty input', () => {
    assert.equal(normalizeSimpleCommandText(''), '');
  });
});

describe('parseSelfAwarenessPlaintextCommand', () => {
  it('returns null for empty input', () => {
    assert.equal(parseSelfAwarenessPlaintextCommand(''), null);
    assert.equal(parseSelfAwarenessPlaintextCommand(null as any), null);
    assert.equal(parseSelfAwarenessPlaintextCommand(undefined as any), null);
  });

  it('returns null for commands starting with :', () => {
    assert.equal(parseSelfAwarenessPlaintextCommand(':self-awareness on'), null);
  });

  it('returns null for commands starting with !', () => {
    assert.equal(parseSelfAwarenessPlaintextCommand('!self-awareness on'), null);
  });

  it('returns null for multi-line input', () => {
    assert.equal(parseSelfAwarenessPlaintextCommand('turn on\nself awareness'), null);
  });

  it('returns null for strings > 80 chars after normalisation', () => {
    const long = 'a'.repeat(85);
    assert.equal(parseSelfAwarenessPlaintextCommand(long), null);
  });

  it('detects "disable self awareness" → off', () => {
    assert.equal(parseSelfAwarenessPlaintextCommand('disable self awareness'), 'off');
    assert.equal(parseSelfAwarenessPlaintextCommand('turn off self-awareness'), 'off');
    assert.equal(parseSelfAwarenessPlaintextCommand('self awareness off'), 'off');
    assert.equal(parseSelfAwarenessPlaintextCommand('please disable hyper awareness'), 'off');
  });

  it('detects "enable self awareness" → on', () => {
    assert.equal(parseSelfAwarenessPlaintextCommand('enable self awareness'), 'on');
    assert.equal(parseSelfAwarenessPlaintextCommand('turn on self-awareness'), 'on');
    assert.equal(parseSelfAwarenessPlaintextCommand('self awareness on'), 'on');
    assert.equal(parseSelfAwarenessPlaintextCommand('please enable hyper awareness'), 'on');
  });

  it('detects "set self awareness to minimal" → minimal', () => {
    assert.equal(parseSelfAwarenessPlaintextCommand('set self awareness to minimal'), 'minimal');
    assert.equal(parseSelfAwarenessPlaintextCommand('self awareness minimal'), 'minimal');
  });

  it('detects "set self awareness to full" → full', () => {
    assert.equal(parseSelfAwarenessPlaintextCommand('set self awareness to full'), 'full');
    assert.equal(parseSelfAwarenessPlaintextCommand('self awareness full'), 'full');
  });

  it('detects "self awareness status" → status', () => {
    assert.equal(parseSelfAwarenessPlaintextCommand('self awareness status'), 'status');
    assert.equal(parseSelfAwarenessPlaintextCommand('hyper awareness status'), 'status');
  });

  it('returns null for unrelated plain text', () => {
    assert.equal(parseSelfAwarenessPlaintextCommand('run the tests'), null);
    assert.equal(parseSelfAwarenessPlaintextCommand('hello world'), null);
  });
});
