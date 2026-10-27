// All configuration comes from environment variables. See .env.example.
const env = process.env;
const flag = (v) => String(v || '').toLowerCase() === 'true';
const list = (v) => String(v || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);

export const config = {
  appEnv: env.APP_ENV || 'local',          // local | staging | production
  port: Number(env.PORT || 8080),
  dataDir: env.DATA_DIR || './data',       // SQLite file lives here — mount a persistent volume
  authMode: env.AUTH_MODE || 'local',      // local = email + password, gateway = Entra ID via Azure Easy Auth
  allowLocalAuthInProd: flag(env.ALLOW_LOCAL_AUTH),
  seedTestData: flag(env.SEED_TEST_DATA),  // test logins + sample data; refused in production
  adminEmails: list(env.ADMIN_EMAILS),     // gateway mode: these emails are always admins
  adminRole: env.ADMIN_ROLE || 'Admin',    // gateway mode: Entra app role that grants admin
  sqliteJournalMode: (env.SQLITE_JOURNAL_MODE || 'WAL').toUpperCase(), // use DELETE on Azure Files (SMB)
  sessionHours: Number(env.SESSION_HOURS || 12),
  alertWebhookUrl: env.ALERT_WEBHOOK_URL || '',
  timeZone: env.TZ || 'Australia/Brisbane',
  version: env.APP_VERSION || 'dev',
  platformName: env.PLATFORM_NAME || 'car-booking',
  dataApiKey: env.DATA_API_KEY || '',          // Data Export API key (Fabric). Empty = export disabled
  dataApiKeyNext: env.DATA_API_KEY_NEXT || '', // optional second key, for zero-downtime rotation
};

export const TEST_PASSWORD = 'neumansteel123';

export function assertSafeConfig() {
  const { appEnv, authMode, seedTestData, allowLocalAuthInProd } = config;
  if (!['local', 'staging', 'production'].includes(appEnv)) {
    throw new Error(`APP_ENV must be local, staging or production (got "${appEnv}")`);
  }
  if (!['local', 'gateway'].includes(authMode)) {
    throw new Error(`AUTH_MODE must be local or gateway (got "${authMode}")`);
  }
  if (appEnv === 'production' && seedTestData) {
    throw new Error('SEED_TEST_DATA=true is not allowed when APP_ENV=production');
  }
  if (appEnv === 'production' && authMode === 'local' && !allowLocalAuthInProd) {
    throw new Error('AUTH_MODE=local is not allowed in production. Use AUTH_MODE=gateway (or set ALLOW_LOCAL_AUTH=true knowingly).');
  }
}
