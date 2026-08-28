import { getFakeComfyConfig } from '@h3/config';
import { buildFakeComfyApp } from './app.js';

const config = getFakeComfyConfig();
const app = buildFakeComfyApp({ config });

await app.listen({ host: config.host, port: config.port });

const shutdown = async (signal: string): Promise<void> => {
  app.log.info({ signal }, 'fake ComfyUI shutdown requested');
  await app.close();
};

process.once('SIGINT', () => {
  void shutdown('SIGINT');
});
process.once('SIGTERM', () => {
  void shutdown('SIGTERM');
});
