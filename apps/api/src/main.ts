import { getApiConfig } from '@h3/config';
import { startApi } from './app.js';

const config = getApiConfig();
const app = await startApi(config);

const shutdown = async (signal: string): Promise<void> => {
  app.log.info({ signal }, 'API shutdown requested');
  await app.close();
};

process.once('SIGINT', () => {
  void shutdown('SIGINT');
});
process.once('SIGTERM', () => {
  void shutdown('SIGTERM');
});
