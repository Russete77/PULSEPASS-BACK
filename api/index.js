// Entrada da API na Vercel.
//
// A Vercel roda Express nativamente: basta exportar o app. O `src/server.js`
// continua sendo o caminho de sempre (local, Docker, Fly) — ele chama
// `listen()` e trata sinal de encerramento, duas coisas que aqui seriam
// erradas: quem escuta a porta e recicla o processo é a plataforma.
//
// Por isso os dois convivem em vez de um substituir o outro.
import { createApp } from '../src/app.js';

export default createApp();
