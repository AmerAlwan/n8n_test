const { Client } = require('pg');
const crypto = require('crypto');
const { N8NTester } = require('../n8n-workflow-tester');
// require('dotenv').config({ path: '.local.env' });

jest.setTimeout(60_000);

const dbConfig = {
  user: process.env.POSTGRES_ACCOUNT_USER,
  host: process.env.POSTGRES_ACCOUNT_HOST,
  database: process.env.POSTGRES_ACCOUNT_DATABASE,
  password: process.env.POSTGRES_ACCOUNT_PASSWORD,
  port: process.env.POSTGRES_ACCOUNT_PORT
};

const credConfig = {
    POSTGRES_ACCOUNT_USER: dbConfig['user'],
    POSTGRES_ACCOUNT_DATABASE: dbConfig['database'],
    POSTGRES_ACCOUNT_HOST: dbConfig['host'],
    POSTGRES_ACCOUNT_PORT: dbConfig['port'],
    POSTGRES_ACCOUNT_PASSWORD: dbConfig['password']
};

const client = new Client(dbConfig);

client.connect();

const REGISTER_WORKFLOW_ID = 'YAHdeeXkYbwOOQJk';
const LOGIN_WORKFLOW_ID = '8QAHX43zY6aIlsqj';
const GET_USER_EMAIL_WORKFLOW_ID = 'RqijrHvyKSEwP50q';
const AUTHENTICATE_USER_WORKFLOW_ID = '8xNhUaWFEW8XHn3t';

const REGISTER_WORKFLOW_PATH = process.env.WORKFLOWS_PATH + '/YAHdeeXkYbwOOQJk.json';
const LOGIN_WORKFLOW_PATH = process.env.WORKFLOWS_PATH + '/8QAHX43zY6aIlsqj.json';
const GET_USER_EMAIL_WORKFLOW_PATH = process.env.WORKFLOWS_PATH + '/RqijrHvyKSEwP50q.json';
const AUTHENTICATE_USER_WORKFLOW_PATH = process.env.WORKFLOWS_PATH + '/8xNhUaWFEW8XHn3t.json';

const CREDS_PATH = process.env.CREDS_PATH;

const BASE_URL = process.env.BASE_URL;

const LOGIN_PATH    = '/webhook/0691ab98-d0a1-431a-a8a2-082fc85ff260';
const REGISTER_PATH    = '/webhook/16bc0461-12ad-4933-bb1d-00e0a3fd8cd9';
const EMAIL_PATH = '/webhook/2a93d317-0a2b-4bc4-a95b-2825084d0055';

const registerTester = new N8NTester({
  id: REGISTER_WORKFLOW_ID,
  workflow: REGISTER_WORKFLOW_PATH,
  credentials: CREDS_PATH
});

const loginTester = new N8NTester({
  id: LOGIN_WORKFLOW_ID,
  workflow: LOGIN_WORKFLOW_PATH,
  credentials: CREDS_PATH
});

const getUserEmailTester = new N8NTester({
  id: GET_USER_EMAIL_WORKFLOW_ID,
  workflow: GET_USER_EMAIL_WORKFLOW_PATH,
  credentials: CREDS_PATH
});

const authenticateUserTester = new N8NTester({
  id: AUTHENTICATE_USER_WORKFLOW_ID,
  workflow: AUTHENTICATE_USER_WORKFLOW_PATH,
  credentials: CREDS_PATH 
});

