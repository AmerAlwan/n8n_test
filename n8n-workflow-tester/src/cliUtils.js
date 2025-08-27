const { promisify } = require('util');
const { exec } = require('child_process');
const execAsync = promisify(exec);

/**
 * Wrap n8n CLI calls. Supports:
 *   - local:   n8n <args...>
 *   - docker:  docker exec <container> n8n <args...>
 */
async function runN8n({ runner, args }) {
  const quoted = args.map(a => (/\s/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a)).join(' ');
  let cmd;
  if (runner) {
    const container = runner;
    if (!container) throw new Error('runner.container is required for docker runner');
    cmd = `docker exec ${container} n8n ${quoted}`;
  } else {
    cmd = `n8n ${quoted}`;
  }
  const { stdout, stderr } = await execAsync(cmd, { maxBuffer: 1024 * 1024 * 10 });
  return { stdout, stderr, cmd };
}

module.exports = { runN8n };
