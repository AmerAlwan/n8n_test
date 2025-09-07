const dotenv = require("dotenv");

const envName = process.env.ENV || "DEV";

let envPath = ".env";

if (envName === "DEV") {
    envPath = ".local.env";
    process.env.ENV = "DEV";
}

dotenv.config({ path: envPath });

console.log(`Loaded env: ${envPath}`);
