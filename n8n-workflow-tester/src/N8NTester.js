const os = require('os');
const path = require('path');
const fs = require('fs/promises');
const { runN8n } = require('./cliUtils');
const { extractLastJsonObject } = require('./jsonExtract');
const { ExecutionResult } = require('./executionResult');
const { readWorkflow, writeWorkflow, addManualInjection, mockNode } = require('./workflowMutator');
const extractJsonsFromText = require('extract-json-from-string');
const N8NClient = require('./N8NClient');

class N8NTest {
  constructor(parent) {
    this.parent = parent;
    this._trigger = null;
    this._mocks = [];
  }

  setTrigger(nodeName, data) {
    if (this._trigger) throw new Error('Only one trigger/webhook may be set per test');
    this._trigger = { type: 'trigger', nodeName, data };
    return this;
  }

  mockNode(nodeName, data) {
    this._mocks.push({ nodeName, data });
    return this;
  }

  async _importWorkflow(jsonPath) {
    const args = ['import:workflow', '--input', jsonPath, '--overwrite'];
    await runN8n(N8NClient.getContainer(), args);
  }

  async _activateWorkflow() {
    const args = ['activate:workflow', '--id', this.parent.id];
    await runN8n(N8NClient.getContainer(), args);
  }

  async _executeWorkflowRaw() {
    const args = ['execute', '--id', this.parent.id, '--rawOutput'];
    try {
      const { stdout, stderr } = await runN8n(N8NClient.getContainer(), args);
      const parsed = extractJsonsFromText(`${stderr}\n${stdout}`)[0];
      if (!parsed) {
        const snippet = (stdout || stderr || '').slice(-4000);
        throw new Error(`Could not parse n8n CLI JSON output.\n\n-----\n${snippet}\n-----`);
      }
      return new ExecutionResult(parsed);
    } catch (err) {
      // Try to parse output even if CLI failed so user can test for errors
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
    if (!this._trigger) {
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
}

class N8NTester {
  constructor(workflow) {
    this.workflowPath = workflow;
    this.id = this.getWorkflowId(workflow);
    this._tmpDir = path.join(os.tmpdir(), `n8n-tester-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  }

  test() {
    return new N8NTest(this);
  }

getWorkflowId(filePath) {
  try {
    const absPath = path.resolve(filePath);
    const raw = fs.readFileSync(absPath, "utf-8");
    const json = JSON.parse(raw);

    if (!json.id) {
      console.warn(`No "id" field found in workflow file: ${filePath}`);
      return null;
    }

    return json.id;
  } catch (err) {
    console.error(`Failed to read or parse workflow file: ${filePath}`, err.message);
    return null;
  }
}

  async restoreWorkflow() {
    await runN8n(
      N8NClient.getContainer(),
      ['import:workflow', '--input', this.workflowPath, '--overwrite'],
    );
  }
}

module.exports = N8NTester;
