import { config, assertSafeConfig } from './config.js';
import { openDb } from './db.js';
import { createApp } from './app.js';
import { seedDefaultFleet, seedTestData } from './seed.js';
import { log } from './util.js';

assertSafeConfig();

const db = openDb();
seedDefaultFleet(db);
await seedTestData(db);

// Expired sessions are only ever read through a filter, so a periodic sweep is enough.
const sweep = () => db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(new Date().toISOString());
sweep();
setInterval(sweep, 3600_000).unref();

const app = createApp(db);
const server = app.listen(config.port, () => {
  log('info', 'server started', {
    port: config.port, env: config.appEnv, auth: config.authMode,
    seedTestData: config.seedTestData, journal: config.sqliteJournalMode, version: config.version,
  });
  if (config.appEnv !== 'production' && config.authMode === 'local' && config.seedTestData) {
    log('warn', 'test logins are enabled — never expose this configuration with real data');
  }
});

for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => {
    log('info', 'shutting down', { signal: sig });
    server.close(() => { db.close(); process.exit(0); });
    setTimeout(() => process.exit(1), 8000).unref();
  });
}
