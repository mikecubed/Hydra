import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, extname, relative, resolve } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

const MODULE_DIR = dirname(fileURLToPath(import.meta.url));
const DEFAULT_STATIC_DIR = resolve(MODULE_DIR, '../../web/dist');
const PACKAGED_STATIC_DIR = resolve(MODULE_DIR, 'web');
const DEFAULT_STATE_DIR = resolve(homedir(), '.hydra/web-gateway');

const GATEWAY_ROUTE_PREFIXES = [
  '/auth',
  '/session',
  '/conversations',
  '/approvals',
  '/turns',
  '/artifacts',
  '/operations',
  '/config',
  '/audit',
  '/healthz',
  '/ws',
] as const;

function buildStaticSecurityHeaders(tlsActive: boolean): Record<string, string> {
  const connectSrc = tlsActive ? "'self' wss:" : "'self' ws: wss:";
  return {
    'content-security-policy': `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src ${connectSrc}; frame-ancestors 'none'`,
    'x-content-type-options': 'nosniff',
    'x-frame-options': 'DENY',
    'referrer-policy': 'strict-origin-when-cross-origin',
    ...(tlsActive ? { 'strict-transport-security': 'max-age=31536000; includeSubDomains' } : {}),
  };
}

export type StaticDirSource = 'source-checkout' | 'packaged' | 'env-override';

export interface GatewayServerConfig {
  host: string;
  port: number;
  publicOrigin: string;
  daemonUrl: string;
  staticDir: string;
  staticDirSource: StaticDirSource;
  stateDir: string;
  operatorsPath: string;
  sessionsPath: string;
  auditPath: string;
  operatorId: string | null;
  operatorDisplayName: string | null;
  operatorSecret: string | null;
}

const OptionalTrimmedString = z
  .string()
  .transform((value) => value.trim())
  .optional()
  .transform((value) => (value == null || value === '' ? undefined : value));

const RequiredNonEmptyTrimmedString = z.string().transform((value, context) => {
  const trimmed = value.trim();
  if (trimmed === '') {
    context.addIssue({
      code: 'custom',
      message: 'must not be empty when set',
    });
    return z.NEVER;
  }

  return trimmed;
});

const GatewayServerEnvSchema = z
  .object({
    HYDRA_WEB_GATEWAY_HOST: OptionalTrimmedString,
    HYDRA_WEB_GATEWAY_PORT: OptionalTrimmedString,
    HYDRA_WEB_GATEWAY_ORIGIN: OptionalTrimmedString,
    HYDRA_DAEMON_URL: OptionalTrimmedString,
    HYDRA_WEB_STATIC_DIR: OptionalTrimmedString,
    HYDRA_WEB_STATE_DIR: OptionalTrimmedString,
    HYDRA_WEB_OPERATOR_ID: z
      .union([RequiredNonEmptyTrimmedString, z.undefined()])
      .optional()
      .transform((value) => value ?? undefined),
    HYDRA_WEB_OPERATOR_DISPLAY_NAME: OptionalTrimmedString,
    HYDRA_WEB_OPERATOR_SECRET: z
      .union([RequiredNonEmptyTrimmedString, z.undefined()])
      .optional()
      .transform((value) => value ?? undefined),
  })
  .superRefine((env, context) => {
    if ((env.HYDRA_WEB_OPERATOR_ID == null) !== (env.HYDRA_WEB_OPERATOR_SECRET == null)) {
      context.addIssue({
        code: 'custom',
        message:
          'HYDRA_WEB_OPERATOR_ID and HYDRA_WEB_OPERATOR_SECRET must either both be set or both be unset',
      });
    }
  });

