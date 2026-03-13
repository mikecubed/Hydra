/**
 * Unit tests for lib/daemon/http-utils.ts
 * Uses minimal stubs for IncomingMessage / ServerResponse — no real I/O.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  sendJson,
  sendError,
  isAuthorized,
  readJsonBody,
  requestJson,
} from '../lib/daemon/http-utils.ts';

// ---------------------------------------------------------------------------
// Minimal ServerResponse stub
// ---------------------------------------------------------------------------

interface ResponseCapture {
  statusCode: number;
  headers: Record<string, string | number>;
  body: string;
}

function makeRes(): { res: ServerResponse; capture: ResponseCapture } {
  const capture: ResponseCapture = { statusCode: 0, headers: {}, body: '' };

  const res = {
    writeHead(status: number, headers: Record<string, string | number>) {
      capture.statusCode = status;
      Object.assign(capture.headers, headers);
    },
    end(body: string) {
      capture.body = body;
    },
  } as unknown as ServerResponse;

  return { res, capture };
}

// ---------------------------------------------------------------------------
// Minimal IncomingMessage stub
// ---------------------------------------------------------------------------

function makeReq(headers: Record<string, string> = {}, body?: string): IncomingMessage {
  const stream = body === undefined ? Readable.from([]) : Readable.from([Buffer.from(body)]);
  Object.assign(stream, { headers });
  return stream as unknown as IncomingMessage;
}

// ---------------------------------------------------------------------------
// sendJson
// ---------------------------------------------------------------------------

describe('sendJson', () => {
  it('sendJson_withObject_writesJsonBodyAndHeaders', () => {
    const { res, capture } = makeRes();
    sendJson(res, 200, { ok: true, value: 42 });

    assert.equal(capture.statusCode, 200);
    assert.equal(capture.headers['Content-Type'], 'application/json; charset=utf-8');
    assert.deepEqual(JSON.parse(capture.body), { ok: true, value: 42 });
  });

  it('sendJson_with404Status_propagatesStatusCode', () => {
    const { res, capture } = makeRes();
    sendJson(res, 404, { error: 'not found' });
    assert.equal(capture.statusCode, 404);
  });

  it('sendJson_withContentLength_matchesBodyByteLength', () => {
    const { res, capture } = makeRes();
    sendJson(res, 200, { hello: 'world' });
    const expected = Buffer.byteLength(capture.body);
    assert.equal(capture.headers['Content-Length'], expected);
  });
});

// ---------------------------------------------------------------------------
// sendError
// ---------------------------------------------------------------------------

describe('sendError', () => {
  it('sendError_withMessage_setsOkFalseAndError', () => {
    const { res, capture } = makeRes();
    sendError(res, 400, 'Bad input');

    assert.equal(capture.statusCode, 400);
    const parsed = JSON.parse(capture.body) as { ok: boolean; error: string; details: unknown };
    assert.equal(parsed.ok, false);
    assert.equal(parsed.error, 'Bad input');
    assert.equal(parsed.details, null);
  });

  it('sendError_withDetails_includesDetailsInBody', () => {
    const { res, capture } = makeRes();
    sendError(res, 422, 'Validation failed', { field: 'title' });

    const parsed = JSON.parse(capture.body) as { details: { field: string } };
    assert.deepEqual(parsed.details, { field: 'title' });
  });

  it('sendError_with500_propagatesStatusCode', () => {
    const { res, capture } = makeRes();
    sendError(res, 500, 'Internal error');
    assert.equal(capture.statusCode, 500);
  });
});

// ---------------------------------------------------------------------------
// isAuthorized
// ---------------------------------------------------------------------------

describe('isAuthorized', () => {
  it('isAuthorized_withEmptyToken_alwaysAllows', () => {
    const req = makeReq({});
    assert.equal(isAuthorized(req, ''), true);
  });

  it('isAuthorized_withMatchingHeader_allows', () => {
    const req = makeReq({ 'x-ai-orch-token': 'secret' });
    assert.equal(isAuthorized(req, 'secret'), true);
  });

  it('isAuthorized_withWrongHeader_denies', () => {
    const req = makeReq({ 'x-ai-orch-token': 'wrong' });
    assert.equal(isAuthorized(req, 'secret'), false);
  });

  it('isAuthorized_withMissingHeader_denies', () => {
    const req = makeReq({});
    assert.equal(isAuthorized(req, 'secret'), false);
  });
});

// ---------------------------------------------------------------------------
// readJsonBody
// ---------------------------------------------------------------------------

describe('readJsonBody', () => {
  it('readJsonBody_withJsonPayload_parsesCorrectly', async () => {
    const req = makeReq({}, JSON.stringify({ task: 'test', count: 3 }));
    const result = await readJsonBody(req);
    assert.deepEqual(result, { task: 'test', count: 3 });
  });

  it('readJsonBody_withEmptyBody_returnsEmptyObject', async () => {
    const req = makeReq({}, '');
    const result = await readJsonBody(req);
    assert.deepEqual(result, {});
  });

  it('readJsonBody_withNoChunks_returnsEmptyObject', async () => {
    const req = makeReq({});
    const result = await readJsonBody(req);
    assert.deepEqual(result, {});
  });

  it('readJsonBody_withOversizedBody_throwsPayloadTooLarge', async () => {
    const bigPayload = 'x'.repeat(1024 * 1024 + 1);
    const req = makeReq({}, bigPayload);
    await assert.rejects(() => readJsonBody(req), /Payload too large/);
  });

  it('readJsonBody_withInvalidJson_throwsSyntaxError', async () => {
    const req = makeReq({}, 'not valid json {{{');
    await assert.rejects(() => readJsonBody(req), SyntaxError);
  });

  it('readJsonBody_withPrimitiveJson_throwsTypeError', async () => {
    const req = makeReq({}, '42');
    await assert.rejects(() => readJsonBody(req), TypeError);
  });

  it('readJsonBody_withJsonArray_throwsTypeError', async () => {
    const req = makeReq({}, '["a","b"]');
    await assert.rejects(() => readJsonBody(req), TypeError);
  });
});

// ---------------------------------------------------------------------------
// requestJson
// ---------------------------------------------------------------------------

describe('requestJson', () => {
  let originalFetch: typeof globalThis.fetch;

  before(() => {
    originalFetch = globalThis.fetch;
  });

  after(() => {
    globalThis.fetch = originalFetch;
  });

  it('requestJson_withSuccessResponse_returnsPayload', async () => {
    globalThis.fetch = (_url, _init) =>
      Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ ok: true, items: [] }),
      } as unknown as globalThis.Response);

    const { response, payload } = await requestJson('GET', 'http://localhost:4173/health');
    assert.equal(response.ok, true);
    assert.deepEqual(payload, { ok: true, items: [] });
  });

  it('requestJson_withToken_setsAuthHeader', async () => {
    let capturedHeaders: Record<string, string> = {};

    globalThis.fetch = (_url, init) => {
      capturedHeaders = (init?.headers ?? {}) as Record<string, string>;
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve({}),
      } as unknown as globalThis.Response);
    };

    await requestJson('GET', 'http://localhost:4173/health', null, 'my-token');
    assert.equal(capturedHeaders['x-ai-orch-token'], 'my-token');
  });

  it('requestJson_withNoToken_omitsAuthHeader', async () => {
    let capturedHeaders: Record<string, string> = {};

    globalThis.fetch = (_url, init) => {
      capturedHeaders = (init?.headers ?? {}) as Record<string, string>;
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve({}),
      } as unknown as globalThis.Response);
    };

    await requestJson('GET', 'http://localhost:4173/health', null, '');
    assert.equal(capturedHeaders['x-ai-orch-token'], undefined);
  });

  it('requestJson_withBodyPayload_sendsJsonContentType', async () => {
    let capturedHeaders: Record<string, string> = {};
    let capturedBody: string | undefined;

    globalThis.fetch = (_url, init) => {
      capturedHeaders = (init?.headers ?? {}) as Record<string, string>;
      capturedBody = init?.body as string | undefined;
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve({}),
      } as unknown as globalThis.Response);
    };

    await requestJson('POST', 'http://localhost:4173/task/add', { title: 'New task' });
    assert.equal(capturedHeaders['Content-Type'], 'application/json');
    assert.deepEqual(JSON.parse(capturedBody ?? '{}'), { title: 'New task' });
  });

  it('requestJson_withBadJsonResponse_returnsEmptyPayload', async () => {
    globalThis.fetch = (_url, _init) =>
      Promise.resolve({
        ok: false,
        status: 500,
        json: () => Promise.reject(new SyntaxError('bad json')),
      } as unknown as globalThis.Response);

    const { response, payload } = await requestJson('POST', 'http://localhost:4173/shutdown');
    assert.equal(response.ok, false);
    assert.deepEqual(payload, {});
  });
});
