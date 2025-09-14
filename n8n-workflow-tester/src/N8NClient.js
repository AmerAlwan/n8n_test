const os = require('os');
const path = require('path');
const fs = require('fs/promises');
const { runN8n } = require('./cliUtils');

let instance;

class N8NClientSingleton {
    constructor() {
        if (instance) {
            throw new Error("You can only create one instance!");
        }
        instance = this;
        this._containerName = null;
        this._tmpDir = path.join(os.tmpdir(), `n8n-tester-${Date.now()}-${Math.random().toString(36).slice(2)}`);
        this._credsPatch = []; // { name, data }
    }

    getInstance() {
        return this;
    }

    getContainer() {
        return this._containerName;
    }

    usingContainer(containerName) {
        this._containerName = containerName;
    }

    async addCredential(path, data) {
        this._credsPatch.push({ path, data });
    }

    async importCredentials() {
        await fs.mkdir(this._tmpDir, { recursive: true });

        try {
            for (const p of this._credsPatch) {
                const absPath = p.path;
                let raw = await fs.readFile(absPath, "utf8");

                Object.entries(p.data).forEach(([k, v]) => {
                    raw = raw.replaceAll(`$${k}`, v);
                });

                const out = path.join(this._tmpDir, path.basename(p.path));
                await fs.writeFile(out, raw, "utf8");
            }

            await runN8n(
                this._containerName,
                [
                    "import:credentials",
                    "--separate",
                    "--input",
                    this._tmpDir,
                    "--overwrite",
                ],
            );
        } finally {
            try {
                await fs.rm(this._tmpDir, { recursive: true, force: true });
            } catch (cleanupErr) {
                console.error("Failed to clean up temp dir:", cleanupErr);
            }
        }
    }
}

const N8NClient = Object.freeze(new N8NClientSingleton())
module.exports = N8NClient;
