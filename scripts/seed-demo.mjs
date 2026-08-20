#!/usr/bin/env node
/**
 * SEED DE DEMONSTRAÇÃO — PulsePass
 *
 * Irmão do scripts/seed-e2e.mjs, com outro propósito: aquele monta o mínimo
 * para a suíte automatizada morder; este monta uma CASA DE SHOW INTEIRA para
 * a apresentação aos sócios. A régua aqui é visual — nenhuma tela do cockpit
 * pode aparecer vazia na hora da conversa.
 *
 * Uso:  npm run seed:demo
 *
 * ── As três regras que orientam o arquivo ──────────────────────────────
 *
 * 1. IDEMPOTENTE. Rodar duas vezes não duplica nada. A organização e os três
 *    eventos são reaproveitados pelo slug (upsert), e todo o movimento que
 *    pendura neles é apagado e refeito. Reaproveitar em vez de recriar não é
 *    preciosismo: audit_log é append-only no banco (nem service_role apaga),
 *    então se o evento nascesse com id novo a cada execução, a trilha de
 *    auditoria ficaria órfã e a tela de Auditoria voltaria a ficar vazia.
 *
 * 2. NADA FORA DA DEMO É TOCADO. Toda remoção é escopada aos eventos DESTA
 *    organização e aos perfis @pulsepass.demo. O dono já tem produtora e
 *    eventos de verdade na mesma base — eles não podem ser arranhados.
 *
 * 3. O PAGAMENTO PASSA PELO CAMINHO REAL. Pedido nasce 'pending' e depois é
 *    atualizado para 'paid'. Os gatilhos do banco (fidelidade, notificações,
 *    webhooks, assentos) só disparam no UPDATE — inserir já pago produziria
 *    um banco sem nenhum dos efeitos colaterais que as telas mostram.
 *
 * O evento "de hoje" é ancorado no INSTANTE DA EXECUÇÃO (começou 2h atrás,
 * termina daqui a 5h). Assim ele está sempre no ar, a qualquer hora que o
 * seed rode — ao custo de o relógio parecer estranho se rodar de manhã.
 * Rode pouco antes da apresentação.
 */
import 'dotenv/config';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import pg from 'pg';
import { createClient } from '@supabase/supabase-js';

// ═══════════════════════════════════════════════════════════════════════
// Constantes da demo — o que identifica "o que é meu" na limpeza
// ═══════════════════════════════════════════════════════════════════════

const EMAIL_DONO = 'erickrussomat@gmail.com';
const ORG_SLUG = 'nebula-producoes';
const DOMINIO = '@pulsepass.demo';
const SENHA = 'Demo12345!';

const SLUG_PASSADO = 'nebula-sunset-inverno';
const SLUG_HOJE = 'nebula-noturna-rooftop';
const SLUG_FUTURO = 'nebula-open-air-marina';

// ── A segunda produtora ──
// O PulseADM (god-mode) mede a plataforma comparando casas: ranking de GMV,
// repasse por produtora, GMV por cidade. Com UMA produtora no banco, todos
// esses painéis viram uma barra sozinha — que é pior do que vazio, porque
// parece que o recurso não funciona. Esta aqui é PEQUENA de propósito: é o
// contraste que faz o ranking dizer alguma coisa.
const ORG2_SLUG = 'coletivo-mare';
const SLUG_MARE_PASSADO = 'mare-samba-do-cais';
const SLUG_MARE_FUTURO = 'mare-alta-baile-sabado';

const WEB = process.env.DEMO_WEB_URL ?? 'http://localhost:5173';
const COCKPIT = process.env.DEMO_COCKPIT_URL ?? 'http://localhost:5174';

// ═══════════════════════════════════════════════════════════════════════
// Utilidades
// ═══════════════════════════════════════════════════════════════════════

const AGORA = Date.now();
const H = 3600e3;
const D = 24 * H;
const iso = (ms) => new Date(ms).toISOString();
const brl = (c) => (c / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

/** Aleatório com semente fixa: duas execuções produzem o mesmo cenário,
 *  então o dono pode ensaiar a apresentação e reencontrar os mesmos números. */
let semente = 20260819;
const rnd = () => { semente = (semente * 1103515245 + 12345) % 2147483648; return semente / 2147483648; };
const escolher = (arr) => arr[Math.floor(rnd() * arr.length)];
const inteiro = (min, max) => min + Math.floor(rnd() * (max - min + 1));
const talvez = (p) => rnd() < p;

let cliente;
const sql = (texto, params) => cliente.query(texto, params);

/**
 * INSERT de várias linhas numa tacada só. Semear 500 ingressos com uma ida
 * ao banco por linha levaria minutos numa conexão remota.
 */
async function inserir(tabela, colunas, linhas, retornando = 'id') {
  if (!linhas.length) return [];
  const saida = [];
  // Postgres aceita no máximo 65535 parâmetros por comando.
  const porLote = Math.max(1, Math.floor(60000 / colunas.length));
  for (let i = 0; i < linhas.length; i += porLote) {
    const fatia = linhas.slice(i, i + porLote);
    const params = [];
    const values = fatia.map((linha) => `(${colunas.map((c) => {
      params.push(linha[c] === undefined ? null : linha[c]);
      return `$${params.length}`;
    }).join(',')})`);
    const { rows } = await sql(
      `insert into public.${tabela} (${colunas.join(',')}) values ${values.join(',')} returning ${retornando}`,
      params,
    );
    saida.push(...rows);
  }
  return saida;
}

const passos = [];
const passo = (texto) => { passos.push(texto); process.stdout.write(`  · ${texto}\n`); };

// ═══════════════════════════════════════════════════════════════════════
// Elenco — nomes plausíveis, nada de "Teste 1"
// ═══════════════════════════════════════════════════════════════════════

const CLIENTES = [
  ['Mariana Fontes', 'mariana.fontes'], ['Rafael Bittencourt', 'rafael.bittencourt'],
  ['Camila Nogueira', 'camila.nogueira'], ['Thiago Marinho', 'thiago.marinho'],
  ['Larissa Prado', 'larissa.prado'], ['Gustavo Rangel', 'gustavo.rangel'],
  ['Beatriz Salgado', 'beatriz.salgado'], ['Vinícius Toledo', 'vinicius.toledo'],
  ['Juliana Peçanha', 'juliana.pecanha'], ['Felipe Andrade', 'felipe.andrade'],
  ['Natália Cordeiro', 'natalia.cordeiro'], ['Bruno Queiroz', 'bruno.queiroz'],
  ['Isabela Menezes', 'isabela.menezes'], ['Rodrigo Vasques', 'rodrigo.vasques'],
  ['Letícia Amorim', 'leticia.amorim'], ['Marcelo Tavares', 'marcelo.tavares'],
  ['Priscila Bandeira', 'priscila.bandeira'], ['Caio Vilela', 'caio.vilela'],
];

const EQUIPE = [
  ['Sandro Barreto', 'sandro.barreto', 'door', ['door:checkin', 'door:reentry', 'door:guests']],
  ['Kelly Nakamura', 'kelly.nakamura', 'bar', ['bar:pdv', 'bar:kds', 'bar:menu', 'boxoffice:sell']],
  ['Wesley Duarte', 'wesley.duarte', 'bar', ['bar:waiter', 'bar:kds']],
  ['Aline Prazeres', 'aline.prazeres', 'manager', ['finance:view', 'tables:manage', 'coupons:manage', 'door:checkin']],
];

const PROMOTERS = [
  ['Rafaela Antunes', 'rafaela.antunes'],
  ['Diego Sampaio', 'diego.sampaio'],
  ['Yasmin Cavalcanti', 'yasmin.cavalcanti'],
];

/** Dona do Coletivo Maré. Produtora SEPARADA do dono: no ranking do PulseADM
 *  duas casas do mesmo dono não provam nada — a comparação precisa de duas
 *  contas distintas para o painel de repasse listar dois destinatários. */
const DONA_MARE = ['Renata Bittar', 'renata.bittar'];

/** Para onde vão as transferências pendentes: e-mails SEM conta no sistema.
 *  Se algum destes virasse perfil, o gatilho de resgate aceitaria a
 *  transferência na hora e a demo perderia justamente o estado pendente. */
const SEM_CONTA = [
  ['Heloísa Trindade', 'heloisa.trindade@familiatrindade.com.br'],
  ['Ricardo Vilanova', 'ricardo.vilanova@vilanovaadv.com.br'],
];

/** Convidados de lista — só nome, e-mail e telefone; não viram conta de auth. */
const NOMES_LISTA = [
  'Amanda Ribeiro', 'Douglas Peixoto', 'Sabrina Lacerda', 'Otávio Bernardes', 'Kamila Fontoura',
  'Renan Belchior', 'Tainá Moscoso', 'Everton Callado', 'Milena Sarmento', 'Igor Bacelar',
  'Carol Pimentel', 'Leandro Vasconcelos', 'Bianca Portela', 'Murilo Assunção', 'Débora Rocha',
  'Alexandre Frota Lima', 'Simone Vieira', 'Alan Bonfim', 'Verônica Duarte', 'Márcio Aguiar',
  'Pâmela Bastos', 'Anderson Freitas', 'Cíntia Meireles', 'Fábio Colombo', 'Nathália Braga',
  'Wagner Estrela', 'Elisa Camargo', 'Hugo Sampaio', 'Raíssa Monteiro', 'Danilo Pacheco',
  'Aline Bezerra', 'Jonas Trindade', 'Michele Cardoso', 'Rogério Nunes', 'Talita Ferraz',
  'Sérgio Bittar', 'Vanessa Loureiro', 'Emerson Padilha', 'Karina Bulhões', 'Lucas Zanotti',
];

// ═══════════════════════════════════════════════════════════════════════
// Conexão
// ═══════════════════════════════════════════════════════════════════════

async function conectar() {
  // A "Direct connection" do Supabase só resolve em IPv6 e expira sem
  // explicação em rede sem IPv6. O pooler (IPv4) é o caminho confiável aqui.
  const url = process.env.DATABASE_URL_POOLER || process.env.DATABASE_URL;
  if (!url) throw new Error('Defina DATABASE_URL_POOLER no .env (session pooler do Supabase).');
  const c = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false }, connectionTimeoutMillis: 20000 });
  await c.connect();
  return c;
}

function admin() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error('Faltam SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY no .env.');
  return createClient(url, key, { auth: { persistSession: false } });
}

// ═══════════════════════════════════════════════════════════════════════
// Capas e logo — sem imagem a vitrine fica com card cinza
// ═══════════════════════════════════════════════════════════════════════

