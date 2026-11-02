import { createServer } from 'node:http';

createServer((req, res) => res.end('ok\n')).listen(8080);
