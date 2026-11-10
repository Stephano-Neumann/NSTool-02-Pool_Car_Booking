import express from 'express';
import helmet from 'helmet';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from './config.js';
import { attachUser, requireCsrfHeader } from './auth.js';
import { authRoutes } from './routes/auth.js';
import { fleetRoutes } from './routes/fleet.js';
import { adminRoutes } from './routes/admin.js';
import { companyCarRoutes } from './routes/companycar.js';
import { incidentRoutes } from './routes/incidents.js';
import { exportRoutes } from './routes/export.js';
import { log } from './util.js';

const publicDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');

export function createApp(db) {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1); // Container Apps terminates TLS in front of us

  app.use(helmet({
    contentSecurityPolicy: {
      useDefaults: false,
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
        fontSrc: ['https://fonts.gstatic.com'],
        imgSrc: ["'self'", 'data:'],
        connectSrc: ["'self'"],
        objectSrc: ["'none'"],
        frameAncestors: ["'none'"],
        baseUri: ["'self'"],
        formAction: ["'self'"],
      },
    },
  }));

  // Unauthenticated liveness check for the deploy pipeline and container probes.
  app.get('/health', (req, res) => {
    try {
      db.prepare('SELECT 1').get();
      res.json({ status: 'ok', version: config.version, env: config.appEnv });
    } catch (e) {
      log('error', 'health check failed', { error: e.message });
      res.status(503).json({ status: 'error' });
    }
  });

  // Data Export API: authenticated by API key only. Mounted before attachUser and the CSRF check so a
  // forged sign-in header on /api/export/* can never create or read a user.
  app.use('/api', exportRoutes(db));
  app.use('/api', express.json({ limit: '100kb' }), attachUser(db), requireCsrfHeader);
  app.use('/api', authRoutes(db), fleetRoutes(db), adminRoutes(db), companyCarRoutes(db), incidentRoutes(db));
  app.use('/api', (req, res) => res.status(404).json({ error: 'Not found.' }));

  // Separate admin page. Local mode: the password sign-in page (public/app.js shows the form only on this path).
  // Gateway mode: only signed-in admins are served the app here; everyone else gets a no-access page.
  app.get(['/nsadmin', '/nsadmin/'], attachUser(db), (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    if (config.authMode === 'gateway' && req.user?.role !== 'admin') {
      return res.status(403).type('html').send(
        '<!doctype html><meta charset="utf-8"><title>No access</title>' +
        '<body style="font-family:sans-serif;max-width:32rem;margin:4rem auto;padding:0 1rem">' +
        '<h1>No access</h1><p>This page is for administrators. If you need admin rights, ask your administrator.</p>' +
        '<p><a href="/">Back to the company car booking</a></p></body>');
    }
    res.sendFile(path.join(publicDir, 'index.html'));
  });

  app.use(express.static(publicDir, {
    setHeaders: (res, file) => {
      if (file.endsWith('.html') || file.endsWith('.js') || file.endsWith('.css')) res.setHeader('Cache-Control', 'no-cache');
    },
  }));

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    const status = err.status || err.statusCode || 500;
    if (status >= 500) log('error', 'unhandled error', { path: req.path, error: err.message, stack: err.stack });
    const message = status >= 500 ? 'Something went wrong. Please try again.'
      : err.type === 'entity.too.large' ? 'That file is too large (5MB limit).'
      : err.type === 'entity.parse.failed' ? 'Invalid request.'
      : err.message;
    res.status(status).json({ error: message });
  });

  return app;
}
