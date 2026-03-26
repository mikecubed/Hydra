import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { getRequestListener } from '@hono/node-server';
import { AuditStore } from './audit/audit-store.ts';
import { OperatorStore } from './auth/operator-store.ts';
import { createGatewayApp } from './index.ts';
import { SessionStore } from './session/session-store.ts';
import { createStaticAssetResponse, resolveGatewayServerConfig } from './server-runtime.ts';

async function seedOperatorIfConfigured(
  operatorStore: OperatorStore,
  config: ReturnType<typeof resolveGatewayServerConfig>,
): Promise<void> {
  if (config.operatorId == null || config.operatorSecret == null) {
    return;
  }

  const existing = operatorStore.getOperator(config.operatorId);
  if (existing == null) {
    await operatorStore.createOperator(
      config.operatorId,
      config.operatorDisplayName ?? config.operatorId,
    );
  }

  const current = operatorStore.getOperator(config.operatorId);
  const hasActiveCredential =
    current?.credentials.some((credential) => !credential.isRevoked) ?? false;
  if (!hasActiveCredential) {
    await operatorStore.addCredential(config.operatorId, config.operatorSecret);
  }
}

async function writeResponse(
  response: Response,
  nodeResponse: ServerResponse,
  method: string | undefined,
): Promise<void> {
  nodeResponse.statusCode = response.status;
  for (const [name, value] of response.headers.entries()) {
    nodeResponse.setHeader(name, value);
  }

  if (response.body == null || method === 'HEAD') {
    nodeResponse.end();
    return;
  }

  const payload = Buffer.from(await response.arrayBuffer());
  nodeResponse.end(payload);
}

function attachRequestHandler(
  server: ReturnType<typeof createServer>,
  requestListener: ReturnType<typeof getRequestListener>,
  config: ReturnType<typeof resolveGatewayServerConfig>,
): void {
  server.on('request', (request: IncomingMessage, response: ServerResponse) => {
    void (async () => {
      try {
        const requestUrl = new URL(request.url ?? '/', config.publicOrigin);
        if (request.method === 'GET' || request.method === 'HEAD') {
          const staticResponse = await createStaticAssetResponse(
            config.staticDir,
            requestUrl.pathname,
          );
          if (staticResponse != null) {
            await writeResponse(staticResponse, response, request.method);
            return;
          }
        }

        await requestListener(request, response);
      } catch (err) {
        console.error('Failed to handle gateway request', err);
        if (!response.headersSent) {
          response.statusCode = 500;
          response.setHeader('content-type', 'text/plain; charset=utf-8');
        }
        response.end('Internal Server Error');
      }
    })();
  });
}

async function listen(
  server: ReturnType<typeof createServer>,
  config: ReturnType<typeof resolveGatewayServerConfig>,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(config.port, config.host, () => {
      server.off('error', reject);
      resolve();
    });
  });
}

function logStartup(config: ReturnType<typeof resolveGatewayServerConfig>): void {
  console.log(`Hydra web gateway listening on ${config.publicOrigin}`);
  console.log(`Daemon upstream: ${config.daemonUrl}`);
  console.log(`Static assets: ${config.staticDir}`);
  if (config.operatorId == null) {
    console.log(
      'No operator seed configured. Existing session or stored operator data is required.',
    );
  } else {
    console.log(`Seeded operator: ${config.operatorId}`);
  }
}

function registerShutdown(
  server: ReturnType<typeof createServer>,
  gateway: ReturnType<typeof createGatewayApp>,
  sessionStore: SessionStore,
): void {
  const shutdown = async (): Promise<void> => {
    gateway.wsServer?.close();
    gateway.heartbeat.stop();
    await Promise.allSettled([sessionStore.snapshot()]);
    await new Promise<void>((resolve, reject) => {
      server.close((err) => {
        if (err != null) {
          reject(err);
          return;
        }
        resolve();
      });
    });
  };

  process.once('SIGINT', () => {
    void shutdown();
  });
  process.once('SIGTERM', () => {
    void shutdown();
  });
}

async function main(): Promise<void> {
  const config = resolveGatewayServerConfig();
  const operatorStore = new OperatorStore(config.operatorsPath);
  const sessionStore = new SessionStore(config.sessionsPath);
  const auditStore = new AuditStore(config.auditPath);

  await Promise.all([operatorStore.load(), sessionStore.loadSnapshot(), auditStore.load()]);
  await seedOperatorIfConfigured(operatorStore, config);

  const server = createServer();
  const gateway = createGatewayApp({
    server,
    allowedOrigin: config.publicOrigin,
    operatorStore,
    sessionStore,
    auditStore,
    daemonClientOptions: { baseUrl: config.daemonUrl },
    heartbeatConfig: { daemonUrl: config.daemonUrl },
  });

  attachRequestHandler(server, getRequestListener(gateway.app.fetch), config);
  await listen(server, config);
  logStartup(config);
  registerShutdown(server, gateway, sessionStore);
}

await main();
