// Command line helpers.
//   npm run create-admin -- you@kantor.go.id "Your Name"   → prints a one-time link to set the password
import { one } from './db.mjs';
import { config } from './config.mjs';
import { createUser, createInvite } from './auth.mjs';

export function bootstrapAdmin() {
  if (one(`SELECT COUNT(*) c FROM users`).c > 0 || !config.adminEmail) return;
  const u = createUser({ email: config.adminEmail, name: '', role: 'admin' });
  console.log(`\nFirst administrator created for ${u.email}.\nOpen this one-time link within 72 hours to set the password:\n  ${createInvite(u.id)}\n`);
}

if (process.argv[1] && process.argv[1].endsWith('cli.mjs')) {
  const [cmd, email, ...name] = process.argv.slice(2);
  if (cmd !== 'create-admin' || !email) { console.log('Usage: npm run create-admin -- <email> [name]'); process.exit(1); }
  const existing = one(`SELECT * FROM users WHERE email=?`, email.toLowerCase());
  const u = existing || createUser({ email, name: name.join(' '), role: 'admin' });
  if (existing) console.log(`${email} already exists; issuing a new password link.`);
  console.log(`Set-password link (valid 72 hours):\n  ${createInvite(u.id)}`);
}
