import { config } from './config';
import { buildServer } from './server';

async function main(): Promise<void> {
  const app = buildServer();
  await app.listen({ port: config.port, host: config.host });
  // eslint-disable-next-line no-console
  console.log(
    `[githaiku-backend] dev mode on http://${config.host}:${config.port} ` +
      `(secrets=${config.secretsProvider}, haiku=${config.haikuGenerator})`,
  );
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('[githaiku-backend] failed to start', err);
  process.exit(1);
});
