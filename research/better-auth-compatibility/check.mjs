import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { betterAuth } from 'better-auth';
import { memoryAdapter } from 'better-auth/adapters/memory';
import { username } from 'better-auth/plugins';

process.env.BETTER_AUTH_TELEMETRY_DISABLED = '1';
const database = { user: [], account: [], session: [], verification: [], rateLimit: [] };
const baseURL = 'http://localhost:3000';
const auth = betterAuth({
  baseURL,
  secret: randomBytes(32).toString('hex'),
  database: memoryAdapter(database),
  emailAndPassword: { enabled: true },
  plugins: [username()],
  telemetry: { enabled: false },
});

async function post(path, body) {
  return auth.handler(new Request(`${baseURL}/api/auth${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: baseURL },
    body: JSON.stringify(body),
  }));
}

const password = 'test-only-example-password';
const noEmail = await post('/sign-up/email', { username: 'testadmin', name: 'Test', password });
assert.equal(noEmail.status, 400, 'signup without an email should be rejected');
assert.equal(database.user.length, 0);
console.log('PASS: a username-only signup without email was rejected');

const signup = await post('/sign-up/email', {
  username: 'testadmin', name: 'Test', email: 'testadmin@example.test', password,
});
assert.equal(signup.status, 200, 'email signup should succeed in memory');
assert.equal(database.user.length, 1);
assert.equal(database.account.length, 1);

const wrongPassword = await post('/sign-in/username', { username: 'testadmin', password: 'not-the-password' });
assert.equal(wrongPassword.status, 401);
console.log('PASS: a wrong password was rejected');

const signin = await post('/sign-in/username', { username: 'testadmin', password });
assert.equal(signin.status, 200, 'username sign-in should succeed');
const response = await signin.json();
assert.ok(response.token, 'sign-in should return a session token');
assert.ok(database.session.some((session) => session.token === response.token), 'stored session token should match the returned token');
assert.ok(database.account[0].password && database.account[0].password !== password);
console.log('PASS: username login worked after creating an account with an email');
console.log('PASS: the default memory adapter stored the returned session token verbatim');
console.log('PASS: password was not stored as plaintext');
