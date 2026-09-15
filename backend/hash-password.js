// ============================================================
// One-time helper to generate the bcrypt hash for your first admin's
// temporary password, so you never have to put a plaintext password
// into the database.
//
// Setup (run once, needs Node.js installed):
//   npm install bcryptjs
//
// Usage:
//   node hash-password.js "TheTempPasswordYouChoose"
//
// Copy the printed hash into schema.sql where it says
// <PASTE_BCRYPT_HASH_FROM_hash-password.js_HERE>, then give the admin the
// PLAINTEXT password you passed in here (not the hash) to log in with the
// first time. They'll be forced to set their own permanent password
// immediately after.
// ============================================================

const bcrypt = require('bcryptjs');

const password = process.argv[2];
if (!password) {
  console.error('Usage: node hash-password.js "YourTempPassword"');
  process.exit(1);
}

const hash = bcrypt.hashSync(password, 10);
console.log('\nBcrypt hash (paste this into schema.sql):\n');
console.log(hash);
console.log('\nPlaintext password (give this to the admin to log in with):\n');
console.log(password);
console.log('');
