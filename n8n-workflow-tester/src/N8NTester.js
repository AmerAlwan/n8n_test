const os = require('os');
const path = require('path');
const fs = require('fs/promises');
const axios = require('axios');
const { runN8n } = require('./cliUtils');
const extractJsonsFromText = require('extract-json-from-string');
const { extractLastJsonObject } = require('./jsonExtract');
const { ExecutionResult } = require('./executionResult');
const { readWorkflow, writeWorkflow, addManualInjection, mockNode } = require('./workflowMutator');

class N8NTest {
  constructor(parent) {
    this.parent = parent;
    this._trigger = null;   // { type: 'trigger', nodeName, data }  OR { type: 'webhook', url, data, method, headers }
    this._mocks = [];       // [{ nodeName, data }]
  }

  setTrigger(nodeName, data) {
    if (this._trigger) throw new Error('Only one trigger/webhook may be set per test');
    this._trigger = { type: 'trigger', nodeName, data };
    return this;
  }

  setWebhook(webhookName, baseUrl, data, { method, headers = {} } = {}) {
    if (this._trigger) throw new Error('Only one trigger/webhook may be set per test');
    if (!baseUrl) throw new Error('You must provide a BASE_URL for the webhook');

    this._trigger = { type: 'webhook', webhookName, baseUrl, data, method, headers };
    return this;
  }

  mockNode(nodeName, data) {
    this._mocks.push({ nodeName, data });
    return this;
  }

  async _importWorkflow(jsonPath) {
    const args = ['import:workflow', '--input', jsonPath, '--overwrite'];
    await runN8n({ runner: this.parent._runner, args });
  }

  async _activateWorkflow() {
    const args = ['activate:workflow', '--id', this.parent.id];
    await runN8n({ runner: this.parent._runner, args });
  }

  async _executeWorkflowRaw() {
    const args = ['execute', '--id', this.parent.id, '--rawOutput'];
    try {
      const { stdout, stderr } = await runN8n({ runner: this.parent._runner, args });
      const parsed = extractJsonsFromText(`${stderr}\n${stdout}`)[0];
      if (!parsed) {
        const snippet = (stdout || stderr || '').slice(-4000);
        throw new Error(`Could not parse n8n CLI JSON output.\n\n-----\n${snippet}\n-----`);
      }
      return new ExecutionResult(parsed);
    } catch (err) {
      // Try to parse output even if CLI failed
      const output = `${err.stderr || ''}\n${err.stdout || ''}`;
      const parsed = extractJsonsFromText(output)[0];
      if (parsed) {
        return new ExecutionResult(parsed);
      }
      console.error('n8n CLI execution failed:', err.stderr || err.message);
      console.error('Full command output:', err.stdout || '', err.stderr || '');
      throw err;
    }
  }

  async trigger() {
    if (!this._trigger || this._trigger.type !== 'trigger') {
      throw new Error('Use setTrigger(...) for CLI-based tests');
    }
    // 1) Start from the original workflow JSON every time
    let wf = await readWorkflow(this.parent.workflowPath);

    // 2) Apply mocks
    for (const m of this._mocks) wf = mockNode(wf, m.nodeName, m.data);

    // 3) Add manual trigger injection
    wf = addManualInjection(wf, this._trigger.nodeName, this._trigger.data);

    // 4) Keep the same ID as configured (so we can execute by id)
    if (this.parent.id) wf.id = this.parent.id;

    // 5) Save to temp and import
    const tmpFile = path.join(this.parent._tmpDir, `wf-${Date.now()}.json`);
    await writeWorkflow(tmpFile, wf);
    await this._importWorkflow(tmpFile);

    // 6) Execute
    const execResult = await this._executeWorkflowRaw();
    return execResult;
  }

