/* eslint-disable jest/no-export, no-undef */
const crypto = require('crypto');
const { N8NTester } = require('../n8n-workflow-tester');
// require('dotenv').config({ path: '.local.env' });

const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();

const credConfig = {
    POSTGRES_ACCOUNT_USER: process.env.POSTGRES_ACCOUNT_USER,
    POSTGRES_ACCOUNT_DATABASE: process.env.POSTGRES_ACCOUNT_DATABASE,
    POSTGRES_ACCOUNT_HOST: process.env.POSTGRES_ACCOUNT_HOST,
    POSTGRES_ACCOUNT_PORT: process.env.POSTGRES_ACCOUNT_PORT,
    POSTGRES_ACCOUNT_PASSWORD: process.env.POSTGRES_ACCOUNT_PASSWORD
};

// The workflow id in n8n; keep this stable across imports
const WORKFLOW_ID = 'YAHdeeXkYbwOOQJk';
const WORKFLOW_PATH = process.env.WORKFLOWS_PATH + "/YAHdeeXkYbwOOQJk.json";
const CREDS_PATH = process.env.CREDS_PATH;

// If you want to run the webhook test, set an actual URL here or via env
const BASE_URL = process.env.BASE_URL;

const REGISTER_PATH = '/webhook/16bc0461-12ad-4933-bb1d-00e0a3fd8cd9';

async function resetDatabase() {
  await prisma.users.deleteMany();
}

async function sendRequest(path, method, body, headers = {}) {
  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...headers,
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}

// --- n8n tester instance ---
const n8nTester = new N8NTester({
  id: WORKFLOW_ID,
  workflow: WORKFLOW_PATH,
  credentials: CREDS_PATH
});

jest.setTimeout(60_000); // n8n CLI + docker can be a bit slow


if (process.env.ENV === "DEV")
describe('Test My Workflow', () => {
  beforeAll(async () => {
    await n8nTester.addCredential('postgres_account_credentials.json', credConfig);
    await n8nTester.importCredentials();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });


  beforeEach(async () => {
    await resetDatabase();
  });

  afterEach(async () => {
      await n8nTester.restoreWorkflow();
  });

  test('Correct insertion into database', async () => {
    const n8nTest = n8nTester.test();

    const user = crypto.randomUUID().replaceAll('-', '');
    const webhookData = { 
      body: {
        username: user,
        email: `${user}@test.com`,
        password: user,
      }
    };

    // Use CLI path by injecting a Manual Trigger + Edit Fields into the workflow
    n8nTest.setTrigger('Webhook', webhookData);

    const output = await n8nTest.trigger();
    expect(output.executionStatus).toBe('success');

    // Node traces
    expect(output.node('If').data).toStrictEqual(webhookData);

    expect(output.node('Hash Password').data).toHaveProperty("hashed_password");
  
    const hashed_password = output.node('Hash Password').data.hashed_password;
    expect(hashed_password).not.toBe(webhookData.body.password);
    expect(hashed_password.length).toBeGreaterThan(10);

    // Remove Password node still contains user/email under *
    expect(output.node('Remove Password').data.username).toBe(webhookData.body.username);
    expect(output.node('Remove Password').data.email).toBe(webhookData.body.email);
    expect(output.node('Remove Password').data).not.toHaveProperty('hashed_password');
    expect(output.node('Remove Password').data).toHaveProperty('password');

    expect(output.node('Insert rows in a table').executionStatus).toBe('success');

    ['id', 'username', 'email', 'password', 'created_at'].forEach((p) =>
      expect(output.node('Insert rows in a table').data).toHaveProperty(p),
    );

    // Verify user is in the database
    const insertedId = output.node('Insert rows in a table').data.id;
    const dbUser = await prisma.users.findUnique({
      where: { id: insertedId },
      select: { username: true, email: true },
    });

    expect(dbUser.username).toBe(webhookData.body.username);
    expect(dbUser.email).toBe(webhookData.body.email);
  });

 test('Correct insertion into mocked database', async () => {
    const n8nTest = n8nTester.test();

    const user = crypto.randomUUID().replaceAll('-', '');
    const webhookData = { 
      body: {
        username: user,
        email: `${user}@test.com`,
        password: user,
      }
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

    expect(output.node('Insert rows in a table').executionStatus).toBe('success');

    ['id', 'username', 'email', 'password', 'created_at'].forEach((p) =>
      expect(output.node('Insert rows in a table').data).toHaveProperty(p),
    );
  });

   test('Correct insertion into mocked remove password', async () => {
    const n8nTest = n8nTester.test();

    const user = crypto.randomUUID().replaceAll('-', '');
    const webhookData = { 
      body: {
        username: user,
        email: `${user}@test.com`,
        password: user,
      }
    };

    // Replace the DB node with a Set node that emits a fake DB record
    n8nTest.mockNode('Remove Password',
      {
      "username": webhookData.body.username,
      "email": webhookData.body.email,
      "password": webhookData.body.password,
      }
    )

    n8nTest.setTrigger('Webhook', webhookData);

    const output = await n8nTest.trigger();

    expect(output.executionStatus).toBe('success');
    expect(output.node('If').data).toStrictEqual(webhookData);

    expect(output.node('Insert rows in a table').executionStatus).toBe('success');

    ['id', 'username', 'email', 'password', 'created_at'].forEach((p) =>
      expect(output.node('Insert rows in a table').data).toHaveProperty(p),
    );
  });

  test('Wrong insertion into database - no username', async () => {
    const n8nTest = n8nTester.test();

    const user = crypto.randomUUID().replaceAll('-', '');
    const webhookData = { 
      body: {
        username: '',
        email: `${user}@test.com`,
        password: user,
      }
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

if (process.env.ENV === 'STAGING') {
  describe('Running webhook tests (DB insertion)', () => {
    afterAll(async () => {
      await prisma.$disconnect();
    });

    test('Correct insertion into database with webhook', async () => {
      const user = crypto.randomUUID().replaceAll('-', '');
      const payload = {
        username: user,
        email: `${user}@test.com`,
        password: user,
      };

      const response = await sendRequest(REGISTER_PATH, 'POST', payload);

      expect(response.status).toBe(200);
      expect(response.data?.username).toBe(payload.username);
      expect(response.data?.email).toBe(payload.email);

      // Verify user is in the DB
      const dbUser = await prisma.users.findUnique({
        where: { username: payload.username },
        select: { username: true, email: true },
      });

      expect(dbUser.username).toBe(payload.username);
      expect(dbUser.email).toBe(payload.email);

      // Cleanup: delete user
      await prisma.users.delete({
        where: { username: payload.username },
      });
    });
  });
}