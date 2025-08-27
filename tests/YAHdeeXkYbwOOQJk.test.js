/* eslint-disable jest/no-export, no-undef */
const { Client } = require('pg');
const crypto = require('crypto');
const { N8NTester } = require('../n8n-workflow-tester');
// require('dotenv').config({ path: __dirname + '/../.local.env' });


// --- config you can tweak ---
const dbConfig = {
  user: process.env.POSTGRES_ACCOUNT_USER || 'admin',
  host: process.env.POSTGRES_ACCOUNT_HOST || 'db',
  database: process.env.POSTGRES_ACCOUNT_DATABASE || 'test',
  password: process.env.POSTGRES_ACCOUNT_PASSWORD || 'admin',
  port: process.env.POSTGRES_ACCOUNT_PORT || 5432
};

// The workflow id in n8n; keep this stable across imports
const WORKFLOW_ID = 'YAHdeeXkYbwOOQJk';
const WORKFLOW_PATH = process.env.WORKFLOWS_PATH ? __dirname + "../" + process.env.WORKFLOWS_PATH + "/YAHdeeXkYbwOOQJk.json" : __dirname + '/../workflows/YAHdeeXkYbwOOQJk.json';
const CREDS_PATH = process.env.CREDS_PATH ? __dirname + "../" + process.env.CREDS_PATH : __dirname + '/../credentials/credentials.json';

// If you run n8n in docker, set container name/id here or via env
const RUNNER = { type: 'local' };

// If you want to run the webhook test, set an actual URL here or via env
const WEBHOOK_URL = process.env.WEBHOOK_URL || 'http://localhost:5678/webhook/16bc0461-12ad-4933-bb1d-00e0a3fd8cd9'

// --- pg client ---
const client = new Client(dbConfig);

// --- helper to reset db for these tests ---
async function resetDatabase() {
  // adjust if your schema differs
  await client.query('TRUNCATE TABLE users RESTART IDENTITY;');
}

// --- n8n tester instance ---
const n8nTester = new N8NTester({
  id: WORKFLOW_ID,
  workflow: WORKFLOW_PATH,
  credentials: CREDS_PATH,
  runner: RUNNER,
});

jest.setTimeout(60_000); // n8n CLI + docker can be a bit slow

describe('Test My Workflow', () => {
  beforeAll(async () => {
    await client.connect();
    // Patch and import credentials (by name) so n8n uses our test DB
    await n8nTester.setCredential('Postgres account', {
		POSTGRES_ACCOUNT_USER: dbConfig['user'],
		POSTGRES_ACCOUNT_DATABASE: dbConfig['database'],
		POSTGRES_ACCOUNT_HOST: dbConfig['host'],
		POSTGRES_ACCOUNT_PORT: dbConfig['port'],
		POSTGRES_ACCOUNT_PASSWORD: dbConfig['password']
	});
  });

  beforeEach(async () => {
    await resetDatabase();
  });

  afterAll(async () => {
    await client.end();
  });

  test('Correct insertion into database', async () => {
    const n8nTest = n8nTester.test();

    const user = crypto.randomUUID().replaceAll('-', '');
    const webhookData = {
      body: {
        username: user,
        email: `${user}@test.com`,
        password: user,
      },
    };

    // Use CLI path by injecting a Manual Trigger + Edit Fields into the workflow
    n8nTest.setTrigger('Webhook', webhookData);

    const output = await n8nTest.trigger();

    expect(output.executionStatus).toBe('success');

    // Node traces
    expect(output.node('If').data).toStrictEqual(webhookData);
    expect(output.node('Remove Password').data).toStrictEqual({
      body: { ...webhookData.body, password: '' },
    });

    expect(output.node('Insert rows in a table').executionStatus).toBe('success');

    ['id', 'username', 'email', 'password', 'created_at'].forEach((p) =>
      expect(output.node('Insert rows in a table').data).toHaveProperty(p),
    );

    // Remove Password node still contains user/email under body.*
    expect(output.node('Remove Password').data.body.username).toBe(webhookData.body.username);
    expect(output.node('Remove Password').data.body.email).toBe(webhookData.body.email);

    // Verify DB
    const insertedId = output.node('Insert rows in a table').data.id;
    const { rows } = await client.query(
      'SELECT username, email FROM users WHERE id = $1',
      [insertedId],
    );
    const dbUser = rows[0];
    expect(dbUser.username).toBe(webhookData.body.username);
    expect(dbUser.email).toBe(webhookData.body.email);
  });

  /* test('Correct insertion into database with webhook', async () => {
    const n8nTest = n8nTester.test();

    const user = crypto.randomUUID().replaceAll('-', '');
    const webhookData = {
      body: {
        username: user,
        email: `${user}@test.com`,
        password: user,
      },
    };

    n8nTest.setWebhook({ url: WEBHOOK_URL, data: webhookData });

    const response = await n8nTest.triggerWebhook();
	
	console.log(response.code)

    // With webhooks, you only have the HTTP response – no per-node traces.
    expect(response.code).toBe(204); // adjust if your webhook returns something else
    expect(response.data).toStrictEqual(webhookData);
  });*/
  

 test('Correct insertion into mocked database', async () => {
    const n8nTest = n8nTester.test();

    const user = crypto.randomUUID().replaceAll('-', '');
    const webhookData = {
      body: {
        username: user,
        email: `${user}@test.com`,
        password: user,
      },
    };

    // Replace the DB node with a Set node that emits a fake DB record
    n8nTest.mockNode('Insert rows in a table', {
      id: user,
      username: webhookData.body.username,
      email: webhookData.body.email,
      password: webhookData.body.password,
      created_at: new Date().toISOString(),
    });

    n8nTest.setTrigger('Webhook', webhookData);

    const output = await n8nTest.trigger();

    expect(output.executionStatus).toBe('success');
    expect(output.node('If').data).toStrictEqual(webhookData);

    expect(output.node('Remove Password').data).toStrictEqual({
      body: { ...webhookData.body, password: '' },
    });

    expect(output.node('Insert rows in a table').executionStatus).toBe('success');

    ['id', 'username', 'email', 'password', 'created_at'].forEach((p) =>
      expect(output.node('Insert rows in a table').data).toHaveProperty(p),
    );

    expect(output.node('Remove Password').data.body.username).toBe(webhookData.body.username);
    expect(output.node('Remove Password').data.body.email).toBe(webhookData.body.email);
  });

  test('Wrong insertion into database - no username', async () => {
    const n8nTest = n8nTester.test();

    const user = crypto.randomUUID().replaceAll('-', '');
    const webhookData = {
      body: {
        username: '',
        email: `${user}@test.com`,
        password: user,
      },
    };

    n8nTest.setTrigger('Webhook', webhookData);

    const output = await n8nTest.trigger();

    expect(output.executionStatus).toBe('error');
	expect(output.errorMessage).toBe('Invalid parameters');
	
    expect(output.node('If').getData(1)).toStrictEqual(webhookData);

    const stop = output.node('Stop and Error');
    expect(stop.executionStatus).toBe('error');
    expect(stop.errorMessage).toBe('Invalid parameters');
  });
});
