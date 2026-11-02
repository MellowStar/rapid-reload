// Stands in for a background worker.
console.log('worker started');
setInterval(() => {}, 60_000);
process.on('SIGTERM', () => process.exit(0));