function formatEnvIssues(error: z.ZodError, env: NodeJS.ProcessEnv): string {
  if (error.issues.length === 0) {
    return 'Invalid gateway server environment';
  }

  const firstIssue = error.issues[0];
  const field = firstIssue.path[0];
  if (typeof field === 'string') {
    const rawValue = env[field];
    if (
      (field === 'HYDRA_WEB_OPERATOR_ID' || field === 'HYDRA_WEB_OPERATOR_SECRET') &&
      rawValue?.trim() === ''
    ) {
      return `${field} must not be empty when set`;
    }

    return `${field} ${firstIssue.message}`;
  }

  return firstIssue.message;
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

export function resolveStaticDirWithSource(
  envOverride: string | undefined,
  moduleDir: string = MODULE_DIR,
): { staticDir: string; staticDirSource: StaticDirSource } {
  if (envOverride != null && envOverride !== '') {
    return { staticDir: resolve(envOverride), staticDirSource: 'env-override' };
  }

  const packagedDir = resolve(moduleDir, 'web');
  if (existsSync(packagedDir)) {
    return { staticDir: packagedDir, staticDirSource: 'packaged' };
  }

  return {
    staticDir: resolve(moduleDir, '../../web/dist'),
    staticDirSource: 'source-checkout',
  };
}

export function describeStaticDirSource(source: StaticDirSource): string {
  switch (source) {
    case 'source-checkout':
      return 'source checkout';
    case 'packaged':
      return 'packaged';
    case 'env-override':
      return 'env override';
  }
}

export function missingAssetsMessage(source: StaticDirSource | undefined): string {
  switch (source) {
    case 'packaged':
      return (
        'Packaged web assets not found in dist/web-runtime/web/. ' +
        'Re-run `npm run build-pack` to include web assets in the packaged output.'
      );
    case 'env-override':
      return (
        'Frontend assets not found at the path specified by HYDRA_WEB_STATIC_DIR. ' +
        'Verify the directory contains a built web frontend (index.html).'
      );
    default:
      return 'Missing built frontend assets. Run `npm --workspace @hydra/web run build` first.';
  }
}

export function formatStartupLines(config: GatewayServerConfig): string[] {
  const sourceLabel = describeStaticDirSource(config.staticDirSource);
  const lines = [
    `Hydra web gateway listening on ${config.publicOrigin}`,
    `Daemon upstream: ${config.daemonUrl}`,
    `Static assets: ${config.staticDir} (${sourceLabel})`,
  ];

  if (config.operatorId == null) {
    lines.push(
      'No operator seed configured. Existing session or stored operator data is required.',
    );
  } else {
    lines.push(`Seeded operator: ${config.operatorId}`);
  }

  return lines;
}

export function resolveGatewayServerConfig(
  env: NodeJS.ProcessEnv = process.env,
): GatewayServerConfig {
  const parsedEnv = GatewayServerEnvSchema.safeParse(env);
  if (!parsedEnv.success) {
    throw new Error(formatEnvIssues(parsedEnv.error, env));
  }

  const validatedEnv = parsedEnv.data;
  const host = validatedEnv.HYDRA_WEB_GATEWAY_HOST ?? '127.0.0.1';
  const port = parsePort(validatedEnv.HYDRA_WEB_GATEWAY_PORT);
  const publicOrigin = resolveOrigin(host, port, validatedEnv.HYDRA_WEB_GATEWAY_ORIGIN);
  const daemonUrl = validatedEnv.HYDRA_DAEMON_URL ?? 'http://127.0.0.1:4173';
  const { staticDir, staticDirSource } = resolveStaticDirWithSource(
    validatedEnv.HYDRA_WEB_STATIC_DIR,
  );
  const stateDirEnv = validatedEnv.HYDRA_WEB_STATE_DIR;
  const stateDir =
    stateDirEnv != null && stateDirEnv !== '' ? resolve(stateDirEnv) : DEFAULT_STATE_DIR;
  const operatorId = validatedEnv.HYDRA_WEB_OPERATOR_ID ?? null;
  const operatorDisplayNameRaw = validatedEnv.HYDRA_WEB_OPERATOR_DISPLAY_NAME;
  const operatorDisplayName =
    operatorDisplayNameRaw != null && operatorDisplayNameRaw !== ''
      ? operatorDisplayNameRaw
      : operatorId;
  const operatorSecret = validatedEnv.HYDRA_WEB_OPERATOR_SECRET ?? null;

  return {
    host,
    port,
    publicOrigin,
    daemonUrl,
    staticDir,
    staticDirSource,
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

async function readStaticFile(filePath: string, tlsActive: boolean): Promise<Response | null> {
  try {
    const body = await readFile(filePath);
    return new Response(body, {
      status: 200,
      headers: {
        'content-type': contentTypeFor(filePath),
        'cache-control': filePath.endsWith('/index.html')
          ? 'no-cache'
          : 'public, max-age=31536000, immutable',
        ...buildStaticSecurityHeaders(tlsActive),
      },
    });
  } catch (err) {
    if (
      typeof err === 'object' &&
      err !== null &&
      'code' in err &&
      (err.code === 'ENOENT' || err.code === 'ENOTDIR')
    ) {
      return null;
    }

    throw err;
  }
}

export async function createStaticAssetResponse(
  staticDir: string,
  pathname: string,
  options: { tlsActive?: boolean; staticDirSource?: StaticDirSource } = {},
): Promise<Response | null> {
  const tlsActive = options.tlsActive ?? false;
  if (isGatewayRoute(pathname)) {
    return null;
  }

  const requestedFilePath = resolveStaticFilePath(staticDir, pathname);
  if (requestedFilePath == null) {
    return new Response('Not found', { status: 404 });
  }

  const directAsset = await readStaticFile(requestedFilePath, tlsActive);
  if (directAsset != null) {
    return directAsset;
  }

  if (extname(pathname) !== '') {
    return new Response('Not found', { status: 404 });
  }

  const indexPath = resolve(staticDir, 'index.html');
  const appShell = await readStaticFile(indexPath, tlsActive);
  if (appShell != null) {
    return appShell;
  }

  return new Response(missingAssetsMessage(options.staticDirSource), {
    status: 503,
    headers: { 'content-type': 'text/plain; charset=utf-8' },
  });
}
