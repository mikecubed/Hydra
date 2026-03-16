/**
 * Test helpers — mock HTTP request/response objects.
 */
import { IncomingMessage, ServerResponse } from 'node:http';
import { Socket } from 'node:net';

interface MockResponse extends ServerResponse {
  statusCode: number;
  body: string;
}

export function createMockReqRes(
  method = 'GET',
  headers: Record<string, string> = {},
): { req: IncomingMessage; res: MockResponse } {
  const socket = new Socket();
  const req = new IncomingMessage(socket);
  req.method = method;
  Object.assign(req.headers, headers);

  // Mock remoteAddress
  Object.defineProperty(req.socket, 'remoteAddress', { value: '127.0.0.1', writable: true });

  const res = new ServerResponse(req) as MockResponse;
  res.body = '';

  const originalWriteHead = res.writeHead.bind(res);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  res.writeHead = function (statusCode: number, ...args: any[]) {
    res.statusCode = statusCode;
    // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
    return originalWriteHead(statusCode, ...args);
  } as typeof res.writeHead;

  const originalEnd = res.end.bind(res);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  res.end = function (data?: any, ...args: any[]) {
    if (typeof data === 'string') res.body = data;
    // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
    return originalEnd(data, ...args);
  } as typeof res.end;

  return { req, res };
}
