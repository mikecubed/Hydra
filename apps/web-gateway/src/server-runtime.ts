import { readFile } from 'node:fs/promises';
import { dirname, extname, relative, resolve } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

const MODULE_DIR = dirname(fileURLToPath(import.meta.url));
const DEFAULT_STATIC_DIR = resolve(MODULE_DIR, '../../web/dist');
const DEFAULT_STATE_DIR = resolve(homedir(), '.hydra/web-gateway');

const GATEWAY_ROUTE_PREFIXES = [
  '/auth',
  '/session',
  '/conversations',
  '/approvals',
  '/turns',
  '/artifacts',
  '/operations',
  '/ws',
] as const;

export interface GatewayServerConfig {
  host: string;
  port: number;
  publicOrigin: string;
  daemonUrl: string;
  staticDir: string;
  stateDir: string;
  operatorsPath: string;
  sessionsPath: string;
  auditPath: string;
  operatorId: string | null;
  operatorDisplayName: string | null;
  operatorSecret: string | null;
}

function parsePort(rawPort: string | undefined): number {
  if (rawPort == null) return 4174;
  if (!/^\d+$/.test(rawPort)) {
    throw new Error(`HYDRA_WEB_GATEWAY_PORT must be a whole number, received "${rawPort}"`);
  }

  const port = Number(rawPort);
  if (port < 1 || port > 65_535) {
    throw new Error(`HYDRA_WEB_GATEWAY_PORT must be between 1 and 65535, received ${rawPort}`);
  }

  return port;
}

function resolveOrigin(host: string, port: number, explicitOrigin: string | undefined): string {
  const origin = explicitOrigin ?? `http://${host}:${String(port)}`;
  const parsed = new URL(origin);
  return parsed.origin;
}

export function resolveGatewayServerConfig(
  env: NodeJS.ProcessEnv = process.env,
): GatewayServerConfig {
  const host = env['HYDRA_WEB_GATEWAY_HOST'] ?? '127.0.0.1';
  const port = parsePort(env['HYDRA_WEB_GATEWAY_PORT']);
  const publicOrigin = resolveOrigin(host, port, env['HYDRA_WEB_GATEWAY_ORIGIN']);
  const daemonUrl = env['HYDRA_DAEMON_URL'] ?? 'http://127.0.0.1:4173';
  const staticDirEnv = env['HYDRA_WEB_STATIC_DIR'];
  const staticDir =
    staticDirEnv != null && staticDirEnv !== '' ? resolve(staticDirEnv) : DEFAULT_STATIC_DIR;
  const stateDirEnv = env['HYDRA_WEB_STATE_DIR'];
  const stateDir =
    stateDirEnv != null && stateDirEnv !== '' ? resolve(stateDirEnv) : DEFAULT_STATE_DIR;
  const operatorId = env['HYDRA_WEB_OPERATOR_ID'] ?? null;
  const operatorDisplayName = env['HYDRA_WEB_OPERATOR_DISPLAY_NAME'] ?? operatorId;
  const operatorSecret = env['HYDRA_WEB_OPERATOR_SECRET'] ?? null;

  if ((operatorId == null) !== (operatorSecret == null)) {
    throw new Error(
      'HYDRA_WEB_OPERATOR_ID and HYDRA_WEB_OPERATOR_SECRET must either both be set or both be unset',
    );
  }

  return {
    host,
    port,
    publicOrigin,
    daemonUrl,
    staticDir,
    stateDir,
    operatorsPath: resolve(stateDir, 'operators.json'),
    sessionsPath: resolve(stateDir, 'sessions.json'),
    auditPath: resolve(stateDir, 'audit.log'),
    operatorId,
    operatorDisplayName,
    operatorSecret,
  };
}

export function isGatewayRoute(pathname: string): boolean {
  return GATEWAY_ROUTE_PREFIXES.some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
  );
}

function resolveStaticFilePath(staticDir: string, pathname: string): string | null {
  const targetPath = pathname === '/' ? '/index.html' : pathname;
  let decodedPath: string;
  try {
    decodedPath = decodeURIComponent(targetPath);
  } catch {
    return null;
  }

  const absolutePath = resolve(staticDir, `.${decodedPath}`);
  const staticRoot = resolve(staticDir);
  const pathWithinRoot = relative(staticRoot, absolutePath);
  if (pathWithinRoot.startsWith('..') || pathWithinRoot === '') {
    return null;
  }

  return absolutePath;
}

function contentTypeFor(filePath: string): string {
  switch (extname(filePath)) {
    case '.css':
      return 'text/css; charset=utf-8';
    case '.html':
      return 'text/html; charset=utf-8';
    case '.ico':
      return 'image/x-icon';
    case '.js':
      return 'text/javascript; charset=utf-8';
    case '.json':
      return 'application/json; charset=utf-8';
    case '.png':
      return 'image/png';
    case '.svg':
      return 'image/svg+xml';
    case '.txt':
      return 'text/plain; charset=utf-8';
    case '.woff2':
      return 'font/woff2';
    default:
      return 'application/octet-stream';
  }
}

async function readStaticFile(filePath: string): Promise<Response | null> {
  try {
    const body = await readFile(filePath);
    return new Response(body, {
      status: 200,
      headers: {
        'content-type': contentTypeFor(filePath),
        'cache-control': filePath.endsWith('/index.html')
          ? 'no-cache'
          : 'public, max-age=31536000, immutable',
      },
    });
  } catch {
    return null;
  }
}

export async function createStaticAssetResponse(
  staticDir: string,
  pathname: string,
): Promise<Response | null> {
  if (isGatewayRoute(pathname)) {
    return null;
  }

  const requestedFilePath = resolveStaticFilePath(staticDir, pathname);
  if (requestedFilePath == null) {
    return new Response('Not found', { status: 404 });
  }

  const directAsset = await readStaticFile(requestedFilePath);
  if (directAsset != null) {
    return directAsset;
  }

  if (extname(pathname) !== '') {
    return new Response('Not found', { status: 404 });
  }

  const indexPath = resolve(staticDir, 'index.html');
  const appShell = await readStaticFile(indexPath);
  if (appShell != null) {
    return appShell;
  }

  return new Response(
    'Missing built frontend assets. Run `npm --workspace @hydra/web run build` first.',
    { status: 503, headers: { 'content-type': 'text/plain; charset=utf-8' } },
  );
}
