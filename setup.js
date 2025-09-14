const { N8NClient } = require('./n8n-workflow-tester');
const path = require('path');
// Identify the environment and load appropriate env file

const dotenv = require("dotenv");

const envName = process.env.ENV || "DEV";

let envPath = ".env";

if (envName === "DEV") {
    envPath = ".local.env";
    process.env.ENV = "DEV";
}

dotenv.config({ path: envPath });

console.log(`Loaded env: ${envPath}`);

// Import all credentials from the env variables

const CREDS_PATH = process.env.CREDS_PATH;
const postgres_creds = Object.fromEntries(
        Object.entries(process.env).filter(([KeyboardEvent, value]) => KeyboardEvent.includes('POSTGRES'))
    );
const postgres_creds_path = path.join(CREDS_PATH, 'postgres_account_credentials.json');

if (process.env.ENV === "DEV") {
  (async () => {
    try {
      await N8NClient.addCredential(postgres_creds_path, postgres_creds);
      await N8NClient.importCredentials();
    } catch (error) {
      console.error('Error importing credentials', error);
    }
  })();
}
