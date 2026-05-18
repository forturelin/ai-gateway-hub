import { startServer } from './server.js';

startServer();

process.on('SIGINT', () => {
    console.log('\n[shutdown] SIGINT received, exiting...');
    process.exit(0);
});

process.on('SIGTERM', () => {
    console.log('\n[shutdown] SIGTERM received, exiting...');
    process.exit(0);
});