  async triggerWebhook() {
    if (!this._trigger || this._trigger.type !== 'webhook') {
      throw new Error('Use setWebhook(...) for webhook-based tests');
    }

    // 1) Load workflow JSON
    let wf = await readWorkflow(this.parent.workflowPath);

    // 2) Apply mocks
    for (const m of this._mocks) wf = mockNode(wf, m.nodeName, m.data);
    if (this.parent.id) wf.id = this.parent.id;

    // 3) Import workflow to n8n
    const tmpFile = path.join(this.parent._tmpDir, `wf-${Date.now()}.json`);
    await writeWorkflow(tmpFile, wf);
    await this._importWorkflow(tmpFile);

    // 4) Activate workflow
    try { await this._activateWorkflow(); } catch (_) {}

    // 5) Resolve webhook URL
    const node = wf.nodes.find(
      n => n.name === this._trigger.webhookName && n.type?.includes('n8n-nodes-base.webhook')
    );
    if (!node) throw new Error(`Webhook node "${this._trigger.webhookName}" not found in workflow JSON`);

    const webhookPath = node.parameters.path;
    if (!webhookPath) throw new Error(`Webhook node "${this._trigger.webhookName}" has no parameters.path`);

    const url = `${this._trigger.baseUrl.replace(/\/$/, '')}/webhook/${webhookPath}`;

    // 6) Fire webhook
    const { data, headers, method } = this._trigger;

    const httpMethod = (method || node.parameters.httpMethod || 'GET').toUpperCase();
    const res = await axios.request({ url, httpMethod, data, headers, validateStatus: () => true });
    return { code: res.status, data: res.data };
  }
}

class N8NTester {
  /**
   * @param {Object} opts
   * @param {string} opts.id - workflow id in n8n
   * @param {string} opts.workflow - path to exported workflow JSON (the ORIGINAL)
   * @param {string} [opts.credentials] - path to exported credentials JSON (optional)
   */
  constructor(opts) {
    if (!opts || !opts.id || !opts.workflow) {
      throw new Error('N8NTester requires { id, workflow }');
    }
    this.id = opts.id;
    this.workflowPath = opts.workflow;
    this.credentialsPath = opts.credentials || null;
    this._runner = process.env.N8N_CONTAINER_NAME || null;
    this._tmpDir = path.join(os.tmpdir(), `n8n-tester-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    this._credsPatch = []; // { name, data }
  }

  test() {
    return new N8NTest(this);
  }

  async restoreWorkflow() {
    await runN8n({
      runner: this._runner,
      args: ['import:workflow', '--input', this.workflowPath, '--overwrite'],
    });
  }

  /**
   * Queue a credentials patch so that on import we overwrite with test values.
   * (Caller supplies an exported credentials JSON file via constructor)
   */
  async setCredential(name, data) {
    if (!this.credentialsPath) throw new Error('No credentials file provided to N8NTester constructor');
    this._credsPatch.push({ name, data });
    await this._importCredentials(); // import immediately for simplicity
  }

  async _importCredentials() {
    let raw = await fs.readFile(this.credentialsPath, 'utf8');
    this._credsPatch.forEach(p => {
      Object.entries(p.data).forEach(([k, v]) => {
        raw = raw.replaceAll(`$${k}`, v); // simple string replace for any $() references
      })
    })
    // Expected export format: array of creds. We patch by name.
    // const patched = Array.isArray(raw) ? raw.map(c => {
    //   if (this._credsPatch.find(p => p.name === c.name)) {
    //     const patch = this._credsPatch.find(p => p.name === c.name);
    //     // For many node creds, the values live in c.data
    //     // We replace the "data" block entirely with the supplied plain object.
    //     return { ...c, data: patch.data };
    //   }
    //   return c;
    // }) : raw;
    const out = path.join(this._tmpDir, `creds-${Date.now()}.json`);
    await fs.mkdir(this._tmpDir, { recursive: true });
    await fs.writeFile(out, raw, 'utf8');

    // Import via CLI
    await runN8n({ runner: this._runner, args: ['import:credentials', '--input', out, '--overwrite'] });
  }
}

module.exports = N8NTester;
