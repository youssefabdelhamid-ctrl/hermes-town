#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { createFleetServer } from './fleetServer.mjs';

const args = process.argv.slice(2);
let configFile = process.env.HERMES_TOWN_FLEET_CONFIG;
let port = 4188;
let staticRoot = path.resolve(import.meta.dirname, '../dist');
for (let i = 0; i < args.length; i++) {
  const flag = args[i];
  if (flag === '--help') {
    console.log('Usage: node server/serve-fleet.mjs --config buddies.json [--port 4188] [--static dist]');
    process.exit(0);
  }
  const value = args[++i];
  if (!value) throw new Error(`${flag} requires a value`);
  if (flag === '--config') configFile = value;
  else if (flag === '--port') port = Number(value);
  else if (flag === '--static') staticRoot = path.resolve(value);
  else throw new Error(`Unknown option: ${flag}`);
}
if (!configFile) throw new Error('Provide --config buddies.json or HERMES_TOWN_FLEET_CONFIG');
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid port');
const fleet = createFleetServer({ config: JSON.parse(fs.readFileSync(configFile, 'utf8')), staticRoot });
await fleet.listen(port);
console.log(`All buddies: http://127.0.0.1:${port}/`);
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { void fleet.close().then(() => process.exit(0)); });