const testUser = {
    username: "testuser",
    email: "testuser@test.com",
    password: "password"
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

const calculateJWT = (header, payload, secret) => {
    const base64Header = Buffer.from(JSON.stringify(header)).toString('base64url');
    const base64Payload = Buffer.from(JSON.stringify(payload)).toString('base64url');
    const signature = crypto.createHmac('sha256', secret)
        .update(`${base64Header}.${base64Payload}`)
        .digest('base64');
    return `${base64Header}.${base64Payload}.${signature}`;
}

async function createUserInDb() {
    const n8nTest = registerTester.test();   
    const data = {
        body: testUser
    }
    n8nTest.setTrigger('Webhook', data);
    await n8nTest.trigger();
}

if (process.env.ENV === "DEV") {
describe('Test user login workflow', () => {
    beforeAll(async () => {
        await registerTester.setCredential('Postgres account', credConfig);
        await loginTester.setCredential('Postgres account', credConfig);
        await createUserInDb();
    });
    afterEach(async () => {
        
        await registerTester.restoreWorkflow();
        await loginTester.restoreWorkflow();
    }); 

    test('Correct login', async () => {
        const n8nTest = loginTester.test(); 
        const data = {
            body: {
                username: testUser.username,
                password: testUser.password
            }
        }
        n8nTest.setTrigger('Webhook', data);
        const output = await n8nTest.trigger();
        
        expect(output.node('If user exists').data).toBeDefined();   
        expect(output.node('If user exists').data.username).toBe(testUser.username);

        expect(output.node('Merge').data).toHaveProperty('login_hashed_password');
        expect(output.node('Merge').data).toHaveProperty('actual_hashed_password');

        expect(output.node('If hashed passwords equal').data).toBeDefined();

        expect(output.node('Assemble JWT token').data).toHaveProperty('jwt');

        const exp = JSON.parse(Buffer.from(output.node('Create payload').data.payload, 'base64url').toString('utf8')).exp;

        const expected_jwt = calculateJWT(
            { alg: "HS256", typ: "JWT" },
            { username: testUser.username, exp: exp },
            "secret"
        );
        expect(output.node('Respond to Webhook1').data.jwt).toBe(expected_jwt);
    });
});

describe('Test authenticate user workflow', () => {
    beforeAll(async () => {
        await authenticateUserTester.setCredential('Postgres account', credConfig); 
        await createUserInDb();
    });

    afterEach(async () => {
        await authenticateUserTester.restoreWorkflow();
    });

    test('Correct authentication', async () => {
        const n8nTest = authenticateUserTester.test();
        const jwt_token = calculateJWT(
            { alg: "HS256", typ: "JWT" },
            { username: testUser.username, exp: Math.floor(Date.now() / 1000) + (60 * 60) },
            "secret"
        );
        n8nTest.setTrigger('When Executed by Another Workflow', {'jwt': jwt_token});
        const output = await n8nTest.trigger();

        expect(output.executionStatus).toBe('success');
        expect(output.node('Return username').data).toBeDefined();
        expect(output.node('Return username').data.authenticated).toBe(true);
        expect(output.node('Return username').data.username).toBe(testUser.username);
    });

    test('Expired token', async () => {
        const n8nTest = authenticateUserTester.test(); 
        const jwt_token = calculateJWT(
            { alg: "HS256", typ: "JWT" },
            { username: testUser.username, exp: Math.floor(Date.now() / 1000) - 5 * (60 * 60 * 24) },
            "secret"
        );
        n8nTest.setTrigger('When Executed by Another Workflow', {'jwt': jwt_token});
        const output = await n8nTest.trigger();

        expect(output.executionStatus).toBe('success');
        expect(output.node('Return unauthenticated').data).toBeDefined();
        expect(output.node('Return unauthenticated').data.authenticated).toBe(false);
    });

    test('Invalid token', async () => {
        const n8nTest = authenticateUserTester.test(); 
        const jwt_token = "invalid.token.value";
        n8nTest.setTrigger('When Executed by Another Workflow', {'jwt': jwt_token});
        const output = await n8nTest.trigger(); 
        
        expect(output.executionStatus).toBe('success');
        expect(output.node('Return unauthenticated').data).toBeDefined();
        expect(output.node('Return unauthenticated').data.authenticated).toBe(false);
    });
});

describe('Test get user email workflow', () => {
    beforeAll(async () => {
        await getUserEmailTester.setCredential('Postgres account', credConfig);
        await createUserInDb();
    });

    afterEach(async () => {
        await getUserEmailTester.restoreWorkflow();
    });

    test('Correct get user email', async () => {
        const n8nTest = getUserEmailTester.test();
        const jwt_token = calculateJWT(
            { alg: "HS256", typ: "JWT" },
            { username: testUser.username, exp: Math.floor(Date.now() / 1000) + (60 * 60) },
            "secret"
        );
        n8nTest.setTrigger('Webhook', {'body': {'jwt': jwt_token}});
        const output = await n8nTest.trigger();
        expect(output.executionStatus).toBe('success');
        expect(output.node('Return email').data).toBeDefined(); 
        expect(output.node('Return email').data.email).toBe(testUser.email);
    });
    test('Invalid token get user email', async () => {
        const n8nTest = getUserEmailTester.test();
        const jwt_token = "invalid.token.value";
        n8nTest.setTrigger('Webhook', {'body': {'jwt': jwt_token}});
        const output = await n8nTest.trigger();
        expect(output.executionStatus).toBe('success');
        expect(output.node('Return unauthorized').data).toBeDefined();
        expect(output.node('Return unauthorized').data.authenticated).toBe(false);
    });
});

describe ('Test all workflows combined', () => {
    beforeAll(async () => {
        await registerTester.setCredential('Postgres account', credConfig);
        await loginTester.setCredential('Postgres account', credConfig);
        await getUserEmailTester.setCredential('Postgres account', credConfig);
        await authenticateUserTester.setCredential('Postgres account', credConfig); 
        await createUserInDb();
    });

    afterEach(async () => {
        await registerTester.restoreWorkflow();
        await loginTester.restoreWorkflow();
        await getUserEmailTester.restoreWorkflow();
        await authenticateUserTester.restoreWorkflow();
    });

    test('Correct login and get user email', async () => {
        const loginTest = loginTester.test();
        const loginData = {
            body: {
                username: testUser.username,
                password: testUser.password
            }
        };
        loginTest.setTrigger('Webhook', loginData);
        
        const loginOutput = await loginTest.trigger();

        expect(loginOutput.executionStatus).toBe('success');

        const jwt_token = loginOutput.node('Respond to Webhook1').data.jwt;

        const authenticateTest = authenticateUserTester.test();

        authenticateTest.setTrigger('When Executed by Another Workflow', {'jwt': jwt_token});
        const authenticateOutput = await authenticateTest.trigger();

        expect(authenticateOutput.executionStatus).toBe('success');
        expect(authenticateOutput.node('Return username').data).toBeDefined();
        expect(authenticateOutput.node('Return username').data.username).toBe(testUser.username);

        const getUserEmailTest = getUserEmailTester.test();

        getUserEmailTest.setTrigger('Webhook', {'body': {'jwt': jwt_token}});
        
        const getUserEmailOutput = await getUserEmailTest.trigger();

        expect(getUserEmailOutput.executionStatus).toBe('success');
        expect(getUserEmailOutput.node('Return email').data).toBeDefined();
        expect(getUserEmailOutput.node('Return email').data.email).toBe(testUser.email);    
    });
});
}

if (process.env.ENV === 'STAGING') {
  describe('Running webhook tests (direct HTTP)', () => {
    test('Correct login with webhook', async () => {
      const user = crypto.randomUUID().replaceAll('-', '');
      const payload = {
        username: user,
        email: `${user}@test.com`,
        password: user,
      };

      // 1) Register
      const registerResp = await sendRequest(REGISTER_PATH, 'POST', payload);
      expect([200, 201]).toContain(registerResp.status);

      // 2) Login
      const loginResp = await sendRequest(LOGIN_PATH, 'POST', {
        username: payload.username,
        password: payload.password,
      });

      expect(loginResp.status).toBe(200);
      const jwt_token = loginResp.data?.jwt;
      expect(jwt_token).toBeDefined();
    });

    test('login Unknown User with webhook', async () => {
      const user = crypto.randomUUID().replaceAll('-', '');
      const payload = {
        username: user,
        email: `${user}@test.com`,
        password: user,
      };

      const loginResp = await sendRequest(LOGIN_PATH, 'POST', {
        username: payload.username,
        password: payload.password,
      });

      expect(loginResp.status).toBe(401);
    });

    test('Correct get email with webhook', async () => {
      const user = crypto.randomUUID().replaceAll('-', '');
      const payload = {
        username: user,
        email: `${user}@test.com`,
        password: user,
      };

      // 1) Register
      const registerResp = await sendRequest(REGISTER_PATH, 'POST', payload);
      expect([200, 201]).toContain(registerResp.status);

      // 2) Login
      const loginResp = await sendRequest(LOGIN_PATH, 'POST', {
        username: payload.username,
        password: payload.password,
      });
      expect(loginResp.status).toBe(200);

      const jwt_token = loginResp.data?.jwt;
      expect(jwt_token).toBeDefined();

      const emailResp = await sendRequest(EMAIL_PATH, 'POST', { jwt: jwt_token });

      expect(emailResp.status).toBe(200);
      expect(emailResp.data?.email).toBe(payload.email);
    });
  });
}

client.end();