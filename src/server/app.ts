import express from 'express';
import path from 'path';
import dotenv from 'dotenv';
import { getDatabase } from '../db/schema';
import { createRouter } from './routes';
import { logger } from '../utils/logger';

dotenv.config();

async function startServer(): Promise<void> {
  const app = express();
  const port = parseInt(process.env.SERVER_PORT || '3000', 10);

  // Open database
  const db = await getDatabase();

  // Parse JSON request bodies
  app.use(express.json());

  // Serve static dashboard files
  app.use(express.static(path.join(__dirname, '../../public')));

  // API routes
  app.use('/api', createRouter(db));

  // Fallback to dashboard
  app.get('/', (_req, res) => {
    res.sendFile(path.join(__dirname, '../../public/index.html'));
  });

  app.listen(port, () => {
    logger.info({ port }, 'UAE Price Tracker dashboard running');
    console.log(`Dashboard: http://localhost:${port}`);
  });
}

startServer().catch((err) => {
  logger.error(err, 'Failed to start server');
  process.exit(1);
});
