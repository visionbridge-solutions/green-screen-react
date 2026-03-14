import express from 'express';
import cors from 'cors';
import { createServer } from 'http';
import routes from './routes.js';
import { setupWebSocket } from './websocket.js';

const isMock = process.argv.includes('--mock');
const PORT = parseInt(process.env.PORT || '3001', 10);

const app = express();
app.use(cors());
app.use(express.json());

if (isMock) {
  // Use mock routes instead
  import('./mock/mock-routes.js').then(({ default: mockRoutes }) => {
    app.use('/', mockRoutes);
    startServer();
  });
} else {
  app.use('/', routes);
  startServer();
}

function startServer() {
  const server = createServer(app);
  setupWebSocket(server);

  server.listen(PORT, () => {
    console.log(`Green Screen proxy server running on http://localhost:${PORT}`);
    if (isMock) {
      console.log('Running in MOCK mode (no real IBM i connection)');
    }
  });
}
