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

  // Overwrite the node in-place
  target.type = 'n8n-nodes-base.set';
  target.typeVersion = 3.4;
  target.parameters = {
    mode: 'raw',
    jsonOutput: JSON.stringify(data, null, 2),
    options: {},
  };

  return wf;
}

/**
 * Inject a Manual Trigger + Set(&raw JSON) chain that feeds the same targets as the real trigger.
 * Additionally:
 *  - The original trigger node is renamed to "<original>-original" (uniqued if needed).
 *  - The new Edit node takes the original trigger's *exact* name.
 * The original trigger path remains; this only adds a parallel manual path.
 */
function addManualInjection(workflow, originalTriggerName, injectedJson) {
  const wf = deepClone(workflow);
  const trigger = findNodeByName(wf, originalTriggerName);
  if (!trigger) throw new Error(`setTrigger: trigger node "${originalTriggerName}" not found`);

  const conns = ensureConnections(wf);

  // Helper: make a unique node name within the workflow
  const uniqueName = (base) => {
    const existing = new Set((wf.nodes || []).map(n => n.name));
    if (!existing.has(base)) return base;
    let i = 1;
    let candidate = `${base}-${i}`;
    while (existing.has(candidate)) {
      i += 1;
      candidate = `${base}-${i}`;
    }
    return candidate;
  };

  // Collect ALL outgoing links from the original trigger across all outputs (before renaming).
  const outgoing = (conns[originalTriggerName]?.main || []);
  const allLinks = [];
  for (let outIdx = 0; outIdx < outgoing.length; outIdx++) {
    const linksForOutput = outgoing[outIdx] || [];
    for (const link of linksForOutput) {
      if (link && link.node) {
        allLinks.push({ node: link.node, type: link.type || 'main', index: link.index ?? 0 });
      }
    }
  }
  if (allLinks.length === 0) {
    throw new Error(`Trigger node "${originalTriggerName}" appears to have no outgoing connections`);
  }

  // De-duplicate links (in case the same target appears multiple times)
  const key = l => `${l.node}|${l.type}|${l.index}`;
  const deduped = Array.from(new Map(allLinks.map(l => [key(l), l])).values());

  // --- Rename the original trigger node and migrate connections ---
  const renamedTriggerName = uniqueName(`${originalTriggerName}-original`);

  // 1) rename node object
  trigger.name = renamedTriggerName;

  // 2) move its *outgoing* connection entry from the old key to the new key
  if (conns[originalTriggerName]) {
    conns[renamedTriggerName] = conns[originalTriggerName];
    delete conns[originalTriggerName];
  }

  // 3) update any *incoming* links that pointed at the old name (paranoia: triggers usually have none)
  for (const srcName of Object.keys(conns)) {
    const outs = conns[srcName]?.main || [];
    for (let outIdx = 0; outIdx < outs.length; outIdx++) {
      const links = outs[outIdx] || [];
      for (const link of links) {
        if (link && link.node === originalTriggerName) {
          link.node = renamedTriggerName;
        }
      }
    }
  }

  // --- Create Manual Trigger + Edit (which inherits the *original* trigger name) ---
  const manualName = uniqueName('Manual Trigger (tester)');
  const manual = makeManualTriggerNode({ name: manualName });
  const edit = makeSetNode({ name: originalTriggerName, json: injectedJson }); // <-- same name as the original trigger had

  // Place reasonably
  manual.position = [0, -192];
  edit.position = [224, -192];

  wf.nodes.push(manual);
  wf.nodes.push(edit);

  // Wire Manual -> Edit
  conns[manual.name] = { main: [[{ node: edit.name, type: 'main', index: 0 }]] };

  // Wire Edit -> ALL original targets (fan-out), under the *original* trigger name
  // (The renamed real trigger continues to have its original connections under "<original>-original")
  conns[edit.name] = { main: [deduped] };

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
