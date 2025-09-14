const { promisify } = require('util');
const { exec } = require('child_process');
const execAsync = promisify(exec);

async function runN8n(containerName, args) {
  const quoted = args.map(a => (/\s/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a)).join(' ');
  let cmd;
  if (containerName) {
    cmd = `docker exec ${containerName} n8n ${quoted}`;
  } else {
    cmd = `n8n ${quoted}`;
  }
  const { stdout, stderr } = await execAsync(cmd, { maxBuffer: 1024 * 1024 * 10 });
  return { stdout, stderr, cmd };
}

module.exports = { runN8n };
