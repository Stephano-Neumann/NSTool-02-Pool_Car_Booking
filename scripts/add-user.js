// Create or update a local-auth user:
//   node scripts/add-user.js <email> "<Full Name>" <admin|driver> <password>
// In a container: docker compose exec app node scripts/add-user.js ...
import { openDb } from '../src/db.js';
import { hashPassword, nowIso, EMAIL_RE } from '../src/util.js';

const [email, name, role, password] = process.argv.slice(2);
if (!email || !name || !['admin', 'driver'].includes(role) || !password) {
  console.error('Usage: node scripts/add-user.js <email> "<Full Name>" <admin|driver> <password>');
  process.exit(1);
}
if (!EMAIL_RE.test(email)) { console.error('Invalid email address.'); process.exit(1); }
if (password.length < 8) { console.error('Password must be at least 8 characters.'); process.exit(1); }

const db = openDb();
db.prepare(`INSERT INTO users (email, name, role, password_hash, created_at) VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(email) DO UPDATE SET name = excluded.name, role = excluded.role,
              password_hash = excluded.password_hash, active = 1`)
  .run(email, name, role, await hashPassword(password), nowIso());
console.log(`User ${email} saved as ${role}.`);
