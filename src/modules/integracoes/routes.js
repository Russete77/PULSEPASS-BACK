// modules/integracoes/routes.js — a API pública, autenticada por chave.
//
// Montada em /api/v1/pub. Separada das rotas de usuário de propósito: o
// `Authorization: Bearer` aqui carrega uma chave `pp_live_…`, não um JWT do
// Supabase, e misturar os dois no mesmo caminho seria pedir pra alguém aceitar
// o token errado num refactor.
//
// Só leitura, e sempre recortada pela organização dona da chave. Escrita por
// API (criar evento, cancelar pedido) não entra aqui até existir uma resposta
// pronta pra "o integrador cancelou 400 pedidos por engano" — o que hoje não
// existe.
import { Router } from 'express';
import { asyncHandler } from '../../middleware/asyncHandler.js';
import { requireApiKey } from './access.js';
import * as ctrl from './controller.js';

const router = Router();

// Sem escopo: só exige chave válida. É o "meu token funciona?" que todo
// integrador chama primeiro, e negar por escopo aqui só geraria chamado.
router.get('/eu', requireApiKey(), asyncHandler(ctrl.pubQuemSou));

router.get('/eventos', requireApiKey('eventos:ler'), asyncHandler(ctrl.pubEventos));
router.get('/eventos/:id/ingressos', requireApiKey('ingressos:ler'), asyncHandler(ctrl.pubIngressos));
router.get('/pedidos', requireApiKey('pedidos:ler'), asyncHandler(ctrl.pubPedidos));

export default router;
