const fs = require('fs/promises');
const path = require('path');
const crypto = require('crypto');

function deepClone(obj) {
  return JSON.parse(JSON.stringify(obj));
}

function findNodeByName(workflow, name) {
  return workflow.nodes.find(n => n.name === name);
}

function ensureConnections(workflow) {
  if (!workflow.connections) workflow.connections = {};
  return workflow.connections;
}

function makeSetNode({ name, json }) {
  return {
    parameters: {
      mode: 'raw',
      jsonOutput: JSON.stringify(json, null, 2),
      options: {},
    },
    type: 'n8n-nodes-base.set',
    typeVersion: 3.4,
    position: [224, -192],
    id: crypto.randomUUID(),
    name,
  };
}

function makeManualTriggerNode({ name = 'Manual Trigger (tester)' }) {
  return {
    parameters: {},
    type: 'n8n-nodes-base.manualTrigger',
    typeVersion: 1,
    position: [0, -192],
    id: crypto.randomUUID(),
    name,
  };
}

/**
 * Replace a node with a Set (Edit Fields) node that outputs fixed JSON.
 * - Rewire incoming edges to point to the mock node
 * - Reuse the mocked node's outgoing connections on the mock node
 */
function mockNode(workflow, nodeName, data) {
  const wf = deepClone(workflow);
  const target = findNodeByName(wf, nodeName);
  if (!target) throw new Error(`mockNode: node "${nodeName}" not found`);
  const mockName = nodeName;
  const mock = makeSetNode({ name: mockName, json: data });
  wf.nodes.push(mock);

  const conns = ensureConnections(wf);

  // 1) Rewire incoming edges to point to mock
  for (const [fromName, fromSpec] of Object.entries(conns)) {
    const mains = fromSpec?.main || [];
    mains.forEach((outArr) => {
      outArr.forEach((link) => {
        if (link.node === nodeName) link.node = mockName;
      });
    });
  }

  // 2) Mock node should have the same outgoing edges as original
  if (conns[nodeName]) {
    conns[mockName] = deepClone(conns[nodeName]);
  }

  // 3) Optionally neuter original node's outgoing connections
  conns[nodeName] = { main: [ [] ] };

  return wf;
}

/**
 * Inject a Manual Trigger + Set(&raw JSON) chain that feeds the same target as the real trigger.
 * This does NOT remove the original trigger; it just adds a separate path for CLI execution.
 */
function addManualInjection(workflow, originalTriggerName, injectedJson) {
  const wf = deepClone(workflow);
  const trigger = findNodeByName(wf, originalTriggerName);
  if (!trigger) throw new Error(`setTrigger: trigger node "${originalTriggerName}" not found`);

  const conns = ensureConnections(wf);
  const triggerConn = conns[originalTriggerName]?.main?.[0]?.[0];
  if (!triggerConn) throw new Error(`Trigger node "${originalTriggerName}" appears unconnected on output 0`);

  const targetNodeName = triggerConn.node;

  const manual = makeManualTriggerNode({});
  const edit = makeSetNode({ name: 'Edit Fields (tester)', json: injectedJson });
  // place reasonably
  manual.position = [0, -192];
  edit.position = [224, -192];

  wf.nodes.push(manual);
  wf.nodes.push(edit);

  conns[manual.name] = { main: [[{ node: edit.name, type: 'main', index: 0 }]] };
  conns[edit.name] = { main: [[{ node: targetNodeName, type: 'main', index: 0 }]] };

  return wf;
}

async function readWorkflow(file) {
  const json = JSON.parse(await fs.readFile(file, 'utf8'));
  return json;
}

async function writeWorkflow(file, wf) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(wf, null, 2), 'utf8');
  return file;
}

module.exports = {
  readWorkflow,
  writeWorkflow,
  addManualInjection,
  mockNode,
};
