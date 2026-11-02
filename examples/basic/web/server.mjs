import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';

// Read once at startup, so a changed message only shows after a restart.
const message = readFileSync('/config/message.txt', 'utf8').trim();
createServer((req, res) => res.end(`${message}\n`)).listen(3000);