// ── Codificador de PNG mínimo ──
// O bucket event-covers só aceita jpeg/png/webp/avif — SVG é recusado na
// entrada. Como o projeto não tem sharp nem canvas (e puxar dependência só
// para semear seria caro demais), a capa é montada pixel a pixel e comprimida
// com o zlib que já vem no Node.
const TABELA_CRC = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();
const crc32 = (buf) => {
  let c = -1;
  for (let i = 0; i < buf.length; i += 1) c = TABELA_CRC[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
};

function montarPng(largura, altura, bruto) {
  const bloco = (tipo, dados) => {
    const tamanho = Buffer.alloc(4);
    tamanho.writeUInt32BE(dados.length, 0);
    const cabeca = Buffer.from(tipo, 'ascii');
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(Buffer.concat([cabeca, dados])), 0);
    return Buffer.concat([tamanho, cabeca, dados, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(largura, 0);
  ihdr.writeUInt32BE(altura, 4);
  ihdr[8] = 8;  // 8 bits por canal
  ihdr[9] = 2;  // RGB, sem paleta e sem alfa
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
    bloco('IHDR', ihdr),
    bloco('IDAT', zlib.deflateSync(bruto, { level: 9 })),
    bloco('IEND', Buffer.alloc(0)),
  ]);
}

const hexRgb = (h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];

/** Capa: degradê diagonal, brilho no alto à direita, base escurecida para o
 *  título do card ficar legível, e uma poeira de estrelas. */
function capaPng({ corA, corB }) {
  const L = 1200;
  const A = 675;
  const [r1, g1, b1] = hexRgb(corA);
  const [r2, g2, b2] = hexRgb(corB);
  const bruto = Buffer.alloc((L * 3 + 1) * A);
  const cx = 0.78 * L;
  const cy = 0.16 * A;
  const raio2 = 2 * (0.44 * L) ** 2;

  let o = 0;
  for (let y = 0; y < A; y += 1) {
    // Filtro 1 (Sub): cada byte vira a diferença para o pixel à esquerda.
    // Num degradê horizontal isso deixa a linha quase constante e o deflate
    // cai de ~560 KB para ~180 KB — a capa é servida na vitrine, o peso conta.
    const inicioLinha = o;
    bruto[o] = 1;
    o += 1;
    const fy = y / A;
    // Escurece de baixo para cima: é onde a interface escreve por cima.
    const base = 1 - 0.5 * Math.max(0, (fy - 0.5) / 0.5) ** 1.6;
    for (let x = 0; x < L; x += 1) {
      const t = (x / L) * 0.62 + fy * 0.38;
      const brilho = 0.42 * Math.exp(-(((x - cx) ** 2) + ((y - cy) ** 2)) / raio2);
      const grao = ((x * 7919 + y * 104729) % 61) / 61 - 0.5;
      // Estrelas esparsas e determinísticas.
      const estrela = (x * 31 + y * 17) % 4801 === 0 ? 90 : 0;
      const mistura = (a, b) => (a + (b - a) * t) * base + 255 * brilho + grao * 2 + estrela;
      bruto[o] = Math.max(0, Math.min(255, mistura(r1, r2))) | 0;
      bruto[o + 1] = Math.max(0, Math.min(255, mistura(g1, g2))) | 0;
      bruto[o + 2] = Math.max(0, Math.min(255, mistura(b1, b2))) | 0;
      o += 3;
    }
    // Aplicado de trás para frente: cada byte precisa do vizinho ainda cru.
    for (let i = o - 1; i > inicioLinha + 3; i -= 1) bruto[i] = (bruto[i] - bruto[i - 3]) & 255;
  }
  return montarPng(L, A, bruto);
}

function logoSvg() {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512">
  <defs><linearGradient id="l" x1="0" y1="0" x2="1" y2="1">
    <stop offset="0" stop-color="#7C3AED"/><stop offset="1" stop-color="#22D3EE"/></linearGradient></defs>
  <rect width="512" height="512" rx="112" fill="#0B0714"/>
  <circle cx="256" cy="256" r="150" fill="none" stroke="url(#l)" stroke-width="18" opacity="0.9"/>
  <circle cx="256" cy="256" r="88" fill="url(#l)" opacity="0.28"/>
  <text x="256" y="300" text-anchor="middle" font-family="Georgia, 'Times New Roman', serif"
        font-size="150" font-weight="700" fill="#ffffff">N</text>
</svg>`;
}

async function subirImagem(db, bucket, caminho, corpo, tipo) {
  const { error } = await db.storage.from(bucket).upload(caminho, corpo, {
    contentType: tipo, upsert: true, cacheControl: '3600',
  });
  if (error) { console.warn(`  ! ${bucket}/${caminho}: ${error.message}`); return null; }
  return db.storage.from(bucket).getPublicUrl(caminho).data.publicUrl;
}

// ═══════════════════════════════════════════════════════════════════════
// Contas
// ═══════════════════════════════════════════════════════════════════════

/**
 * Localiza o dono. NUNCA cria conta para ele: se o e-mail não existe, o certo
 * é ele logar uma vez e rodar de novo — inventar um usuário aqui geraria uma
 * identidade paralela que ele nunca conseguiria acessar.
 */
async function acharDono() {
  const { rows } = await sql('select id, email, full_name from public.profiles where lower(email) = lower($1)', [EMAIL_DONO]);
  if (!rows.length) {
    throw new Error(
      `Não achei o perfil de ${EMAIL_DONO}.\n` +
      '  → Faça login UMA vez no app com esse e-mail (ou crie a conta) e rode o seed de novo.\n' +
      '  A conta do dono não é criada aqui de propósito: seria uma identidade que ele não controla.',
    );
  }
  // O cockpit só abre para quem é produtora.
  await sql("update public.profiles set role = 'produtora' where id = $1 and role <> 'adm'", [rows[0].id]);
  return rows[0];
}

/**
 * Cria (ou reaproveita) as contas fictícias. Usuário de auth NUNCA é apagado:
 * remover conta que ainda tem carteira/pedido/auditoria apontando pra ela
 * devolve 500 opaco do GoTrue. A identidade é estável; o que renasce a cada
 * execução é o movimento em cima dela.
 */
async function garantirConta(db, apelido, nome, role) {
  const email = `${apelido}${DOMINIO}`;
  const { rows } = await sql('select id from public.profiles where lower(email) = lower($1)', [email]);
  let id = rows[0]?.id;
  if (id) {
    const { error } = await db.auth.admin.updateUserById(id, { password: SENHA, email_confirm: true });
    if (error) throw new Error(`${email}: não deu pra recuperar a conta — ${error.message}`);
  } else {
    const { data, error } = await db.auth.admin.createUser({
      email, password: SENHA, email_confirm: true, user_metadata: { full_name: nome },
    });
    if (error) throw new Error(`${email}: ${error.message}`);
    id = data.user.id;
  }
  await sql(
    'update public.profiles set full_name = $2, role = $3, phone = coalesce(phone, $4), email = coalesce(email, $5) where id = $1',
    [id, nome, role, `+55 11 9${inteiro(4000, 9999)}-${inteiro(1000, 9999)}`, email],
  );
  return { id, email, nome };
}

// ═══════════════════════════════════════════════════════════════════════
// Limpeza — a ordem segue as chaves estrangeiras, do galho para o tronco
// ═══════════════════════════════════════════════════════════════════════

/**
 * Carteira única (event_id null) e sino das contas de demonstração.
 *
 * SEPARADO de limpar(), e depois dela: a carteira não pertence a evento
 * nenhum, e bar_orders de QUALQUER casa aponta para ela. Apagando junto com a
 * primeira produtora, a comanda da segunda ainda existente segurava a linha e
 * a segunda execução do seed morria no meio — o pior tipo de falha de
 * idempotência, porque a primeira execução passa limpa.
 *
 * Escopo por perfil da demo — nunca "delete from wallets" solto.
 */
async function limparPerfis(perfisDemo) {
  const perfis = perfisDemo.map((p) => p.id);
  if (!perfis.length) return;
  await sql('delete from public.wallet_topups where profile_id = any($1)', [perfis]);
  await sql('delete from public.wallets where profile_id = any($1)', [perfis]);
  await sql('delete from public.notificacoes where user_id = any($1)', [perfis]);
}

async function limpar(orgId, perfisDemo, manter) {
  const { rows: evs } = await sql('select id from public.events where organization_id = $1', [orgId]);
  const eventos = evs.map((e) => e.id);

  if (eventos.length) {
    const { rows: peds } = await sql('select id from public.orders where event_id = any($1)', [eventos]);
    const pedidos = peds.map((o) => o.id);

    // fiscal_documents é RESTRICT sobre orders: enquanto houver nota emitida,
    // o pedido não sai. Ela vai primeiro, sempre.
    if (pedidos.length) await sql('delete from public.fiscal_documents where order_id = any($1)', [pedidos]);
    await sql('delete from public.fiscal_documents where organization_id = $1', [orgId]);

    // bar_order_items → menu_items sem cascade: o item do cardápio não sai
    // enquanto houver comanda antiga apontando pra ele.
    await sql('delete from public.bar_orders where event_id = any($1)', [eventos]);
    await sql('delete from public.gate_movements where event_id = any($1)', [eventos]);
    // ticket_transfers pende de tickets com ON DELETE CASCADE — some junto.
    // Está escrito aqui só para o leitor não procurar a linha que falta.
    await sql('delete from public.tickets where event_id = any($1)', [eventos]);
    await sql('delete from public.box_office_sales where event_id = any($1)', [eventos]);
    await sql('delete from public.waitlist where event_id = any($1)', [eventos]);
    await sql('delete from public.fraud_cases where event_id = any($1)', [eventos]);
    await sql('delete from public.notificacoes where event_id = any($1)', [eventos]);
    await sql('delete from public.event_seats where event_id = any($1)', [eventos]);
    await sql('delete from public.fidelidade_ledger where organization_id = $1', [orgId]);
    if (pedidos.length) await sql('delete from public.email_deliveries where order_id = any($1)', [pedidos]);
    await sql('delete from public.orders where event_id = any($1)', [eventos]);

    await sql('delete from public.marketing_campaigns where event_id = any($1)', [eventos]);
    await sql('delete from public.table_reservations where event_id = any($1)', [eventos]);
    await sql('delete from public.event_tables where event_id = any($1)', [eventos]);
    await sql('delete from public.guests where event_id = any($1)', [eventos]);
    await sql('delete from public.promoters where event_id = any($1)', [eventos]);
    await sql('delete from public.coupons where event_id = any($1)', [eventos]);
    await sql('delete from public.menu_items where event_id = any($1)', [eventos]);
    await sql('delete from public.cashier_shifts where event_id = any($1)', [eventos]);
    await sql('delete from public.event_staff where event_id = any($1)', [eventos]);
    await sql('delete from public.wallet_topups where event_id = any($1)', [eventos]);
    await sql('delete from public.wallets where event_id = any($1)', [eventos]);
    await sql('delete from public.ticket_tiers where event_id = any($1)', [eventos]);
  }

  await sql('delete from public.webhook_assinaturas where organization_id = $1', [orgId]);
  await sql('delete from public.api_keys where organization_id = $1', [orgId]);

  // Eventos e organização FICAM (upsert adiante). audit_log é append-only no
  // banco — trocar o id do evento a cada execução deixaria a trilha órfã.
  await sql('delete from public.events where organization_id = $1 and slug <> all($2)', [orgId, manter]);

  return eventos.length;
}

// ═══════════════════════════════════════════════════════════════════════
// Organização e eventos
// ═══════════════════════════════════════════════════════════════════════

async function upsertOrg(donoId) {
  // created_at antigo de propósito: várias telas do cockpit (Marca, Repasse,
  // Integrações) usam organizations[0] com a lista ordenada por created_at
  // crescente. Sem isso a produtora de demonstração ficaria em segundo lugar
  // e essas telas mostrariam a produtora REAL do dono no meio da apresentação.
  const nascimento = iso(AGORA - 430 * D);
  // A subconta Asaas vai preenchida e APROVADA: é o que faz a tela de Repasse
  // mostrar o fluxo completo em vez do aviso "configure sua carteira".
  const { rows } = await sql(`
    insert into public.organizations
      (owner_id, name, slug, cnpj, brand_color, site_url, instagram, fee_bps, created_at,
       asaas_wallet_id, asaas_account_id, asaas_account_status, asaas_onboarding_url, asaas_account_created_at)
    values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,null,$13)
    on conflict (slug) do update set
      owner_id = excluded.owner_id, name = excluded.name, cnpj = excluded.cnpj,
      brand_color = excluded.brand_color, site_url = excluded.site_url,
      instagram = excluded.instagram, fee_bps = excluded.fee_bps, created_at = excluded.created_at,
      asaas_wallet_id = excluded.asaas_wallet_id, asaas_account_id = excluded.asaas_account_id,
      asaas_account_status = excluded.asaas_account_status,
      asaas_onboarding_url = null, asaas_account_created_at = excluded.asaas_account_created_at
    returning id`,
  [donoId, 'Nébula Produções', ORG_SLUG, '41.822.905/0001-64', '#7C3AED',
    'https://nebulaproducoes.com.br', '@nebulaproducoes', 700, nascimento,
    'a1d3f7c2-9b44-4e51-8f0a-3c7d2e916b80', 'acc_demo_nebula_7f21', 'APPROVED',
    iso(AGORA - 420 * D)]);
  return rows[0].id;
}

/**
 * A segunda casa.
 *
 * Menor em tudo — uma cidade, dois eventos, ticket médio baixo — porque o
 * valor dela está na COMPARAÇÃO: o ranking do PulseADM ordena por GMV, e
 * ranking com um item só não é ranking. Vai com a subconta Asaas em análise
 * (não aprovada) para a tela de saúde da plataforma mostrar os dois estados
 * de onboarding lado a lado.
 */
async function upsertOrgMare(donaId) {
  const { rows } = await sql(`
    insert into public.organizations
      (owner_id, name, slug, cnpj, brand_color, site_url, instagram, fee_bps, created_at,
       asaas_wallet_id, asaas_account_id, asaas_account_status, asaas_account_created_at)
    values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
    on conflict (slug) do update set
      owner_id = excluded.owner_id, name = excluded.name, cnpj = excluded.cnpj,
      brand_color = excluded.brand_color, site_url = excluded.site_url,
      instagram = excluded.instagram, fee_bps = excluded.fee_bps, created_at = excluded.created_at,
      asaas_wallet_id = excluded.asaas_wallet_id, asaas_account_id = excluded.asaas_account_id,
      asaas_account_status = excluded.asaas_account_status,
      asaas_account_created_at = excluded.asaas_account_created_at
    returning id`,
  [donaId, 'Coletivo Maré', ORG2_SLUG, '28.704.113/0001-09', '#0EA5E9',
    'https://coletivomare.com.br', '@coletivomare', 900, iso(AGORA - 190 * D),
    'c7b91e34-2a6d-4f80-9d13-6e5a1c74b2ff', 'acc_demo_mare_3c98', 'PENDING', iso(AGORA - 185 * D)]);
  return rows[0].id;
}

async function upsertEvento(orgId, ev) {
  const { rows } = await sql(`
    insert into public.events
      (organization_id, title, slug, description, venue_name, address, city, state,
       starts_at, ends_at, status, service_fee_bps, category, latitude, longitude,
       reentry_enabled, reentry_max)
    values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
    on conflict (slug) do update set
      organization_id = excluded.organization_id, title = excluded.title,
      description = excluded.description, venue_name = excluded.venue_name,
      address = excluded.address, city = excluded.city, state = excluded.state,
      starts_at = excluded.starts_at, ends_at = excluded.ends_at, status = excluded.status,
      service_fee_bps = excluded.service_fee_bps, category = excluded.category,
      latitude = excluded.latitude, longitude = excluded.longitude,
      reentry_enabled = excluded.reentry_enabled, reentry_max = excluded.reentry_max
    returning id`,
  [orgId, ev.title, ev.slug, ev.description, ev.venue, ev.address, ev.city, ev.state,
    ev.starts, ev.ends, ev.status, 1000, 'festa', ev.lat, ev.lng,
    ev.reentrada ?? false, ev.reentrada ? 2 : null]);
  return rows[0].id;
}

// ═══════════════════════════════════════════════════════════════════════
// Vendas — pedido nasce pendente e VIRA pago, para os gatilhos rodarem
// ═══════════════════════════════════════════════════════════════════════

/**
 * @param {object} p
 * @param {Array}  p.lotes       [{ id, nome, preco, meia, vender }]
 * @param {number} p.janelaIni   início da janela de venda (ms)
 * @param {number} p.janelaFim   fim da janela de venda (ms)
 * @param {number} p.taxaEstorno fração de pedidos que vira estorno
 */
async function venderIngressos({ eventoId, prefixo, lotes, compradores, janelaIni, janelaFim, taxaEstorno, cupom }) {
  const pedidos = [];
  const itens = [];
  const ingressos = [];
  let n = 0;

  for (const lote of lotes) {
    let restante = lote.vender;
    while (restante > 0) {
      const qtd = Math.min(restante, escolher([1, 1, 2, 2, 2, 3, 4]));
      restante -= qtd;
      const comprador = escolher(compradores);
      const nascido = janelaIni + rnd() * (janelaFim - janelaIni);
      const pagoEm = nascido + inteiro(40, 900) * 1000; // PIX cai em segundos/minutos

      // Meia-entrada aparece em parte das vendas: é o caso que mais confunde
      // conferência de caixa, e a demo precisa mostrar que ele existe.
      const meia = lote.meia && talvez(0.22);
      const unitario = meia ? lote.meia : lote.preco;
      const subtotal = unitario * qtd;
      const usaCupom = cupom && talvez(0.12);
      const desconto = usaCupom ? Math.round(subtotal * 0.1) : 0;
      const taxa = Math.round((subtotal - desconto) * 0.10);
      const total = subtotal - desconto + taxa;

      const id = crypto.randomUUID();
      // Lote marcado como esgotado não leva estorno: o ingresso devolvido
      // volta ao estoque e a tela passaria a mostrar "Esgotado 57/60", que é
      // exatamente o tipo de número incoerente que derruba a confiança numa
      // apresentação.
      const estornado = lote.status !== 'sold_out' && talvez(taxaEstorno);
      pedidos.push({
        id,
        buyer_id: comprador.id,
        event_id: eventoId,
        status: 'pending',
        total_cents: total,
        service_fee_cents: taxa,
        discount_cents: desconto,
        coupon_code: usaCupom ? cupom : null,
        platform_fee_bps: 700,
        external_reference: `demo-${prefixo}-${String(++n).padStart(4, '0')}`,
        asaas_payment_id: `pay_demo_${prefixo}_${String(n).padStart(4, '0')}`,
        asaas_customer_id: `cus_demo_${comprador.id.slice(0, 8)}`,
        created_at: iso(nascido),
        expires_at: iso(nascido + 30 * 60e3),
        _pagoEm: pagoEm,
        _estornado: estornado,
        _comprador: comprador,
        _lote: lote,
        _qtd: qtd,
      });
      itens.push({ order_id: id, ticket_tier_id: lote.id, unit_price_cents: unitario, quantity: qtd });

      for (let i = 0; i < qtd; i += 1) {
        ingressos.push({
          id: crypto.randomUUID(),
          order_id: id,
          event_id: eventoId,
          ticket_tier_id: lote.id,
          owner_id: comprador.id,
          code: `${prefixo}-${String(ingressos.length + 1).padStart(4, '0')}-${crypto.randomBytes(2).toString('hex').toUpperCase()}`,
          holder_name: i === 0 ? comprador.nome : escolher(NOMES_LISTA),
          status: estornado ? 'cancelled' : 'valid',
          created_at: iso(pagoEm),
          _pedido: id,
          _estornado: estornado,
        });
      }
    }
  }

  await inserir('orders', ['id', 'buyer_id', 'event_id', 'status', 'total_cents', 'service_fee_cents',
    'discount_cents', 'coupon_code', 'platform_fee_bps', 'external_reference', 'asaas_payment_id',
    'asaas_customer_id', 'created_at', 'expires_at'], pedidos);
  await inserir('order_items', ['order_id', 'ticket_tier_id', 'unit_price_cents', 'quantity'], itens, 'id');
  await inserir('tickets', ['id', 'order_id', 'event_id', 'ticket_tier_id', 'owner_id', 'code',
    'holder_name', 'status', 'created_at'], ingressos);

  // ── A transição que acorda os gatilhos ──
  await sql(`
    update public.orders o
       set status = 'paid', paid_at = v.pago::timestamptz
      from (select unnest($1::uuid[]) as id, unnest($2::text[]) as pago) v
     where o.id = v.id`,
  [pedidos.map((p) => p.id), pedidos.map((p) => iso(p._pagoEm))]);

  // ── E os estornos, que acordam o gatilho de devolução de pontos ──
  const estornados = pedidos.filter((p) => p._estornado);
  if (estornados.length) {
    await sql(`
      update public.orders o
         set status = 'refunded',
             reversed_at = v.em::timestamptz,
             reversal_kind = v.tipo,
             reversal_reason = v.motivo
        from (select unnest($1::uuid[]) as id, unnest($2::text[]) as em,
                     unnest($3::text[]) as tipo, unnest($4::text[]) as motivo) v
       where o.id = v.id`,
    [estornados.map((p) => p.id),
      estornados.map((p) => iso(p._pagoEm + inteiro(6, 72) * H)),
      estornados.map(() => escolher(['refund', 'refund', 'chargeback'])),
      estornados.map(() => escolher([
        'Cliente desistiu — solicitou reembolso pelo suporte',
        'Compra duplicada no PIX',
        'Contestação no cartão',
        'Cancelamento dentro do prazo de arrependimento',
      ]))]);
  }

  return { pedidos, ingressos };
}

/** Check-in de verdade: muda o ingresso e registra o movimento de porta. */
async function fazerCheckin(eventoId, ingressos, fracao, porteiroId, janelaIni, janelaFim, { reentradas = 0, saidas = 0, naoVao = [] } = {}) {
  // Quem comprou e não foi. Além de ser verdade em qualquer festa, é o que
  // alimenta o segmento "comprou e não deu check-in" do Marketing: se TODO
  // comprador tiver ao menos um ingresso validado, esse público fica zerado.
  const ausentes = new Set(naoVao);
  const validos = ingressos.filter((t) => t.status === 'valid' && !ausentes.has(t.owner_id));
  const alvo = Math.round(validos.length * fracao);
  const entraram = validos.slice(0, alvo).map((t) => ({
    ...t, _quando: janelaIni + rnd() * (janelaFim - janelaIni),
  }));
  if (!entraram.length) return [];

  await sql(`
    update public.tickets t
       set status = 'used', checked_in_at = v.em::timestamptz
      from (select unnest($1::uuid[]) as id, unnest($2::text[]) as em) v
     where t.id = v.id`,
  [entraram.map((t) => t.id), entraram.map((t) => iso(t._quando))]);

  const portoes = ['Portão A', 'Portão A', 'Portão B', 'Entrada VIP'];
  const movimentos = entraram.map((t) => ({
    ticket_id: t.id, event_id: eventoId, direction: 'in', operator_id: porteiroId,
    gate: escolher(portoes), created_at: iso(t._quando),
  }));
  // Reentrada: quem saiu para fumar e voltou. Sem isso a tela de reentrada
  // fica zerada e parece recurso que não funciona.
  for (const t of entraram.slice(0, reentradas)) {
    const saiu = t._quando + inteiro(20, 60) * 60e3;
    movimentos.push({ ticket_id: t.id, event_id: eventoId, direction: 'out', operator_id: porteiroId, gate: 'Portão A', created_at: iso(saiu) });
    movimentos.push({ ticket_id: t.id, event_id: eventoId, direction: 'in', operator_id: porteiroId, gate: 'Portão A', created_at: iso(saiu + inteiro(8, 25) * 60e3) });
  }
  // E quem foi embora e não voltou: sem eles a lotação mostra "saíram: 0",
  // que faz o painel parecer um contador quebrado em vez de uma casa real.
  for (const t of entraram.slice(reentradas, reentradas + saidas)) {
    movimentos.push({
      ticket_id: t.id, event_id: eventoId, direction: 'out', operator_id: porteiroId,
      gate: escolher(portoes), created_at: iso(Math.min(t._quando + inteiro(45, 110) * 60e3, janelaFim)),
    });
  }
  await inserir('gate_movements', ['ticket_id', 'event_id', 'direction', 'operator_id', 'gate', 'created_at'], movimentos, 'id');
  return entraram;
}

// ═══════════════════════════════════════════════════════════════════════
// Cardápio e bar
// ═══════════════════════════════════════════════════════════════════════

const CARDAPIO = [
  // [nome, categoria, preço, custo, estoque, descrição]
  ['Chopp Brahma 400ml', 'Cervejas', 1400, 520, null, 'Tirado na hora, colarinho na régua.'],
  ['Heineken Long Neck', 'Cervejas', 1800, 700, 48, null],
  ['Corona 330ml', 'Cervejas', 1900, 780, 36, 'Com rodela de limão.'],
  ['Gin Tônica Nébula', 'Drinks', 2600, 900, 4, 'Gin nacional, tônica e zimbro.'],
  ['Caipirinha de Limão', 'Drinks', 2200, 650, null, null],
  ['Aperol Spritz', 'Drinks', 2900, 1100, 9, 'Aperol, prosecco e água com gás.'],
  ['Moscow Mule', 'Drinks', 2700, 980, 22, 'Vodca, espuma de gengibre e limão.'],
  ['Dose Red Label', 'Doses', 2400, 850, null, null],
  ['Dose Tequila Ouro', 'Doses', 2000, 700, 30, null],
  ['Água sem gás 500ml', 'Sem álcool', 700, 180, null, null],
  ['Red Bull', 'Sem álcool', 1800, 800, 40, null],
  ['Refrigerante lata', 'Sem álcool', 900, 250, null, null],
  ['Batata rústica com cheddar', 'Cozinha', 3200, 1150, null, 'Serve 2 pessoas.'],
  ['Mini burger duplo', 'Cozinha', 3400, 1400, 25, 'Dois smash, cheddar e picles.'],
  ['Isca de frango com limão', 'Cozinha', 3800, 1600, null, 'Serve 3 pessoas.'],
];

async function semearCardapio(eventoId, quais = CARDAPIO) {
  const linhas = quais.map(([name, category, price_cents, cost_cents, stock, description], i) => ({
    event_id: eventoId, name, category, price_cents, cost_cents, stock, description,
    available: true, position: i,
  }));
  const rows = await inserir('menu_items',
    ['event_id', 'name', 'category', 'price_cents', 'cost_cents', 'stock', 'description', 'available', 'position'],
    linhas, 'id, name, price_cents');
  return rows;
}

/**
 * Comandas do bar. `delivered` é histórico e sai da fila; `paid`, `preparing`
 * e `ready` são o que a Cozinha e o Salão mostram na tela.
 */
async function semearComandas({ eventoId, cardapio, compradores, carteiras, mesas, operadorId, garcomId, janelaIni, janelaFim, distribuicao }) {
  const comandas = [];
  const itens = [];
  let seq = 0;

  for (const [status, quantidade] of Object.entries(distribuicao)) {
    for (let i = 0; i < quantidade; i += 1) {
      const comprador = escolher(compradores);
      const quando = janelaIni + rnd() * (janelaFim - janelaIni);
      const id = crypto.randomUUID();
      const nItens = inteiro(1, 3);
      let total = 0;
      for (let k = 0; k < nItens; k += 1) {
        const item = escolher(cardapio);
        const qtd = inteiro(1, 3);
        total += item.price_cents * qtd;
        itens.push({ bar_order_id: id, menu_item_id: item.id, name: item.name, unit_price_cents: item.price_cents, quantity: qtd });
      }
      // Parte das comandas é do garçom, na mesa; parte é no balcão, com
      // retirada por senha. As duas telas precisam ter o que mostrar.
      const naMesa = mesas.length && talvez(0.35);
      const porCarteira = talvez(0.55);
      comandas.push({
        id,
        buyer_id: comprador.id,
        event_id: eventoId,
        wallet_id: porCarteira ? (carteiras.get(comprador.id) ?? null) : null,
        status,
        total_cents: total,
        pickup_code: String(101 + (seq += 1)),
        station: escolher(['Bar Principal', 'Bar Principal', 'Bar Rooftop', 'Cozinha']),
        operator_id: porCarteira ? null : operadorId,
        table_id: naMesa ? escolher(mesas).id : null,
        waiter_id: naMesa ? garcomId : null,
        created_at: iso(quando),
        preparing_at: ['preparing', 'ready', 'delivered'].includes(status) ? iso(quando + inteiro(40, 180) * 1000) : null,
        ready_at: ['ready', 'delivered'].includes(status) ? iso(quando + inteiro(200, 520) * 1000) : null,
        delivered_at: status === 'delivered' ? iso(quando + inteiro(540, 900) * 1000) : null,
      });
    }
  }

  await inserir('bar_orders', ['id', 'buyer_id', 'event_id', 'wallet_id', 'status', 'total_cents',
    'pickup_code', 'station', 'operator_id', 'table_id', 'waiter_id', 'created_at',
    'preparing_at', 'ready_at', 'delivered_at'], comandas);
  await inserir('bar_order_items', ['bar_order_id', 'menu_item_id', 'name', 'unit_price_cents', 'quantity'], itens, 'id');
  return comandas;
}

// ═══════════════════════════════════════════════════════════════════════
// Assentos marcados
// ═══════════════════════════════════════════════════════════════════════

/**
 * Mapa de assentos do setor numerado.
 *
 * Este é hoje o ÚNICO produtor de `event_seats` no projeto inteiro: a rota
 * POST /admin/events/:id/assentos existe e funciona, mas nenhuma tela do
 * cockpit a chama. Sem o seed, a tela de Assentos do app do cliente abre
 * vazia e o recurso parece não existir.
 *
 * O assento vendido passa pelo CAMINHO REAL — reservar_assentos segura,
 * vincular_assentos_ao_pedido amarra ao pedido e o gatilho da 0045 vira
 * para 'sold' quando o pedido é pago. Escrever status = 'sold' na mão
 * deixaria order_id nulo: o mapa mostraria a poltrona ocupada e a
 * conferência da casa não saberia por quem.
 */
async function semearAssentos({ eventoId, lote, compradores, janelaIni, janelaFim, prefixo }) {
  const SETOR = 'Arquibancada Premium';
  const FILEIRAS = 8;
  const POR_FILEIRA = 14;

  // Mesma regra de nomeação da API (seats/service.js): A, B, … Z, AA.
  const grade = [];
  for (let f = 0; f < FILEIRAS; f += 1) {
    const fileira = String.fromCharCode(65 + f);
    for (let c = 0; c < POR_FILEIRA; c += 1) {
      grade.push({
        event_id: eventoId, tier_id: lote.id, setor: SETOR, fileira,
        numero: c + 1, col: c, row_idx: f, status: 'free',
      });
    }
  }
  const criados = await inserir('event_seats',
    ['event_id', 'tier_id', 'setor', 'fileira', 'numero', 'col', 'row_idx', 'status'],
    grade, 'id, fileira, numero');
  const poltrona = new Map(criados.map((s) => [`${s.fileira}${s.numero}`, s.id]));
  const ids = (...chaves) => chaves.map((k) => poltrona.get(k)).filter(Boolean);

  // ── Bloqueados: existem em toda casa e não são falha de venda ──
  // Duas cadeiras de rodas com acompanhante nas pontas da fileira A e o
  // lugar que a mesa de som come na H. Sem eles o mapa vira uma grade
  // perfeita, que é o que nenhuma casa de verdade tem.
  await sql("update public.event_seats set status = 'blocked' where id = any($1)",
    [ids('A1', 'A2', 'A13', 'A14', 'H7')]);

  // ── Vendidos: cinco pedidos de verdade ──
  const grupos = [
    ['B4', 'B5', 'B6', 'B7', 'B8', 'B9'],
    ['C4', 'C5', 'C6', 'C7'],
    ['C8', 'C9'],
    ['D2', 'D3', 'D4', 'D5'],
    ['E7', 'E8', 'E9', 'E10'],
  ];
  const pedidos = [];
  const itens = [];
  const ingressos = [];
  let n = 0;

  for (const chaves of grupos) {
    const assentos = ids(...chaves);
    const comprador = compradores[(n * 5 + 3) % compradores.length];
    const nascido = janelaIni + rnd() * (janelaFim - janelaIni);
    const pagoEm = nascido + inteiro(40, 900) * 1000;
    const subtotal = lote.preco * assentos.length;
    const taxa = Math.round(subtotal * 0.10);
    const id = crypto.randomUUID();
    n += 1;

    // 1) Segura — a mesma RPC que o app chama quando a pessoa toca no mapa.
    const { rows: segurados } = await sql(
      'select id from public.reservar_assentos($1, $2, $3, $4)', [eventoId, assentos, comprador.id, 25]);
    if (segurados.length !== assentos.length) throw new Error(`assentos: reserva parcial no grupo ${chaves[0]}`);

    // 2) Pedido pendente + ingressos, como qualquer outra venda do seed.
    pedidos.push({
      id, buyer_id: comprador.id, event_id: eventoId, status: 'pending',
      total_cents: subtotal + taxa, service_fee_cents: taxa, discount_cents: 0,
      coupon_code: null, platform_fee_bps: 700,
      external_reference: `demo-${prefixo}-assento-${String(n).padStart(3, '0')}`,
      asaas_payment_id: `pay_demo_${prefixo}_seat_${String(n).padStart(3, '0')}`,
      asaas_customer_id: `cus_demo_${comprador.id.slice(0, 8)}`,
      created_at: iso(nascido), expires_at: iso(nascido + 30 * 60e3),
      _pagoEm: pagoEm, _assentos: assentos, _comprador: comprador,
    });
    itens.push({ order_id: id, ticket_tier_id: lote.id, unit_price_cents: lote.preco, quantity: assentos.length });
    for (let i = 0; i < assentos.length; i += 1) {
      ingressos.push({
        id: crypto.randomUUID(), order_id: id, event_id: eventoId, ticket_tier_id: lote.id,
        owner_id: comprador.id,
        code: `${prefixo}-A${String(ingressos.length + 1).padStart(3, '0')}-${crypto.randomBytes(2).toString('hex').toUpperCase()}`,
        holder_name: i === 0 ? comprador.nome : escolher(NOMES_LISTA),
        status: 'valid', created_at: iso(pagoEm),
      });
    }
  }

  await inserir('orders', ['id', 'buyer_id', 'event_id', 'status', 'total_cents', 'service_fee_cents',
    'discount_cents', 'coupon_code', 'platform_fee_bps', 'external_reference', 'asaas_payment_id',
    'asaas_customer_id', 'created_at', 'expires_at'], pedidos);
  await inserir('order_items', ['order_id', 'ticket_tier_id', 'unit_price_cents', 'quantity'], itens, 'id');
  await inserir('tickets', ['id', 'order_id', 'event_id', 'ticket_tier_id', 'owner_id', 'code',
    'holder_name', 'status', 'created_at'], ingressos);

  // 3) Amarra a reserva ao pedido — recusa se ela já venceu ou é de outro.
  for (const p of pedidos) {
    await sql('select public.vincular_assentos_ao_pedido($1, $2, $3)', [p.id, p._comprador.id, p._assentos]);
  }

  // 4) Paga. O gatilho da 0045 é quem escreve 'sold' e apaga held_until.
  await sql(`
    update public.orders o
       set status = 'paid', paid_at = v.pago::timestamptz
      from (select unnest($1::uuid[]) as id, unnest($2::text[]) as pago) v
     where o.id = v.id`,
  [pedidos.map((p) => p.id), pedidos.map((p) => iso(p._pagoEm))]);

  // ── Reservas VIVAS: duas pessoas com o mapa aberto agora ──
  // É o estado que a tela precisa mostrar e que só existe por alguns minutos
  // na vida real. `held_until` no futuro; liberar_assentos_vencidos, que roda
  // antes de toda leitura do mapa, deixa passar.
  const segurando = [
    [compradores[2], ['F5', 'F6']],
    [compradores[8], ['G9']],
  ];
  let segurados = 0;
  for (const [quem, chaves] of segurando) {
    const { rows } = await sql('select id from public.reservar_assentos($1, $2, $3, $4)',
      [eventoId, ids(...chaves), quem.id, 30]);
    segurados += rows.length;
  }

  return { total: criados.length, vendidos: ingressos.length, segurados, bloqueados: 5, setor: SETOR };
}

// ═══════════════════════════════════════════════════════════════════════
// Transferência de ingresso
// ═══════════════════════════════════════════════════════════════════════

/**
 * Passa ingressos de mão em mão pela RPC transferir_ingresso.
 *
 * Nunca por INSERT: é a RPC que rotaciona `code` e `qr_secret` (0052). Uma
 * linha inserida à mão em ticket_transfers descreveria uma transferência que
 * não aconteceu — o QR antigo continuaria abrindo a porta e a demo estaria
 * mostrando exatamente o bug que a 0052 consertou.
 *
 * Dois desfechos, os dois reais:
 *   · aceita   — o destinatário já tem conta; o ingresso troca de dono na hora
 *                e os dois lados recebem notificação (gatilho da 0054).
 *   · pendente — e-mail sem cadastro; o ingresso NÃO sai do dono atual e fica
 *                esperando o cadastro para o gatilho entregar.
 */
async function semearTransferencias(eventoId, clientes) {
  const { rows: candidatos } = await sql(`
    select id, owner_id from public.tickets
     where event_id = $1 and status = 'valid' and checked_in_at is null
     order by created_at, id limit 80`, [eventoId]);

  const daDemo = new Set(clientes.map((c) => c.id));
  const usados = new Set();
  const proximo = (evitar) => candidatos.find(
    (t) => !usados.has(t.id) && daDemo.has(t.owner_id) && t.owner_id !== evitar,
  );

  let aceitas = 0;
  let pendentes = 0;

  // ── Aceitas: quem recebeu já era do sistema ──
  for (const destino of [clientes[0], clientes[5], clientes[11]]) {
    const t = proximo(destino.id);
    if (!t) continue;
    usados.add(t.id);
    const { rows } = await sql('select public.transferir_ingresso($1, $2, $3) as r',
      [t.id, t.owner_id, destino.email]);
    if (rows[0].r?.status === 'accepted') aceitas += 1;
  }

  // ── Pendentes: e-mail que ainda não virou conta ──
  for (const [, email] of SEM_CONTA) {
    const t = proximo(null);
    if (!t) continue;
    usados.add(t.id);
    const { rows } = await sql('select public.transferir_ingresso($1, $2, $3) as r',
      [t.id, t.owner_id, email]);
    if (rows[0].r?.status === 'pending') pendentes += 1;
  }

  // A transferência acontece "agora" porque a RPC carimba now(). Recua para a
  // semana passada: uma transferência de segundos atrás num evento que só
  // acontece daqui a 38 dias faz a trilha parecer encenada — que é o que é,
  // mas não pode parecer.
  await sql(`
    update public.ticket_transfers tt
       set created_at = now() - make_interval(days => 1 + (abs(hashtext(tt.id::text)) % 9)),
           accepted_at = case when tt.accepted_at is null then null
                         else now() - make_interval(days => 1 + (abs(hashtext(tt.id::text)) % 9)) end
     where tt.ticket_id in (select id from public.tickets where event_id = $1)`, [eventoId]);
  // As notificações que o gatilho acabou de criar carregam o mesmo "agora".
  // Não há como casar cada aviso com a sua transferência (notificacoes não
  // guarda o ticket), então elas recuam em bloco — o suficiente para o sino
  // não mostrar cinco avisos no mesmo segundo.
  await sql(`
    update public.notificacoes n
       set created_at = now() - make_interval(days => 1 + (abs(hashtext(n.id::text)) % 9)),
           lida_em = case when n.tipo = 'ingresso_enviado'
                          then now() - make_interval(days => 1 + (abs(hashtext(n.id::text)) % 9)) + interval '2 hours'
                          else null end
     where n.event_id = $1 and n.tipo in ('ingresso_recebido', 'ingresso_enviado')`, [eventoId]);

  return { aceitas, pendentes };
}

// ═══════════════════════════════════════════════════════════════════════
// Pedidos que não viraram ingresso
// ═══════════════════════════════════════════════════════════════════════

/**
 * O carrinho abandonado, o PIX que não caiu e a desistência.
 *
 * Sem eles a tela "Meus pedidos" só sabe pintar 'paid' e 'refunded' — três
 * dos cinco estados do enum ficam sem cobertura visual, e a produtora nunca
 * vê a diferença entre "não vendeu" e "vendeu e devolveu", que é a distinção
 * que decide se o problema está no preço ou no checkout.
 *
 * SEM ingresso, de propósito: no fluxo real o ingresso só é emitido em
 * confirm_order_payment. Pedido pendente com ingresso emitido seria um
 * ingresso válido de graça.
 *
 * `expires_at` dos pendentes fica no FUTURO porque o cron expire_pending_orders
 * roda no banco: com data vencida, o pendente da demo viraria expirado sozinho
 * antes da apresentação.
 */
async function semearPedidosIncompletos({ eventoId, lotes, compradores, prefixo }) {
  const pedidos = [];
  const itens = [];
  const finais = [];
  let n = 0;

  const criar = (statusFinal, nascido, expira) => {
    const lote = escolher(lotes.filter((l) => l.status !== 'sold_out'));
    const qtd = escolher([1, 1, 2, 2, 3]);
    const comprador = escolher(compradores);
    const subtotal = lote.preco * qtd;
    const taxa = Math.round(subtotal * 0.10);
    const id = crypto.randomUUID();
    n += 1;
    pedidos.push({
      id, buyer_id: comprador.id, event_id: eventoId, status: 'pending',
      total_cents: subtotal + taxa, service_fee_cents: taxa, discount_cents: 0,
      coupon_code: null, platform_fee_bps: 700,
      external_reference: `demo-${prefixo}-aberto-${String(n).padStart(3, '0')}`,
      asaas_payment_id: `pay_demo_${prefixo}_open_${String(n).padStart(3, '0')}`,
      asaas_customer_id: `cus_demo_${comprador.id.slice(0, 8)}`,
      created_at: iso(nascido), expires_at: iso(expira),
    });
    itens.push({ order_id: id, ticket_tier_id: lote.id, unit_price_cents: lote.preco, quantity: qtd });
    if (statusFinal !== 'pending') finais.push({ id, status: statusFinal });
  };

  // Aguardando pagamento AGORA — o PIX ainda está aberto no celular.
  // O prazo é generoso (45 min a 5 h) e não os 30 min do fluxo real por um
  // motivo prático: o cron expire_pending_orders roda de 2 em 2 minutos no
  // banco. Com prazo curto, os pendentes da demo viravam expirados meia hora
  // depois do seed, e a tela perdia o estado justamente durante a conversa.
  for (let i = 0; i < 5; i += 1) criar('pending', AGORA - inteiro(2, 22) * 60e3, AGORA + inteiro(45, 300) * 60e3);
  // Carrinho abandonado: nasceu, o QR do PIX venceu, ninguém voltou.
  for (let i = 0; i < 7; i += 1) {
    const nascido = AGORA - inteiro(2, 15) * D;
    criar('expired', nascido, nascido + 30 * 60e3);
  }
  // Desistência explícita, antes de pagar.
  for (let i = 0; i < 3; i += 1) {
    const nascido = AGORA - inteiro(1, 9) * D;
    criar('cancelled', nascido, nascido + 30 * 60e3);
  }

  await inserir('orders', ['id', 'buyer_id', 'event_id', 'status', 'total_cents', 'service_fee_cents',
    'discount_cents', 'coupon_code', 'platform_fee_bps', 'external_reference', 'asaas_payment_id',
    'asaas_customer_id', 'created_at', 'expires_at'], pedidos);
  await inserir('order_items', ['order_id', 'ticket_tier_id', 'unit_price_cents', 'quantity'], itens, 'id');

  // O estado final entra por UPDATE, não no INSERT: é a transição que os
  // gatilhos escutam (assentos, notificação, webhook). Nascer já expirado
  // seria um pedido que nunca existiu para o resto do banco.
  if (finais.length) {
    await sql(`
      update public.orders o set status = v.st::order_status
        from (select unnest($1::uuid[]) as id, unnest($2::text[]) as st) v
       where o.id = v.id`,
    [finais.map((f) => f.id), finais.map((f) => f.status)]);
  }

  return { pendentes: 5, expirados: 7, cancelados: 3 };
}

// ═══════════════════════════════════════════════════════════════════════
// Roteiro principal
// ═══════════════════════════════════════════════════════════════════════

async function main() {
  cliente = await conectar();
  const db = admin();

  console.log('\n▸ conferindo o dono…');
  const dono = await acharDono();
  passo(`dono: ${dono.email} (${dono.full_name ?? 'sem nome'})`);

  console.log('\n▸ contas de demonstração…');
  const clientes = [];
  for (const [nome, apelido] of CLIENTES) clientes.push(await garantirConta(db, apelido, nome, 'cliente'));
  const equipe = {};
  for (const [nome, apelido, papel] of EQUIPE) equipe[apelido] = await garantirConta(db, apelido, nome, 'cliente');
  const promoters = [];
  for (const [nome, apelido] of PROMOTERS) promoters.push(await garantirConta(db, apelido, nome, 'promoter'));
  const donaMare = await garantirConta(db, DONA_MARE[1], DONA_MARE[0], 'produtora');
  const perfisDemo = [...clientes, ...Object.values(equipe), ...promoters, donaMare];
  passo(`${perfisDemo.length} contas fictícias prontas (senha única: ${SENHA})`);

  console.log('\n▸ organizações…');
  const orgId = await upsertOrg(dono.id);
  const orgMare = await upsertOrgMare(donaMare.id);
  // As duas limpezas ANTES de qualquer criação: limpar apaga carteiras e
  // notificações por PERFIL, e os perfis são os mesmos nas duas casas. Se a
  // segunda limpeza rodasse depois da primeira semeadura, levaria junto o
  // que a primeira acabou de criar.
  const eventosAntes = await limpar(orgId, perfisDemo, [SLUG_PASSADO, SLUG_HOJE, SLUG_FUTURO])
    + await limpar(orgMare, perfisDemo, [SLUG_MARE_PASSADO, SLUG_MARE_FUTURO]);
  await limparPerfis(perfisDemo);
  passo(`limpeza: ${eventosAntes} evento(s) da demo esvaziados antes de recriar`);
  passo('produtora: Nébula Produções (roxo #7C3AED, site e Instagram preenchidos)');
  passo('segunda produtora: Coletivo Maré (Niterói) — o ranking do PulseADM precisa de contraste');

  // ── Os três eventos ──
  const evPassado = await upsertEvento(orgId, {
    title: 'Nébula Sunset · Edição Inverno',
    slug: SLUG_PASSADO,
    description: 'A edição que fechou o inverno com line-up de house brasileiro e pôr do sol na cobertura. '
      + 'Casa cheia das 18h às 2h, com Front Stage esgotado em nove dias.',
    venue: 'Audio Club', address: 'Av. Francisco Matarazzo, 694 — Água Branca',
    city: 'São Paulo', state: 'SP',
    starts: iso(AGORA - 21 * D - 6 * H), ends: iso(AGORA - 21 * D + 2 * H),
    status: 'ended', lat: -23.5275, lng: -46.6857,
  });
  const evHoje = await upsertEvento(orgId, {
    title: 'Nébula Noturna · Rooftop Vila Olímpia',
    slug: SLUG_HOJE,
    description: 'Noite de open format no rooftop: house às 22h, brasilidades depois da 1h. '
      + 'Camarote com open bar de gin e vista para a ponte.',
    venue: 'Rooftop Vila Olímpia', address: 'R. Fiandeiras, 929 — Vila Olímpia',
    city: 'São Paulo', state: 'SP',
    starts: iso(AGORA - 2 * H), ends: iso(AGORA + 5 * H),
    status: 'published', lat: -23.5955, lng: -46.6890, reentrada: true,
  });
  const evFuturo = await upsertEvento(orgId, {
    title: 'Nébula Open Air · Marina da Glória',
    slug: SLUG_FUTURO,
    description: 'Doze horas de festa à beira da Baía de Guanabara, com três palcos e '
      + 'convidados internacionais. Lote promocional acabando.',
    venue: 'Marina da Glória', address: 'Av. Infante Dom Henrique, s/n — Glória',
    city: 'Rio de Janeiro', state: 'RJ',
    starts: iso(AGORA + 38 * D), ends: iso(AGORA + 38 * D + 11 * H),
    status: 'published', lat: -22.9195, lng: -43.1690,
  });
  // ── Capas e logo ──
  // Sem cover_url o card da vitrine é um retângulo cinza, e é a vitrine que
  // abre a conversa com os sócios. As imagens são geradas e enviadas ao
  // Storage no mesmo caminho toda execução (upsert), então não acumulam lixo.
  const capas = [
    [evPassado, '#4C1D95', '#DB2777'],
    [evHoje, '#5B21B6', '#22D3EE'],
    [evFuturo, '#0F766E', '#A855F7'],
  ];
  let capasOk = 0;
  for (const [id, corA, corB] of capas) {
    const url = await subirImagem(db, 'event-covers', `demo/${id}.png`, capaPng({ corA, corB }), 'image/png');
    if (url) { await sql('update public.events set cover_url = $2 where id = $1', [id, url]); capasOk += 1; }
  }
  const urlLogo = await subirImagem(db, 'org-logos', `demo/${orgId}.svg`, Buffer.from(logoSvg(), 'utf8'), 'image/svg+xml');
  if (urlLogo) await sql('update public.organizations set logo_url = $2 where id = $1', [orgId, urlLogo]);
  passo('3 eventos: um encerrado, um NO AR agora, um com vendas abertas');
  passo(`capas: ${capasOk}/3 enviadas ao Storage; logo da produtora ${urlLogo ? 'no ar' : 'não subiu (bucket org-logos)'}`);

  // ── Fidelidade ligada ANTES das vendas: o gatilho de acúmulo só olha a
  //    configuração no instante em que o pedido vira pago. ──
  await sql(`
    insert into public.fidelidade_config (organization_id, ativo, pontos_por_real, centavos_por_ponto, minimo_resgate, updated_by)
    values ($1, true, 1, 10, 100, $2)
    on conflict (organization_id) do update set
      ativo = true, pontos_por_real = 1, centavos_por_ponto = 10, minimo_resgate = 100, updated_by = $2`,
  [orgId, dono.id]);
  passo('fidelidade ATIVA: 1 ponto por real, 1 ponto = R$ 0,10, resgate mínimo 100 pontos');

  // ── Lotes ──
  const lotes = async (eventoId, defs) => {
    const rows = await inserir('ticket_tiers',
      ['event_id', 'name', 'description', 'price_cents', 'half_price_cents', 'quantity_total',
        'quantity_sold', 'max_per_order', 'status', 'position', 'sales_start', 'sales_end'],
      defs.map((d, i) => ({
        event_id: eventoId, name: d.nome, description: d.desc ?? null,
        price_cents: d.preco, half_price_cents: d.meia ?? null,
        quantity_total: d.total, quantity_sold: 0, max_per_order: d.maxPedido ?? 6,
        status: d.status ?? 'on_sale', position: i,
        sales_start: d.inicio ?? null, sales_end: d.fim ?? null,
      })), 'id, name');
    return rows.map((r, i) => ({ ...r, ...defs[i] }));
  };

  const lotesPassado = await lotes(evPassado, [
    { nome: 'Pista · Antecipada', preco: 6000, meia: 3000, total: 150, vender: 150, status: 'sold_out' },
    { nome: 'Pista · 2º Lote', preco: 8000, meia: 4000, total: 100, vender: 62, status: 'closed' },
    { nome: 'Front Stage', preco: 14000, total: 30, vender: 27, status: 'closed', maxPedido: 4 },
  ]);
  const lotesHoje = await lotes(evHoje, [
    { nome: 'Pista · 1º Lote', preco: 7000, meia: 3500, total: 60, vender: 60, status: 'sold_out',
      desc: 'Esgotado em 4 dias.' },
    { nome: 'Pista · 2º Lote', preco: 9000, meia: 4500, total: 120, vender: 74 },
    { nome: 'Camarote Open Bar', preco: 22000, total: 20, vender: 18, maxPedido: 4,
      desc: 'Open bar de gin e espumante até as 2h. Últimas unidades.' },
  ]);
  const lotesFuturo = await lotes(evFuturo, [
    { nome: 'Lote Promocional', preco: 12000, meia: 6000, total: 120, vender: 108,
      desc: 'Preço de lançamento — acabando.' },
    { nome: '1º Lote', preco: 18000, meia: 9000, total: 400, vender: 42 },
    { nome: 'Camarote Nébula', preco: 45000, total: 24, vender: 5, maxPedido: 4,
      desc: 'Mesa para 6, welcome drink e entrada exclusiva.' },
    // `vender: 0` porque este lote não é vendido por quantidade: cada unidade
    // é uma poltrona escolhida no mapa, e quem vende é semearAssentos.
    { nome: 'Arquibancada Premium', preco: 15000, meia: 7500, total: 112, vender: 0, maxPedido: 6,
      desc: 'Lugar numerado com vista para o palco principal. Escolha a poltrona no mapa.' },
  ]);
  passo('10 lotes com preço, meia-entrada e estoque (dois esgotados, um por assento numerado)');

  // ── Cupons ──
  await inserir('coupons', ['event_id', 'code', 'kind', 'value', 'max_uses', 'used_count', 'active', 'expires_at'], [
    { event_id: evHoje, code: 'NEBULA10', kind: 'percent', value: 10, max_uses: 200, used_count: 47, active: true, expires_at: iso(AGORA + 5 * H) },
    { event_id: evHoje, code: 'ANIVER25', kind: 'percent', value: 25, max_uses: 40, used_count: 12, active: true, expires_at: iso(AGORA + 5 * H) },
    { event_id: evFuturo, code: 'OPENAIR15', kind: 'percent', value: 15, max_uses: 500, used_count: 63, active: true, expires_at: iso(AGORA + 30 * D) },
    { event_id: evFuturo, code: 'RJ20', kind: 'fixed', value: 2000, max_uses: 100, used_count: 8, active: true, expires_at: null },
    { event_id: evPassado, code: 'INVERNO10', kind: 'percent', value: 10, max_uses: 150, used_count: 96, active: false, expires_at: iso(AGORA - 21 * D) },
    // Esgotado: ativo, no prazo, e mesmo assim recusado — used_count bateu no
    // teto. É o caso que mais gera reclamação na porta e o que a tela precisa
    // saber distinguir de "cupom inválido".
    { event_id: evHoje, code: 'ROOFTOP5', kind: 'fixed', value: 1500, max_uses: 30, used_count: 30, active: true, expires_at: iso(AGORA + 5 * H) },
    // Expirado sem ninguém ter desligado: ativo = true, prazo vencido há 3
    // dias. Diferente do INVERNO10, que foi desativado na mão.
    { event_id: evFuturo, code: 'PREVENDA20', kind: 'percent', value: 20, max_uses: 300, used_count: 118, active: true, expires_at: iso(AGORA - 3 * D) },
  ], 'id');
  passo('7 cupons: ativos com uso parcial, um ESGOTADO, um EXPIRADO ainda ligado e um desativado');

  // ── Equipe ──
  await inserir('event_staff', ['event_id', 'user_id', 'role', 'permissoes', 'created_by', 'created_at'],
    [evHoje, evPassado, evFuturo].flatMap((ev, idx) => EQUIPE.map(([, apelido, papel, permissoes]) => ({
      event_id: ev, user_id: equipe[apelido].id, role: papel, permissoes,
      created_by: dono.id, created_at: iso(AGORA - (idx === 1 ? 30 : 12) * D),
    }))), 'id');
  passo('equipe escalada nos 3 eventos: porta, bar, salão e gerente — com permissões granulares');

  // ═══ EVENTO PASSADO — a história fechada ═══
  console.log('\n▸ evento encerrado (21 dias atrás)…');
  const iniP = AGORA - 55 * D;
  const fimP = AGORA - 21 * D - 8 * H;
  const vendaP = await venderIngressos({
    eventoId: evPassado, prefixo: 'SUN', lotes: lotesPassado, compradores: clientes,
    janelaIni: iniP, janelaFim: fimP, taxaEstorno: 0.11, cupom: 'INVERNO10',
  });
  const entradosP = await fazerCheckin(evPassado, vendaP.ingressos, 0.88, equipe['sandro.barreto'].id,
    AGORA - 21 * D - 6 * H, AGORA - 21 * D - 1 * H, { reentradas: 14, saidas: 21, naoVao: clientes.slice(16).map((c) => c.id) });
  passo(`passado: ${vendaP.pedidos.length} pedidos, ${vendaP.ingressos.length} ingressos, ${entradosP.length} check-ins`);

  const cardapioP = await semearCardapio(evPassado, CARDAPIO.slice(0, 10));

  // ═══ EVENTO DE HOJE — a operação ao vivo ═══
  console.log('\n▸ evento no ar agora…');
  const iniH = AGORA - 26 * D;
  const vendaH = await venderIngressos({
    eventoId: evHoje, prefixo: 'NOT', lotes: lotesHoje, compradores: clientes,
    janelaIni: iniH, janelaFim: AGORA - 30 * 60e3, taxaEstorno: 0.07, cupom: 'NEBULA10',
  });
  const entradosH = await fazerCheckin(evHoje, vendaH.ingressos, 0.64, equipe['sandro.barreto'].id,
    AGORA - 2 * H, AGORA - 4 * 60e3, { reentradas: 18, saidas: 9, naoVao: clientes.slice(14).map((c) => c.id) });
  passo(`hoje: ${vendaH.pedidos.length} pedidos, ${vendaH.ingressos.length} ingressos, ${entradosH.length} já na casa`);
  passo('porta de hoje: 18 pessoas saíram e VOLTARAM (reentrada ligada, máx. 2) e 9 foram embora');

  // ═══ EVENTO FUTURO — vendas abertas ═══
  console.log('\n▸ evento futuro…');
  const vendaF = await venderIngressos({
    eventoId: evFuturo, prefixo: 'OPN', lotes: lotesFuturo, compradores: clientes,
    janelaIni: AGORA - 19 * D, janelaFim: AGORA - 20 * 60e3, taxaEstorno: 0.035, cupom: 'OPENAIR15',
  });
  passo(`futuro: ${vendaF.pedidos.length} pedidos em pré-venda, ${vendaF.ingressos.length} ingressos emitidos`);

  // ── Mapa de assentos ──
  // Vai no evento FUTURO porque o mapa só é público para evento 'published' e
  // porque reserva temporária viva num evento que já acabou não faz sentido.
  const mapa = await semearAssentos({
    eventoId: evFuturo, lote: lotesFuturo[3], compradores: clientes,
    janelaIni: AGORA - 17 * D, janelaFim: AGORA - 2 * D, prefixo: 'OPN',
  });
  passo(`assentos: setor "${mapa.setor}" com ${mapa.total} poltronas — ${mapa.vendidos} vendidas por pedido pago, `
    + `${mapa.segurados} com reserva VIVA agora e ${mapa.bloqueados} bloqueadas (cadeirante e mesa de som)`);

  // ── Pedidos que não viraram ingresso ──
  const abertos = await semearPedidosIncompletos({
    eventoId: evFuturo, lotes: lotesFuturo.slice(0, 2), compradores: clientes, prefixo: 'OPN',
  });
  passo(`pedidos em aberto: ${abertos.pendentes} aguardando PIX, ${abertos.expirados} expirados e ${abertos.cancelados} cancelados`);

  // quantity_sold precisa bater com os ingressos que existem de fato: é esse
  // número que desenha a barra de "quase esgotado" na vitrine.
  await sql(`
    update public.ticket_tiers t
       set quantity_sold = least(t.quantity_total, coalesce(c.n, 0)),
           status = case when coalesce(c.n,0) >= t.quantity_total then 'sold_out'::tier_status else t.status end
      from (select ticket_tier_id, count(*) n from public.tickets
             where event_id = any($1) and status <> 'cancelled' group by 1) c
     where t.id = c.ticket_tier_id`, [[evPassado, evHoje, evFuturo]]);

  // ── Notificações: o gatilho carimba "agora"; aqui elas voltam para a data
  //    do pagamento, senão um pedido de 40 dias atrás avisaria hoje. ──
  await sql(`
    update public.notificacoes n
       set created_at = o.paid_at,
           lida_em = case when o.paid_at < now() - interval '2 days' then o.paid_at + interval '3 hours' else null end
      from public.orders o
     where n.event_id = any($1) and n.destino = '/pedido/' || o.id || '/confirmado'`,
  [[evPassado, evHoje, evFuturo]]);

  // ── Transferências ──
  // Depois das notificações voltarem no tempo, porque a transferência gera
  // notificação nova e ela tem o seu próprio recuo.
  const transf = await semearTransferencias(evFuturo, clientes);
  passo(`transferências: ${transf.aceitas} aceitas (QR rotacionado pela RPC) e ${transf.pendentes} pendentes para e-mail sem conta`);

  // ═══ Promoters e lista ═══
  console.log('\n▸ promoters e lista de convidados…');
  const promoRows = await inserir('promoters',
    ['organization_id', 'event_id', 'profile_id', 'name', 'code', 'commission_cents',
      'goal_checkins', 'list_type', 'free_until', 'clicks', 'created_at', 'commission_paid_at'],
    [
      { organization_id: orgId, event_id: evHoje, profile_id: promoters[0].id, name: 'Rafaela Antunes',
        code: 'rafaela-nebula', commission_cents: 800, goal_checkins: 60, list_type: 'free_until',
        free_until: iso(AGORA - 1 * H), clicks: 1284, created_at: iso(AGORA - 24 * D), commission_paid_at: null },
      { organization_id: orgId, event_id: evHoje, profile_id: promoters[1].id, name: 'Diego Sampaio',
        code: 'diego-nebula', commission_cents: 800, goal_checkins: 40, list_type: 'standard',
        free_until: null, clicks: 673, created_at: iso(AGORA - 24 * D), commission_paid_at: null },
      { organization_id: orgId, event_id: evHoje, profile_id: promoters[2].id, name: 'Yasmin Cavalcanti',
        code: 'yasmin-nebula', commission_cents: 600, goal_checkins: 30, list_type: 'birthday',
        free_until: null, clicks: 402, created_at: iso(AGORA - 18 * D), commission_paid_at: null },
      { organization_id: orgId, event_id: evPassado, profile_id: promoters[0].id, name: 'Rafaela Antunes',
        code: 'rafaela-sunset', commission_cents: 800, goal_checkins: 50, list_type: 'free_until',
        free_until: iso(AGORA - 21 * D - 5 * H), clicks: 2140, created_at: iso(AGORA - 52 * D),
        commission_paid_at: iso(AGORA - 14 * D) },
      { organization_id: orgId, event_id: evPassado, profile_id: promoters[1].id, name: 'Diego Sampaio',
        code: 'diego-sunset', commission_cents: 800, goal_checkins: 40, list_type: 'standard',
        free_until: null, clicks: 918, created_at: iso(AGORA - 52 * D), commission_paid_at: iso(AGORA - 14 * D) },
      { organization_id: orgId, event_id: evFuturo, profile_id: promoters[0].id, name: 'Rafaela Antunes',
        code: 'rafaela-openair', commission_cents: 1200, goal_checkins: 80, list_type: 'standard',
        free_until: null, clicks: 331, created_at: iso(AGORA - 19 * D), commission_paid_at: null },
    ], 'id, event_id, name');

  const convidados = [];
  let seqNome = 0;
  const proximoNome = () => NOMES_LISTA[(seqNome += 1) % NOMES_LISTA.length];
  for (const p of promoRows) {
    const noAr = p.event_id === evHoje;
    const encerrado = p.event_id === evPassado;
    const quantos = encerrado ? 34 : noAr ? 28 : 11;
    for (let i = 0; i < quantos; i += 1) {
      const nome = proximoNome();
      const acompanhantes = talvez(0.3) ? inteiro(2, 4) : 1;
      // Na lista do evento em andamento, parte já entrou e parte ainda vem.
      const entrou = encerrado ? talvez(0.82) : noAr ? talvez(0.55) : false;
      const quando = encerrado ? AGORA - 21 * D - 5 * H + rnd() * 4 * H : AGORA - 2 * H + rnd() * 1.8 * H;
      convidados.push({
        promoter_id: p.id, event_id: p.event_id, name: nome,
        email: `${nome.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z]+/g, '.')}${DOMINIO}`,
        phone: `+55 11 9${inteiro(4000, 9999)}-${inteiro(1000, 9999)}`,
        status: entrou ? 'checked_in' : (talvez(0.05) ? 'cancelled' : 'confirmed'),
        party_size: acompanhantes,
        checked_in_count: entrou ? (acompanhantes > 1 && talvez(0.6) ? inteiro(1, acompanhantes) : acompanhantes) : 0,
        checked_in_at: entrou ? iso(quando) : null,
        created_at: iso((encerrado ? AGORA - 30 * D : AGORA - 12 * D) + rnd() * 8 * D),
      });
    }
  }
  await inserir('guests', ['promoter_id', 'event_id', 'name', 'email', 'phone', 'status',
    'party_size', 'checked_in_count', 'checked_in_at', 'created_at'], convidados, 'id');
  passo(`${promoRows.length} promoters com código próprio e ${convidados.length} convidados na lista`);

  // ═══ Cardápio, mesas e bar do evento de hoje ═══
  console.log('\n▸ bar, cozinha e salão…');
  const cardapioH = await semearCardapio(evHoje);

  const mesasRows = await inserir('event_tables', ['event_id', 'name', 'area', 'capacity', 'min_spend_cents', 'active', 'position'], [
    { event_id: evHoje, name: 'Camarote 01', area: 'Camarote', capacity: 10, min_spend_cents: 120000, active: true, position: 0 },
    { event_id: evHoje, name: 'Camarote 02', area: 'Camarote', capacity: 10, min_spend_cents: 120000, active: true, position: 1 },
    { event_id: evHoje, name: 'Lounge 1', area: 'Lounge', capacity: 6, min_spend_cents: 40000, active: true, position: 2 },
    { event_id: evHoje, name: 'Lounge 2', area: 'Lounge', capacity: 6, min_spend_cents: 40000, active: true, position: 3 },
    { event_id: evHoje, name: 'Lounge 3', area: 'Lounge', capacity: 6, min_spend_cents: 40000, active: true, position: 4 },
    { event_id: evHoje, name: 'Bistrô 1', area: 'Salão', capacity: 4, min_spend_cents: 20000, active: true, position: 5 },
    { event_id: evHoje, name: 'Bistrô 2', area: 'Salão', capacity: 4, min_spend_cents: 20000, active: true, position: 6 },
  ], 'id, name');
  const mesaPor = (nome) => mesasRows.find((m) => m.name === nome);

  await inserir('table_reservations',
    ['table_id', 'event_id', 'profile_id', 'name', 'contact', 'party_size', 'status', 'notes', 'ocasiao', 'created_at', 'seated_at'], [
      { table_id: mesaPor('Camarote 01').id, event_id: evHoje, profile_id: clientes[12].id,
        name: 'Isabela Menezes', contact: '+55 11 98812-4477', party_size: 9, status: 'seated',
        notes: 'Chegaram 21h40. Pediram gelo extra e taças de espumante.', ocasiao: 'Aniversário',
        created_at: iso(AGORA - 9 * D), seated_at: iso(AGORA - 100 * 60e3) },
      { table_id: mesaPor('Camarote 02').id, event_id: evHoje, profile_id: clientes[3].id,
        name: 'Thiago Marinho', contact: '+55 11 99640-2031', party_size: 8, status: 'confirmed',
        notes: 'Confirmou por WhatsApp. Chega depois da meia-noite.', ocasiao: 'Confraternização',
        created_at: iso(AGORA - 6 * D), seated_at: null },
      { table_id: mesaPor('Lounge 1').id, event_id: evHoje, profile_id: clientes[6].id,
        name: 'Beatriz Salgado', contact: '+55 11 99110-8890', party_size: 5, status: 'confirmed',
        notes: null, ocasiao: null, created_at: iso(AGORA - 3 * D), seated_at: null },
      { table_id: mesaPor('Lounge 2').id, event_id: evHoje, profile_id: clientes[9].id,
        name: 'Felipe Andrade', contact: '+55 11 98003-7712', party_size: 6, status: 'requested',
        notes: 'Pediu mesa perto da pista. Aguardando aprovação.', ocasiao: 'Despedida de solteiro',
        created_at: iso(AGORA - 40 * 60e3), seated_at: null },
      { table_id: mesaPor('Bistrô 1').id, event_id: evHoje, profile_id: null,
        name: 'Carla Meneghetti', contact: '+55 11 97744-1180', party_size: 4, status: 'rejected',
        notes: 'Sem disponibilidade no horário pedido.', ocasiao: null,
        created_at: iso(AGORA - 2 * D), seated_at: null },
    ], 'id');
  passo('7 mesas/camarotes: uma ocupada, duas reservadas, uma pendente, uma recusada, o resto livre');

  // ── Carteiras (cashless) ──
  const carteirasRows = await inserir('wallets', ['profile_id', 'event_id', 'balance_cents', 'created_at'],
    clientes.map((c) => ({ profile_id: c.id, event_id: null, balance_cents: 0, created_at: iso(AGORA - inteiro(20, 60) * D) })),
    'id, profile_id');
  const carteiras = new Map(carteirasRows.map((w) => [w.profile_id, w.id]));

  const recargas = [];
  const movimentos = [];
  for (const c of clientes) {
    const wid = carteiras.get(c.id);
    let saldo = 0;
    const nRecargas = inteiro(1, 3);
    for (let i = 0; i < nRecargas; i += 1) {
      const valor = escolher([5000, 10000, 10000, 15000, 20000, 30000]);
      const quando = AGORA - inteiro(1, 40) * D + inteiro(0, 20) * H;
      recargas.push({
        profile_id: c.id, event_id: quando > AGORA - 2 * H ? evHoje : null, amount_cents: valor,
        status: 'paid', asaas_payment_id: `pay_top_${crypto.randomBytes(4).toString('hex')}`,
        external_reference: `demo-top-${crypto.randomBytes(5).toString('hex')}`,
        created_at: iso(quando), paid_at: iso(quando + inteiro(30, 400) * 1000),
      });
      movimentos.push({ wallet_id: wid, type: 'topup', amount_cents: valor, description: 'Recarga via PIX', created_at: iso(quando + 400e3) });
      saldo += valor;
    }
    // Consumo no bar — o extrato precisa ter os dois lados.
    const gastos = inteiro(1, 4);
    for (let i = 0; i < gastos && saldo > 3000; i += 1) {
      const valor = Math.min(saldo - 1000, escolher([1400, 1800, 2600, 3400, 5200, 6800]));
      movimentos.push({ wallet_id: wid, type: 'spend', amount_cents: -valor, description: 'Consumo no bar', created_at: iso(AGORA - inteiro(1, 30) * D) });
      saldo -= valor;
    }
    if (talvez(0.15)) {
      movimentos.push({ wallet_id: wid, type: 'refund', amount_cents: 1400, description: 'Estorno de item indisponível', created_at: iso(AGORA - inteiro(1, 10) * D) });
      saldo += 1400;
    }
  }
  // Uma recarga pendente e uma expirada: a tela de carteira precisa mostrar
  // que nem toda recarga fecha.
  recargas.push({
    profile_id: clientes[4].id, event_id: evHoje, amount_cents: 10000, status: 'pending',
    asaas_payment_id: `pay_top_${crypto.randomBytes(4).toString('hex')}`,
    external_reference: `demo-top-${crypto.randomBytes(5).toString('hex')}`,
    created_at: iso(AGORA - 12 * 60e3), paid_at: null,
  });
  recargas.push({
    profile_id: clientes[7].id, event_id: null, amount_cents: 5000, status: 'expired',
    asaas_payment_id: `pay_top_${crypto.randomBytes(4).toString('hex')}`,
    external_reference: `demo-top-${crypto.randomBytes(5).toString('hex')}`,
    created_at: iso(AGORA - 9 * D), paid_at: null,
  });
  await inserir('wallet_topups', ['profile_id', 'event_id', 'amount_cents', 'status', 'asaas_payment_id',
    'external_reference', 'created_at', 'paid_at'], recargas, 'id');
  await inserir('wallet_transactions', ['wallet_id', 'type', 'amount_cents', 'description', 'created_at'], movimentos, 'id');
  // O saldo é a soma do extrato — nunca um número inventado à parte.
  await sql(`
    update public.wallets w set balance_cents = coalesce(s.total, 0)
      from (select wallet_id, sum(amount_cents)::int total from public.wallet_transactions group by 1) s
     where w.id = s.wallet_id and w.profile_id = any($1)`, [clientes.map((c) => c.id)]);

  // ── Saldo DEVEDOR ──
  // Possível desde a 0035: a recarga é estornada pelo banco depois que o
  // dinheiro já virou chopp. A tela de Carteira trata (rótulo muda para
  // "Saldo devedor", valor em vermelho, botão Sacar desligado) e sem uma
  // carteira assim esse ramo nunca aparece.
  const devedor = clientes[7];
  const carteiraDevedor = carteiras.get(devedor.id);
  const { rows: [saldoAtual] } = await sql('select balance_cents from public.wallets where id = $1', [carteiraDevedor]);
  await inserir('wallet_transactions', ['wallet_id', 'type', 'amount_cents', 'description', 'created_at'], [{
    wallet_id: carteiraDevedor, type: 'adjustment',
    amount_cents: -(saldoAtual.balance_cents + 4380),
    description: 'Recarga de R$ 100,00 estornada pelo banco após o consumo no bar',
    created_at: iso(AGORA - 4 * D),
  }], 'id');
  await sql(`
    update public.wallets w set balance_cents = coalesce(s.total, 0)
      from (select wallet_id, sum(amount_cents)::int total from public.wallet_transactions group by 1) s
     where w.id = s.wallet_id and w.id = $1`, [carteiraDevedor]);

  // ── Carteira BLOQUEADA ──
  // Bloqueio é informativo no app e recusa de verdade no servidor
  // (WALLET_BLOCKED → 409 no gasto). Precisa de motivo escrito: bloqueio sem
  // explicação é o tipo de coisa que vira reclamação na porta.
  const bloqueado = clientes[13];
  await sql(`
    update public.wallets
       set blocked_at = $2, block_reason = $3
     where profile_id = $1 and event_id is null`,
  [bloqueado.id, iso(AGORA - 2 * D),
    'Contestação de recarga em análise pelo banco. Liberamos assim que o Asaas confirmar.']);

  passo(`${carteirasRows.length} carteiras (saldo = soma do extrato) — uma DEVEDORA e uma BLOQUEADA com motivo`);

  // ── Comandas ──
  const comandasH = await semearComandas({
    eventoId: evHoje, cardapio: cardapioH, compradores: clientes, carteiras, mesas: mesasRows,
    operadorId: equipe['kelly.nakamura'].id, garcomId: equipe['wesley.duarte'].id,
    janelaIni: AGORA - 2 * H, janelaFim: AGORA - 60e3,
    distribuicao: { delivered: 34, paid: 12, preparing: 6, ready: 5, cancelled: 2 },
  });
  const comandasP = await semearComandas({
    eventoId: evPassado, cardapio: cardapioP, compradores: clientes, carteiras, mesas: [],
    operadorId: equipe['kelly.nakamura'].id, garcomId: equipe['wesley.duarte'].id,
    janelaIni: AGORA - 21 * D - 6 * H, janelaFim: AGORA - 21 * D + 1 * H,
    // O evento encerrou: tudo já foi pago e entregue. Ficam em 'paid' porque
    // é esse o status que o resumo financeiro soma como receita de bar.
    distribuicao: { paid: 96, cancelled: 3 },
  });
  passo(`bar: ${comandasH.length} comandas hoje (23 na fila da cozinha/salão) e ${comandasP.length} no evento encerrado`);

  // ── Caixa ──
  await inserir('cashier_shifts', ['event_id', 'operator_id', 'station', 'opening_cents',
    'counted_cents', 'opened_at', 'closed_at', 'notes'], [
    { event_id: evPassado, operator_id: equipe['kelly.nakamura'].id, station: 'Bar Principal',
      opening_cents: 30000, counted_cents: 486300, opened_at: iso(AGORA - 21 * D - 7 * H),
      closed_at: iso(AGORA - 21 * D + 2.5 * H), notes: 'Fechou com R$ 12,00 de sobra — troco de gorjeta.' },
    { event_id: evPassado, operator_id: equipe['aline.prazeres'].id, station: 'Bilheteria',
      opening_cents: 20000, counted_cents: 158000, opened_at: iso(AGORA - 21 * D - 7 * H),
      closed_at: iso(AGORA - 21 * D - 1 * H), notes: null },
    { event_id: evHoje, operator_id: equipe['kelly.nakamura'].id, station: 'Bar Rooftop',
      opening_cents: 30000, counted_cents: null, opened_at: iso(AGORA - 3 * H), closed_at: null, notes: 'Turno em andamento.' },
    { event_id: evHoje, operator_id: equipe['aline.prazeres'].id, station: 'Bilheteria',
      opening_cents: 20000, counted_cents: 92400, opened_at: iso(AGORA - 3 * H),
      closed_at: iso(AGORA - 25 * 60e3), notes: 'Bilheteria encerrada — vendas só pelo app a partir de agora.' },
    // Um turno aberto NO NOME DO DONO. A tela de Fechamento procura o turno
    // aberto DO OPERADOR LOGADO — sem este, ele abriria a tela e veria só o
    // botão de abrir caixa, em vez da conferência pronta para fechar ao vivo.
    { event_id: evHoje, operator_id: dono.id, station: 'Caixa Central',
      opening_cents: 50000, counted_cents: null, opened_at: iso(AGORA - 2.5 * H),
      closed_at: null, notes: 'Caixa central — aberto para conferência ao fim da noite.' },
  ], 'id');
  passo('caixa: 3 turnos fechados com contagem e 2 ABERTOS (um deles no nome do dono, pronto para fechar ao vivo)');

  // ── Bilheteria (venda na porta) ──
  const naPorta = vendaH.pedidos.filter((p) => !p._estornado).slice(0, 9);
  await inserir('box_office_sales', ['order_id', 'event_id', 'operator_id', 'method', 'amount_cents',
    'received_cents', 'change_cents', 'buyer_name', 'buyer_doc', 'note', 'created_at'],
  naPorta.map((p, i) => {
    const metodo = ['cash', 'card_machine', 'cash', 'pix_manual', 'card_machine', 'courtesy', 'cash', 'card_machine', 'pix_manual'][i];
    const recebido = metodo === 'cash' ? Math.ceil(p.total_cents / 5000) * 5000 : p.total_cents;
    return {
      order_id: p.id, event_id: evHoje, operator_id: equipe['aline.prazeres'].id,
      method: metodo,
      amount_cents: metodo === 'courtesy' ? 0 : p.total_cents,
      received_cents: metodo === 'courtesy' ? 0 : recebido,
      change_cents: metodo === 'cash' ? recebido - p.total_cents : 0,
      buyer_name: p._comprador.nome,
      buyer_doc: `${inteiro(100, 999)}.${inteiro(100, 999)}.${inteiro(100, 999)}-${inteiro(10, 99)}`,
      note: metodo === 'courtesy' ? 'Cortesia — imprensa (Rádio Mix)' : null,
      created_at: iso(AGORA - inteiro(30, 150) * 60e3),
    };
  }), 'id');
  passo('9 vendas na bilheteria: dinheiro com troco, maquininha, PIX manual e uma cortesia');

  // ── Fila de espera ──
  const loteCamarote = lotesHoje[2];
  const filaNomes = NOMES_LISTA.slice(20, 29);
  // `position` é identity no banco (ordem de chegada gerada sozinha): mandar
  // valor aqui é recusado. A ordem sai da própria sequência do insert.
  await inserir('waitlist', ['event_id', 'ticket_tier_id', 'profile_id', 'email', 'name', 'quantity',
    'status', 'invited_at', 'invite_expires_at', 'created_at'],
  filaNomes.map((nome, i) => {
    // Os cinco estados do enum, para a tela de Fila não parecer uma lista
    // simples: convertido (comprou), convidado com prazo correndo, convite
    // vencido, desistente e o resto esperando.
    const status = i === 0 ? 'converted' : (i === 1 || i === 5) ? 'invited'
      : i === 8 ? 'expired' : i === 6 ? 'cancelled' : 'waiting';
    return {
      event_id: evHoje, ticket_tier_id: loteCamarote.id,
      profile_id: i < clientes.length ? clientes[i].id : null,
      email: `${nome.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z]+/g, '.')}${DOMINIO}`,
      name: nome, quantity: inteiro(1, 4), status,
      invited_at: ['converted', 'invited', 'expired'].includes(status) ? iso(AGORA - inteiro(30, 200) * 60e3) : null,
      invite_expires_at: status === 'invited' ? iso(AGORA + 38 * 60e3) : status === 'expired' ? iso(AGORA - 20 * 60e3) : null,
      created_at: iso(AGORA - inteiro(2, 16) * D),
    };
  }), 'id');
  passo('fila de espera do camarote: 4 aguardando, 2 convidados com prazo correndo, 1 convertido, 1 vencido, 1 desistiu');

  // ── Notas fiscais ──
  // Três recusas em vez de uma: a tela de erro fiscal mostra `attempts` e o
  // motivo, e com um caso só não dá para ver que motivos diferentes pedem
  // ações diferentes (corrigir cadastro, esperar a prefeitura, abrir chamado).
  const RECUSAS = [
    ['Prefeitura recusou: CPF do tomador inválido (código 217)', 3],
    ['Prefeitura fora do ar: serviço de emissão indisponível (código 503)', 5],
    ['Prefeitura recusou: código de serviço 1201 não habilitado para o CNPJ (código 149)', 2],
  ];
  const paraNota = vendaP.pedidos.filter((p) => !p._estornado).slice(0, 17);
  await inserir('fiscal_documents', ['order_id', 'organization_id', 'status', 'provider', 'provider_ref',
    'numero', 'codigo_verificacao', 'amount_cents', 'tax_cents', 'service_code', 'buyer_name',
    'buyer_doc', 'buyer_email', 'error', 'attempts', 'issued_at', 'cancelled_at', 'cancel_reason', 'created_at'],
  paraNota.map((p, i) => {
    const status = i < 10 ? 'issued' : i < 12 ? 'pending' : i < 15 ? 'failed' : 'cancelled';
    const recusa = status === 'failed' ? RECUSAS[i - 12] : null;
    const imposto = Math.round(p.total_cents * 0.05);
    return {
      order_id: p.id, organization_id: orgId, status, provider: 'mock',
      provider_ref: status === 'pending' ? null : `NFSE-MOCK-${crypto.randomBytes(4).toString('hex').toUpperCase()}`,
      numero: ['issued', 'cancelled'].includes(status) ? String(20260000 + i) : null,
      codigo_verificacao: ['issued', 'cancelled'].includes(status) ? crypto.randomBytes(4).toString('hex').toUpperCase() : null,
      amount_cents: p.total_cents, tax_cents: imposto, service_code: '1201',
      buyer_name: p._comprador.nome,
      buyer_doc: `${inteiro(100, 999)}.${inteiro(100, 999)}.${inteiro(100, 999)}-${inteiro(10, 99)}`,
      buyer_email: p._comprador.email,
      error: recusa?.[0] ?? null,
      attempts: recusa?.[1] ?? (status === 'pending' ? 2 : 1),
      issued_at: ['issued', 'cancelled'].includes(status) ? iso(p._pagoEm + 2 * H) : null,
      cancelled_at: status === 'cancelled' ? iso(p._pagoEm + 30 * H) : null,
      cancel_reason: status === 'cancelled' ? 'Pedido reembolsado pelo cliente' : null,
      created_at: iso(p._pagoEm + 1 * H),
    };
  }), 'id');
  passo('17 notas fiscais: 10 emitidas, 2 na fila (2ª tentativa), 3 RECUSADAS com motivo e nº de tentativas, 2 canceladas');

  // ── E-mails de entrega de ingresso ──
  await inserir('email_deliveries', ['order_id', 'to_email', 'kind', 'status', 'attempts', 'error', 'provider_id', 'created_at'],
    [...vendaP.pedidos.slice(0, 30), ...vendaH.pedidos.slice(0, 20)].map((p, i) => ({
      order_id: p.id, to_email: p._comprador.email, kind: 'tickets',
      status: i % 17 === 5 ? 'failed' : i % 11 === 3 ? 'skipped' : 'sent',
      attempts: i % 17 === 5 ? 3 : 1,
      error: i % 17 === 5 ? 'SMTP 550 — caixa postal do destinatário cheia' : null,
      provider_id: `msg_${crypto.randomBytes(6).toString('hex')}`,
      created_at: iso(p._pagoEm + 60e3),
    })), 'id');

  // ── Casos de fraude ──
  const suspeitos = vendaP.pedidos.filter((p) => p._estornado).slice(0, 3);
  if (suspeitos.length) {
    await inserir('fraud_cases', ['event_id', 'order_id', 'profile_id', 'kind', 'amount_cents', 'detail', 'resolved_at', 'created_at'],
      suspeitos.map((p, i) => ({
        event_id: evPassado, order_id: p.id, profile_id: p._comprador.id,
        // Os dois nomes que o próprio sistema grava (0035_payment_reversal).
        // Inventar um terceiro faria o caso não casar com nada em produção.
        kind: i === 0 ? 'entered_then_refunded' : 'consumed_then_refunded',
        amount_cents: p.total_cents,
        detail: i === 0
          ? 'Contestação no cartão registrada 3 dias depois do check-in confirmado na porta.'
          : 'Pagamento revertido após o ingresso já ter sido validado na entrada.',
        resolved_at: i === 2 ? iso(AGORA - 9 * D) : null,
        created_at: iso(p._pagoEm + 80 * H),
      })), 'id');
  }

  // ── Marketing (modo mock: nada sai de verdade) ──
  const [campanhaEnviada] = await inserir('marketing_campaigns',
    ['event_id', 'organization_id', 'subject', 'body', 'segment', 'status', 'mode',
      'audience_count', 'sent_count', 'failed_count', 'mock_count', 'created_by', 'created_at', 'sent_at'], [
      { event_id: evHoje, organization_id: orgId,
        subject: 'Hoje tem Nébula no rooftop — seu nome já está na portaria',
        body: 'Fala, {nome}!\n\nHoje é dia: a Nébula Noturna começa às 22h no Rooftop Vila Olímpia.\n\n'
          + 'Leve o QR do seu ingresso no celular — a entrada é direta, sem fila de troca.\n'
          + 'Camarote com open bar de gin até as 2h; restam poucas unidades.\n\nAté logo à noite.\nEquipe Nébula',
        segment: 'compradores', status: 'sent', mode: 'mock',
        audience_count: 68, sent_count: 0, failed_count: 2, mock_count: 66,
        created_by: dono.id, created_at: iso(AGORA - 9 * H), sent_at: iso(AGORA - 8.5 * H) },
    ], 'id');
  const campanhasExtras = await inserir('marketing_campaigns',
    ['event_id', 'organization_id', 'subject', 'body', 'segment', 'status', 'mode',
      'audience_count', 'sent_count', 'failed_count', 'mock_count', 'created_by', 'created_at', 'sent_at'], [
      { event_id: evFuturo, organization_id: orgId,
        subject: 'Lote promocional do Open Air acabando (restam poucas unidades)',
        body: 'Oi, {nome}!\n\nO lote promocional do Nébula Open Air, na Marina da Glória, está em '
          + '90% de venda.\n\nGaranta o seu antes da virada de lote.\n\nEquipe Nébula',
        segment: 'lista', status: 'draft', mode: null,
        audience_count: 0, sent_count: 0, failed_count: 0, mock_count: 0,
        created_by: dono.id, created_at: iso(AGORA - 2 * D), sent_at: null },
      { event_id: evPassado, organization_id: orgId,
        subject: 'Obrigado por vir — as fotos da Sunset já estão no ar',
        body: 'Que noite, {nome}. As fotos do Sunset estão no nosso Instagram.\n\nEquipe Nébula',
        segment: 'sem_checkin', status: 'sent', mode: 'mock',
        audience_count: 41, sent_count: 0, failed_count: 0, mock_count: 41,
        created_by: dono.id, created_at: iso(AGORA - 19 * D), sent_at: iso(AGORA - 19 * D) },
    ], 'id');
  // A campanha guarda contadores; os DESTINATÁRIOS são a linha a linha que a
  // tela abre quando a pessoa pergunta "para quem foi, afinal". Sem eles o
  // painel mostra "68 pessoas" e não sabe dizer quais.
  const campanhaPassada = campanhasExtras[1];
  const destinatarios = [];
  for (let i = 0; i < 68; i += 1) {
    const c = clientes[i % clientes.length];
    const proprio = i < clientes.length;
    // Duas falhas de verdade, com motivo: e-mail que não existe mais.
    const falhou = i === 21 || i === 44;
    destinatarios.push({
      campaign_id: campanhaEnviada.id,
      email: proprio ? c.email : `${escolher(NOMES_LISTA).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z]+/g, '.')}.${i}${DOMINIO}`,
      name: proprio ? c.nome : escolher(NOMES_LISTA),
      status: falhou ? 'failed' : 'mock',
      error: falhou ? 'Destinatário inexistente (SMTP 550 5.1.1)' : null,
      created_at: iso(AGORA - 9 * H), sent_at: falhou ? null : iso(AGORA - 8.5 * H),
    });
  }
  // Um e-mail por campanha é único no banco (uq_marketing_recipient_email):
  // mandar duas vezes para a mesma pessoa na mesma campanha é bug, não dado.
  // Os 18 clientes reais entram uma vez; o resto do público vem da lista.
  for (let i = 0; i < 41; i += 1) {
    const proprio = i < clientes.length;
    const nome = proprio ? clientes[i].nome : escolher(NOMES_LISTA);
    destinatarios.push({
      campaign_id: campanhaPassada.id,
      email: proprio ? clientes[i].email
        : `${nome.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z]+/g, '.')}.s${i}${DOMINIO}`,
      name: nome, status: 'mock', error: null,
      created_at: iso(AGORA - 19 * D), sent_at: iso(AGORA - 19 * D),
    });
  }
  await inserir('marketing_recipients', ['campaign_id', 'email', 'name', 'status', 'error', 'created_at', 'sent_at'],
    destinatarios, 'id');
  passo(`3 campanhas de marketing e ${destinatarios.length} destinatários nominais (2 com falha de entrega)`);

  // ── Integrações: chave de API e webhook ──
  await inserir('api_keys', ['organization_id', 'nome', 'prefixo', 'hash', 'escopos', 'ultimo_uso_em', 'criada_por', 'revogada_em', 'created_at'], [
    { organization_id: orgId, nome: 'ERP Nébula (somente leitura)', prefixo: `pp_${crypto.randomBytes(4).toString('hex')}`,
      hash: crypto.createHash('sha256').update(crypto.randomBytes(32)).digest('hex'),
      escopos: ['eventos:ler', 'pedidos:ler', 'ingressos:ler'],
      ultimo_uso_em: iso(AGORA - 40 * 60e3), criada_por: dono.id, revogada_em: null, created_at: iso(AGORA - 60 * D) },
    { organization_id: orgId, nome: 'Integração antiga do site', prefixo: `pp_${crypto.randomBytes(4).toString('hex')}`,
      hash: crypto.createHash('sha256').update(crypto.randomBytes(32)).digest('hex'),
      escopos: ['eventos:ler'],
      ultimo_uso_em: iso(AGORA - 120 * D), criada_por: dono.id, revogada_em: iso(AGORA - 90 * D), created_at: iso(AGORA - 300 * D) },
  ], 'id');

  // A assinatura nasce PAUSADA de propósito: ativa, o gatilho enfileiraria
  // entrega de verdade para uma URL que não existe, e a demo geraria retentativa
  // saindo do servidor durante a apresentação.
  const [assinatura] = await inserir('webhook_assinaturas',
    ['organization_id', 'url', 'eventos', 'secret_enc', 'ativa', 'criada_por', 'created_at'], [
      { organization_id: orgId, url: 'https://erp.nebulaproducoes.com.br/hooks/pulsepass',
        eventos: ['pedido.pago', 'ingresso.emitido', 'checkin.registrado', 'pedido.estornado'],
        secret_enc: crypto.randomBytes(24).toString('base64'), ativa: false,
        criada_por: dono.id, created_at: iso(AGORA - 45 * D) },
    ], 'id');
  // Os quatro estados do enum webhook_entrega_status. O que a tela precisa
  // separar não é "deu certo / deu errado": é o que ainda vai tentar de novo
  // (pendente, com hora marcada), o que está no ar agora (enviando, com
  // reserva), o que terminou bem e o que a fila desistiu de entregar.
  //   [evento, status, tentativas, httpStatus, minutosAtras]
  const ENTREGAS = [
    ['pedido.pago', 'entregue', 1, 200, 26 * 60],
    ['ingresso.emitido', 'entregue', 1, 200, 25 * 60],
    ['checkin.registrado', 'entregue', 2, 200, 20 * 60],
    ['pedido.pago', 'entregue', 1, 201, 8 * 60],
    ['pedido.estornado', 'desistiu', 6, 502, 3 * 60],
    ['checkin.registrado', 'desistiu', 6, 401, 2 * 60],
    ['pedido.pago', 'pendente', 2, 504, 14],
    ['ingresso.emitido', 'pendente', 1, null, 4],
    ['checkin.registrado', 'enviando', 1, null, 1],
  ];
  await inserir('webhook_entregas', ['assinatura_id', 'evento', 'payload', 'status', 'tentativas',
    'http_status', 'resposta', 'erro', 'proxima_tentativa_em', 'reservada_em', 'entregue_em', 'created_at'],
  ENTREGAS.map(([evento, status, tentativas, http, minutos]) => {
    const quando = AGORA - minutos * 60e3;
    const ok = http === 200 || http === 201;
    // A retentativa cresce em dobro: 1, 2, 4, 8 minutos. É o que a fila faz,
    // e a tela mostra a hora — se todas viessem "agora" pareceria travada.
    const proxima = status === 'pendente' ? quando + 2 ** tentativas * 60e3 : quando;
    return {
      assinatura_id: assinatura.id, evento,
      payload: JSON.stringify({ evento, enviado_em: iso(quando), demo: true }),
      status, tentativas, http_status: http,
      resposta: ok ? '{"ok":true,"recebido":true}' : (http ? '{"erro":"upstream indisponivel"}' : null),
      erro: ok ? null : (status === 'desistiu'
        ? `HTTP ${http} do destino após ${tentativas} tentativas — assinatura precisa ser reenfileirada`
        : (http ? `HTTP ${http} do destino — nova tentativa agendada` : 'Tempo limite ao conectar (ETIMEDOUT)')),
      proxima_tentativa_em: iso(proxima),
      reservada_em: status === 'enviando' ? iso(quando) : null,
      entregue_em: status === 'entregue' ? iso(quando) : null,
      created_at: iso(quando),
    };
  }), 'id');
  passo('integrações: 1 chave de API ativa, 1 revogada e 9 entregas de webhook nos 4 estados (entregue, pendente com retentativa, enviando, desistiu)');

  // ═══ A SEGUNDA CASA — Coletivo Maré ═══
  // Existe para o PulseADM ter o que comparar: ranking de GMV, repasse por
  // produtora e GMV por cidade. Outra cidade de propósito (Niterói) — com as
  // duas casas em São Paulo, o painel "GMV por cidade" continuaria com uma
  // barra só.
  console.log('\n▸ segunda produtora (Coletivo Maré)…');
  const evMarePassado = await upsertEvento(orgMare, {
    title: 'Samba do Cais · 40 anos do Coletivo',
    slug: SLUG_MARE_PASSADO,
    description: 'Roda de samba no galpão do cais com as três gerações do coletivo. '
      + 'Feijoada às 13h, roda até o sol cair.',
    venue: 'Galpão do Cais', address: 'R. Visconde de Sepetiba, 40 — Centro',
    city: 'Niterói', state: 'RJ',
    starts: iso(AGORA - 9 * D - 5 * H), ends: iso(AGORA - 9 * D + 1 * H),
    status: 'ended', lat: -22.8930, lng: -43.1230,
  });
  const evMareFuturo = await upsertEvento(orgMare, {
    title: 'Maré Alta · Baile de Sábado',
    slug: SLUG_MARE_FUTURO,
    description: 'Baile black e samba-rock com discotecagem em vinil. '
      + 'Entrada meia para quem chegar antes das 22h.',
    venue: 'Clube Central de Icaraí', address: 'R. Mariz e Barros, 232 — Icaraí',
    city: 'Niterói', state: 'RJ',
    starts: iso(AGORA + 12 * D), ends: iso(AGORA + 12 * D + 7 * H),
    status: 'published', lat: -22.9020, lng: -43.1080,
  });
  for (const [id, corA, corB] of [[evMarePassado, '#0C4A6E', '#F59E0B'], [evMareFuturo, '#075985', '#EC4899']]) {
    const url = await subirImagem(db, 'event-covers', `demo/${id}.png`, capaPng({ corA, corB }), 'image/png');
    if (url) await sql('update public.events set cover_url = $2 where id = $1', [id, url]);
  }

  const lotesMareP = await lotes(evMarePassado, [
    { nome: 'Pista', preco: 4000, meia: 2000, total: 250, vender: 218, status: 'closed' },
    { nome: 'Mesa (4 lugares)', preco: 16000, total: 20, vender: 17, status: 'closed', maxPedido: 2 },
  ]);
  const lotesMareF = await lotes(evMareFuturo, [
    { nome: 'Antecipado', preco: 3500, meia: 1750, total: 200, vender: 96 },
    { nome: 'Sócio do Coletivo', preco: 2500, total: 60, vender: 38, maxPedido: 2,
      desc: 'Preço de sócio. Apresentar carteirinha na entrada.' },
  ]);
  const vendaMareP = await venderIngressos({
    eventoId: evMarePassado, prefixo: 'CAI', lotes: lotesMareP, compradores: clientes,
    janelaIni: AGORA - 40 * D, janelaFim: AGORA - 9 * D - 6 * H, taxaEstorno: 0.05, cupom: null,
  });
  const entradosMare = await fazerCheckin(evMarePassado, vendaMareP.ingressos, 0.79, donaMare.id,
    AGORA - 9 * D - 5 * H, AGORA - 9 * D - 1 * H, { reentradas: 11, saidas: 14, naoVao: clientes.slice(15).map((c) => c.id) });
  const vendaMareF = await venderIngressos({
    eventoId: evMareFuturo, prefixo: 'BAI', lotes: lotesMareF, compradores: clientes,
    janelaIni: AGORA - 21 * D, janelaFim: AGORA - 3 * H, taxaEstorno: 0.02, cupom: null,
  });
  const cardapioMare = await semearCardapio(evMarePassado, [
    ['Cerveja Itaipava 600ml', 'Cervejas', 1200, 480, null, 'Estupidamente gelada.'],
    ['Caipirinha de cachaça', 'Drinks', 1600, 500, null, null],
    ['Batida de coco', 'Drinks', 1400, 420, null, 'Receita da tia Zezé.'],
    ['Refrigerante lata', 'Sem álcool', 800, 250, null, null],
    ['Feijoada (prato)', 'Cozinha', 3500, 1300, null, 'Com couve, farofa e laranja.'],
    ['Bolinho de bacalhau (6un)', 'Cozinha', 2800, 1050, null, null],
  ]);
  await semearComandas({
    eventoId: evMarePassado, cardapio: cardapioMare, compradores: clientes, carteiras, mesas: [],
    operadorId: donaMare.id, garcomId: donaMare.id,
    janelaIni: AGORA - 9 * D - 5 * H, janelaFim: AGORA - 9 * D + 1 * H,
    distribuicao: { paid: 74, cancelled: 2 },
  });
  await sql(`
    update public.ticket_tiers t
       set quantity_sold = least(t.quantity_total, coalesce(c.n, 0)),
           status = case when coalesce(c.n,0) >= t.quantity_total then 'sold_out'::tier_status else t.status end
      from (select ticket_tier_id, count(*) n from public.tickets
             where event_id = any($1) and status <> 'cancelled' group by 1) c
     where t.id = c.ticket_tier_id`, [[evMarePassado, evMareFuturo]]);
  await sql(`
    update public.notificacoes n
       set created_at = o.paid_at,
           lida_em = case when o.paid_at < now() - interval '2 days' then o.paid_at + interval '3 hours' else null end
      from public.orders o
     where n.event_id = any($1) and n.destino = '/pedido/' || o.id || '/confirmado'`,
  [[evMarePassado, evMareFuturo]]);
  passo(`Coletivo Maré: 2 eventos em Niterói, ${vendaMareP.pedidos.length + vendaMareF.pedidos.length} pedidos, `
    + `${entradosMare.length} check-ins e bar próprio — casa menor, para o ranking do PulseADM ter contraste`);

  // ── Trilha de auditoria ──
  // audit_log é APPEND-ONLY no banco (gatilho recusa update e delete, inclusive
  // para service_role). Não dá para "limpar e recriar": o que se pode fazer é
  // não repetir. Só grava se a trilha da produtora estiver vazia ou velha.
  const { rows: [ultima] } = await sql(
    'select max(at) as ultima, count(*)::int as n from public.audit_log where organization_id = $1', [orgId]);
  const trilhaVelha = !ultima.ultima || (AGORA - new Date(ultima.ultima).getTime()) > 20 * H;
  let auditoriaNota = `${ultima.n} linha(s) já existentes — append-only, não recriada`;
  if (trilhaVelha) {
    const estorno = vendaH.pedidos.find((p) => p._estornado) ?? vendaH.pedidos[0];
    const trilha = [
      ['event.publish', 'events', evHoje, evHoje, null, 'Evento publicado na vitrine', AGORA - 26 * D],
      ['staff.add', 'event_staff', evHoje, evHoje, null, 'Sandro Barreto escalado na porta', AGORA - 12 * D],
      ['staff.add', 'event_staff', evHoje, evHoje, null, 'Kelly Nakamura escalada no bar', AGORA - 12 * D],
      ['coupon.create', 'coupons', evHoje, evHoje, null, 'Cupom NEBULA10 criado (10%, 200 usos)', AGORA - 11 * D],
      ['tier.price_change', 'ticket_tiers', evHoje, evHoje, null, 'Pista 2º Lote: R$ 80,00 → R$ 90,00', AGORA - 9 * D],
      ['organization.wallet_change', 'organizations', orgId, null, null, 'Carteira Asaas de repasse configurada', AGORA - 40 * D],
      ['event.cover_change', 'events', evFuturo, evFuturo, null, 'Capa do Open Air atualizada', AGORA - 5 * D],
      ['box_office.sale', 'orders', naPorta[0]?.id ?? null, evHoje, naPorta[0]?.total_cents ?? null, 'Venda na bilheteria — dinheiro, com troco', AGORA - 2 * H],
      ['box_office.sale', 'orders', naPorta[3]?.id ?? null, evHoje, naPorta[3]?.total_cents ?? null, 'Venda na bilheteria — PIX manual', AGORA - 95 * 60e3],
      ['order.refund', 'orders', estorno.id, evHoje, estorno.total_cents, 'Reembolso solicitado pelo cliente via suporte', AGORA - 70 * 60e3],
      ['cashier.close', 'cashier_shifts', evHoje, evHoje, 92400, 'Bilheteria fechada com contagem conferida', AGORA - 25 * 60e3],
      ['fiscal.issue', 'fiscal_documents', evPassado, evPassado, null, 'Lote de 10 notas emitido no provedor', AGORA - 20 * D],
      ['seats.generate', 'event_seats', evFuturo, evFuturo, null, `Setor "${mapa.setor}" gerado: 8 fileiras × 14 lugares`, AGORA - 18 * D],
      ['seats.block', 'event_seats', evFuturo, evFuturo, null, 'A1, A2, A13 e A14 reservadas para cadeirante; H7 tomada pela mesa de som', AGORA - 18 * D],
      ['wallet.block', 'wallets', bloqueado.id, null, null, `Carteira de ${bloqueado.nome} bloqueada — contestação de recarga em análise`, AGORA - 2 * D],
      ['coupon.exhausted', 'coupons', evHoje, evHoje, null, 'Cupom ROOFTOP5 atingiu o limite de 30 usos', AGORA - 4 * H],
    ];
    await inserir('audit_log', ['actor_id', 'actor_email', 'actor_ip', 'action', 'entity', 'entity_id',
      'event_id', 'organization_id', 'amount_cents', 'note', 'at'],
    trilha.map(([action, entity, entityId, eventId, valor, nota, quando]) => ({
      actor_id: dono.id, actor_email: dono.email, actor_ip: '187.45.203.11',
      action, entity, entity_id: entityId ? String(entityId) : null,
      event_id: eventId, organization_id: orgId, amount_cents: valor, note: nota, at: iso(quando),
    })), 'id');
    auditoriaNota = `${trilha.length} movimentos gravados`;
  }
  passo(`auditoria: ${auditoriaNota}`);

  // ═══════════════════════════════════════════════════════════════════
  // Resumo — contagens lidas DO BANCO, não do que o script acha que fez
  // ═══════════════════════════════════════════════════════════════════
  const evs = [evPassado, evHoje, evFuturo];
  const evsMare = [evMarePassado, evMareFuturo];
  const idsClientes = clientes.map((c) => c.id);
  const PERGUNTAS = [
    ['Eventos', 'select count(*)::int n from public.events where organization_id = $1', [orgId]],
    ['Lotes', 'select count(*)::int n from public.ticket_tiers where event_id = any($1)', [evs]],
    ['Pedidos pagos', "select count(*)::int n from public.orders where event_id = any($1) and status = 'paid'", [evs]],
    ['Pedidos estornados', "select count(*)::int n from public.orders where event_id = any($1) and status = 'refunded'", [evs]],
    ['Pedidos aguardando PIX', "select count(*)::int n from public.orders where event_id = any($1) and status = 'pending'", [evs]],
    ['Pedidos expirados', "select count(*)::int n from public.orders where event_id = any($1) and status = 'expired'", [evs]],
    ['Pedidos cancelados', "select count(*)::int n from public.orders where event_id = any($1) and status = 'cancelled'", [evs]],
    ['Ingressos emitidos', 'select count(*)::int n from public.tickets where event_id = any($1)', [evs]],
    ['Check-ins feitos', "select count(*)::int n from public.tickets where event_id = any($1) and status = 'used'", [evs]],
    ['  · no evento de hoje', "select count(*)::int n from public.tickets where event_id = $1 and status = 'used'", [evHoje]],
    ['Ingressos cancelados', "select count(*)::int n from public.tickets where event_id = any($1) and status = 'cancelled'", [evs]],
    ['Movimentos de porta', 'select count(*)::int n from public.gate_movements where event_id = any($1)', [evs]],
    ['  · saídas (reentrada)', "select count(*)::int n from public.gate_movements where event_id = any($1) and direction = 'out'", [evs]],
    ['Assentos no mapa', 'select count(*)::int n from public.event_seats where event_id = any($1)', [evs]],
    ['  · vendidos', "select count(*)::int n from public.event_seats where event_id = any($1) and status = 'sold'", [evs]],
    ['  · com reserva viva', "select count(*)::int n from public.event_seats where event_id = any($1) and status = 'held' and held_until > now()", [evs]],
    ['  · bloqueados', "select count(*)::int n from public.event_seats where event_id = any($1) and status = 'blocked'", [evs]],
    ['Transferências de ingresso', 'select count(*)::int n from public.ticket_transfers tt join public.tickets tk on tk.id = tt.ticket_id where tk.event_id = any($1)', [evs]],
    ['  · aceitas', "select count(*)::int n from public.ticket_transfers tt join public.tickets tk on tk.id = tt.ticket_id where tk.event_id = any($1) and tt.status = 'accepted'", [evs]],
    ['  · pendentes (sem conta)', "select count(*)::int n from public.ticket_transfers tt join public.tickets tk on tk.id = tt.ticket_id where tk.event_id = any($1) and tt.status = 'pending'", [evs]],
    ['Promoters', 'select count(*)::int n from public.promoters where event_id = any($1)', [evs]],
    ['Convidados na lista', 'select count(*)::int n from public.guests where event_id = any($1)', [evs]],
    ['  · já na casa hoje', "select count(*)::int n from public.guests where event_id = $1 and status = 'checked_in'", [evHoje]],
    ['Itens de cardápio', 'select count(*)::int n from public.menu_items where event_id = any($1)', [evs]],
    ['Comandas de bar', 'select count(*)::int n from public.bar_orders where event_id = any($1)', [evs]],
    ['  · na fila da cozinha hoje', "select count(*)::int n from public.bar_orders where event_id = $1 and status in ('paid','preparing','ready')", [evHoje]],
    ['Mesas e camarotes', 'select count(*)::int n from public.event_tables where event_id = any($1)', [evs]],
    ['Reservas de mesa', 'select count(*)::int n from public.table_reservations where event_id = any($1)', [evs]],
    ['Carteiras', 'select count(*)::int n from public.wallets where profile_id = any($1)', [idsClientes]],
    ['  · com saldo devedor', 'select count(*)::int n from public.wallets where profile_id = any($1) and balance_cents < 0', [idsClientes]],
    ['  · bloqueadas', 'select count(*)::int n from public.wallets where profile_id = any($1) and blocked_at is not null', [idsClientes]],
    ['Lançamentos de carteira', 'select count(*)::int n from public.wallet_transactions wt join public.wallets w on w.id = wt.wallet_id where w.profile_id = any($1)', [idsClientes]],
    ['Recargas', 'select count(*)::int n from public.wallet_topups where profile_id = any($1)', [idsClientes]],
    ['Turnos de caixa', 'select count(*)::int n from public.cashier_shifts where event_id = any($1)', [evs]],
    ['Vendas na bilheteria', 'select count(*)::int n from public.box_office_sales where event_id = any($1)', [evs]],
    ['Fila de espera', 'select count(*)::int n from public.waitlist where event_id = any($1)', [evs]],
    ['Notas fiscais', 'select count(*)::int n from public.fiscal_documents where organization_id = $1', [orgId]],
    ['Cupons', 'select count(*)::int n from public.coupons where event_id = any($1)', [evs]],
    ['Campanhas de marketing', 'select count(*)::int n from public.marketing_campaigns where organization_id = $1', [orgId]],
    ['Pontos de fidelidade (linhas)', 'select count(*)::int n from public.fidelidade_ledger where organization_id = $1', [orgId]],
    ['Notificações', 'select count(*)::int n from public.notificacoes where event_id = any($1)', [evs]],
    ['E-mails de ingresso', 'select count(*)::int n from public.email_deliveries ed join public.orders o on o.id = ed.order_id where o.event_id = any($1)', [evs]],
    ['Casos de fraude', 'select count(*)::int n from public.fraud_cases where event_id = any($1)', [evs]],
    ['Destinatários de campanha', 'select count(*)::int n from public.marketing_recipients mr join public.marketing_campaigns mc on mc.id = mr.campaign_id where mc.organization_id = $1', [orgId]],
    ['Chaves de API', 'select count(*)::int n from public.api_keys where organization_id = $1', [orgId]],
    ['Entregas de webhook', 'select count(*)::int n from public.webhook_entregas we join public.webhook_assinaturas wa on wa.id = we.assinatura_id where wa.organization_id = $1', [orgId]],
    ['Trilha de auditoria', 'select count(*)::int n from public.audit_log where organization_id = $1', [orgId]],
    ['── Coletivo Maré ──', 'select 0::int n', []],
    ['Eventos', 'select count(*)::int n from public.events where organization_id = $1', [orgMare]],
    ['Pedidos pagos', "select count(*)::int n from public.orders where event_id = any($1) and status = 'paid'", [evsMare]],
    ['Ingressos emitidos', 'select count(*)::int n from public.tickets where event_id = any($1)', [evsMare]],
    ['Check-ins feitos', "select count(*)::int n from public.tickets where event_id = any($1) and status = 'used'", [evsMare]],
    ['Comandas de bar', 'select count(*)::int n from public.bar_orders where event_id = any($1)', [evsMare]],
  ];
  // Em série, não em Promise.all: um único client do pg não atende duas
  // consultas ao mesmo tempo — ele enfileira e avisa por deprecação.
  const contagens = [];
  for (const [rotulo, texto, params] of PERGUNTAS) {
    const { rows } = await sql(texto, params);
    contagens.push([rotulo, rows[0].n]);
  }

  const { rows: [caixa] } = await sql(`
    select
      (select coalesce(sum(total_cents),0) from public.orders where event_id = any($1) and status = 'paid')::int as ingressos,
      (select coalesce(sum(total_cents),0) from public.orders where event_id = any($1) and status = 'refunded')::int as estornado,
      (select coalesce(sum(total_cents),0) from public.bar_orders where event_id = any($1) and status = 'paid')::int as bar,
      (select coalesce(sum(pontos),0) from public.fidelidade_ledger where organization_id = $2)::int as pontos,
      (select coalesce(sum(total_cents),0) from public.orders where event_id = any($3) and status = 'paid')::int
        + (select coalesce(sum(total_cents),0) from public.bar_orders where event_id = any($3) and status <> 'cancelled')::int as mare`,
  [evs, orgId, evsMare]);

  console.log(`\n${'═'.repeat(72)}`);
  console.log('  DEMONSTRAÇÃO PRONTA — Nébula Produções');
  console.log('═'.repeat(72));
  console.log(`\n  Dono da produtora : ${dono.email}`);
  console.log('  (é a produtora que aparece primeiro no cockpit — Marca, Repasse e');
  console.log('   Integrações abrem nela por padrão)');

  console.log('\n  ── O que existe no banco ──');
  for (const [rotulo, n] of contagens) console.log(`  ${rotulo.padEnd(30, '.')} ${String(n).padStart(6)}`);

  console.log('\n  ── Dinheiro ──');
  console.log(`  Ingressos pagos ............... ${brl(caixa.ingressos)}`);
  console.log(`  Estornado ..................... ${brl(caixa.estornado)}`);
  console.log(`  Bar ........................... ${brl(caixa.bar)}`);
  console.log(`  Pontos de fidelidade .......... ${caixa.pontos} pts (${brl(caixa.pontos * 10)} em resgate)`);
  console.log(`  GMV do Coletivo Maré .......... ${brl(caixa.mare)}  (a segunda casa, para o ranking do PulseADM)`);

  console.log('\n  ── Telas do cockpit para a apresentação ──');
  const linksCockpit = [
    ['Meus eventos', ''],
    ['Dashboard (hoje)', `/eventos/${evHoje}`],
    ['AO VIVO ⭐', `/eventos/${evHoje}/ao-vivo`],
    ['Porta / check-in', `/eventos/${evHoje}/porta`],
    ['Lista na porta', `/eventos/${evHoje}/lista-porta`],
    ['PDV do bar', `/eventos/${evHoje}/pdv`],
    ['Cozinha (KDS)', `/eventos/${evHoje}/cozinha`],
    ['Salão / garçom', `/eventos/${evHoje}/garcom`],
    ['Camarotes e mesas', `/eventos/${evHoje}/camarotes`],
    ['Cardápio e margem', `/eventos/${evHoje}/cardapio`],
    ['Bilheteria', `/eventos/${evHoje}/bilheteria`],
    ['Fechamento de caixa', `/eventos/${evHoje}/fechamento`],
    ['Fila de espera', `/eventos/${evHoje}/fila-espera`],
    ['Promoters', `/eventos/${evHoje}/promoters`],
    ['Cupons', `/eventos/${evHoje}/cupons`],
    ['Marketing', `/eventos/${evHoje}/marketing`],
    ['Equipe e permissões', `/eventos/${evHoje}/equipe`],
    ['Financeiro / conciliação (encerrado)', `/eventos/${evPassado}/conciliacao`],
    ['Notas fiscais (encerrado)', `/eventos/${evPassado}/fiscal`],
    ['Auditoria (hoje)', `/eventos/${evHoje}/auditoria`],
    ['Marca da produtora', '/marca'],
    ['Repasse', '/repasse'],
    ['Integrações', '/integracoes'],
  ];
  for (const [rotulo, caminho] of linksCockpit) console.log(`  ${rotulo.padEnd(38, ' ')} ${COCKPIT}${caminho}`);

  console.log('\n  ── App do público ──');
  const linksWeb = [
    ['Vitrine', '/'],
    ['Página da produtora', `/casa/${ORG_SLUG}`],
    ['Evento no ar agora', `/eventos/${SLUG_HOJE}`],
    ['Evento futuro (vendas abertas)', `/eventos/${SLUG_FUTURO}`],
    ['MAPA DE ASSENTOS ⭐', `/eventos/${SLUG_FUTURO}/assentos`],
    ['Segunda casa (Coletivo Maré)', `/eventos/${SLUG_MARE_FUTURO}`],
    ['Meus pedidos (5 estados)', '/meus-pedidos'],
    ['Camarotes do evento de hoje', `/eventos/${SLUG_HOJE}/camarotes`],
    ['Peça no bar pelo celular', `/eventos/${SLUG_HOJE}/bar`],
    ['Lista da Rafaela (promoter)', '/lista/rafaela-nebula'],
    ['Meus ingressos', '/meus-ingressos'],
    ['Carteira', '/carteira'],
    ['Perfil / fidelidade', '/perfil'],
    ['Portal do promoter', '/promoter'],
  ];
  for (const [rotulo, caminho] of linksWeb) console.log(`  ${rotulo.padEnd(38, ' ')} ${WEB}${caminho}`);

  console.log('\n  ── Contas para demonstrar (senha única: ' + SENHA + ') ──');
  console.log(`  Cliente com ingresso, carteira e pontos .. ${clientes[0].email}`);
  console.log(`  Porteiro (check-in) ...................... ${equipe['sandro.barreto'].email}`);
  console.log(`  Bar / PDV ................................ ${equipe['kelly.nakamura'].email}`);
  console.log(`  Garçom (salão) ........................... ${equipe['wesley.duarte'].email}`);
  console.log(`  Gerente .................................. ${equipe['aline.prazeres'].email}`);
  console.log(`  Promoter ................................. ${promoters[0].email}`);

  // ── Munição para as demonstrações ao vivo ──
  const { rows: [paraScanner] } = await sql(
    "select code from public.tickets where event_id = $1 and status = 'valid' order by created_at desc limit 1", [evHoje]);
  const { rows: [naLista] } = await sql(
    "select g.name from public.guests g where g.event_id = $1 and g.status = 'confirmed' order by g.created_at limit 1", [evHoje]);
  const { rows: [paraRetirar] } = await sql(
    "select pickup_code from public.bar_orders where event_id = $1 and status = 'ready' order by created_at limit 1", [evHoje]);

  console.log('\n  ── Para demonstrar ao vivo (nada disso está usado ainda) ──');
  console.log(`  Código de ingresso para validar na Porta ... ${paraScanner?.code ?? '—'}`);
  console.log(`  Nome para buscar na Lista na porta ........ ${naLista?.name ?? '—'}`);
  console.log(`  Senha de retirada pronta no bar ........... ${paraRetirar?.pickup_code ?? '—'}`);
  console.log('  Caixa Central está ABERTO no nome do dono — dá para fechar na tela de Fechamento.');

  console.log('\n  ── Antes de apresentar ──');
  console.log('  · O evento de hoje começou 2h ANTES do instante em que este seed rodou.');
  console.log('    Rode de novo pouco antes da apresentação para o relógio bater com a sala.');
  console.log('  · A vitrine pública tem cache em memória na API. Se o evento de hoje não');
  console.log('    aparecer de cara, reinicie a API (npm run dev) e recarregue.');
  console.log('  · Rodar de novo é seguro: nada duplica e nada fora da Nébula é tocado.');
  console.log('  · O que continua sem tela (dado existe no banco, o cockpit não lê):');
  console.log('    – Fechamento → "conferência de carteira": a carteira é única (event_id null),');
  console.log('      e a view wallet_reconciliation filtra por evento. Nunca casa.');
  console.log('    – Perfil (app do público) → fidelidade: o programa está ativo e com pontos');
  console.log('      no banco, mas nenhuma tela consome os endpoints de fidelidade ainda.');
  console.log('    – Assentos: a grade é semeada aqui porque o cockpit não tem tela para gerá-la.');
  console.log('      A rota POST /admin/events/:id/assentos existe e funciona; falta o botão.');
  console.log('    – Transferências: nenhuma tela lê ticket_transfers. O que aparece do assunto');
  console.log('      é a notificação dos dois lados e o QR novo — o histórico não tem onde sair.');
  console.log('    – tickets.status = \'transferred\': o app tem o selo "Transferido", mas nenhuma');
  console.log('      rotina escreve esse status (a RPC troca o dono e mantém \'valid\'). Semear');
  console.log('      na mão seria descrever um comportamento que o sistema não tem.');
  console.log(`\n${'═'.repeat(72)}\n`);
}

main()
  .then(() => cliente?.end())
  .then(() => process.exit(0))
  .catch(async (e) => {
    console.error('\n✖ ERRO:', e.message);
    if (process.env.DEBUG) console.error(e);
    try { await cliente?.end(); } catch { /* já caiu */ }
    process.exit(1);
  });
