import express from 'express';
import cors from 'cors';
import { createServer } from 'http';
const isMock = process.argv.includes('--mock');
const PORT = parseInt(process.env.PORT || '3001', 10);

const app = express();
app.use(cors());
app.use(express.json());

if (isMock) {
  import('./mock/mock-routes.js').then(({ default: mockRoutes }) => {
    app.use('/', mockRoutes);
    startServer();
  });
} else {
  Promise.all([
    import('./routes.js'),
    import('./websocket.js'),
  ]).then(([{ default: routes }, { setupWebSocket }]) => {
    app.use('/', routes);
    startServer(setupWebSocket);
  });
}

function startServer(setupWebSocket?: (server: any) => void) {
  const server = createServer(app);
  if (setupWebSocket) setupWebSocket(server);

  server.listen(PORT, () => {
    console.log(`Green Screen proxy server running on http://localhost:${PORT}`);
    if (isMock) {
      console.log('Running in MOCK mode (no real IBM i connection)');
    }
  });
}
