import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import { env } from './config/env.js';
import routes from './routes/index.js';
import { rateLimit } from './middleware/rateLimit.js';
import { notFoundHandler, errorHandler } from './middleware/errorHandler.js';

export function createApp() {
  const app = express();

  app.set('trust proxy', 1); // IP correto atrás de proxy/load balancer
  app.use(helmet());
  app.use(cors({ origin: env.corsOrigin, credentials: true }));
  app.use(express.json({ limit: '1mb' }));
  if (!env.isProd) app.use(morgan('dev'));

  // Rate limit global + janelas mais estreitas em superfícies sensíveis.
  // O prefixo '/api' cobre também '/api/v1'; limitadores específicos abaixo
  // são declarados para os dois prefixos.
  app.use('/api', rateLimit({ windowMs: 60_000, max: 240, key: 'all' }));
  app.use(['/api/lists', '/api/v1/lists'], rateLimit({ windowMs: 60_000, max: 30, key: 'lists' }));   // inscrição pública
  app.use(['/api/webhooks', '/api/v1/webhooks'], rateLimit({ windowMs: 60_000, max: 600, key: 'wh' }));
  // API pública por chave. Janela própria porque o integrador legítimo faz
  // rajadas (sincronizar o dia inteiro de uma vez) que não se parecem com o
  // tráfego de um comprador. LIMITE CONHECIDO: o balde é por IP, não por
  // chave — o limitador é em memória (ver middleware/rateLimit.js) e cotar por
  // chave exigiria estado compartilhado entre instâncias.
  app.use(['/api/pub', '/api/v1/pub'], rateLimit({ windowMs: 60_000, max: 300, key: 'pub' }));

  // API versionada. '/api/v1' é o contrato oficial; '/api' segue como alias
  // não-versionado para compatibilidade com os fronts atuais.
  app.use('/api/v1', routes);
  app.use('/api', routes);

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
