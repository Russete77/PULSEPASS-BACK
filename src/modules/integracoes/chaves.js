// modules/integracoes/chaves.js — sorteio, hash e conferência da chave de API.
//
// Este arquivo é o único ponto do sistema onde uma chave existe em claro, e ela
// existe por uma chamada de função: `gerar()` devolve o valor, o service manda
// pra resposta HTTP, e o que sobra no banco é o hash. Não há caminho de volta.
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * O prefixo legível serve pra duas coisas fora daqui: quem lê um log ou um
 * arquivo de configuração reconhece na hora que aquilo é credencial do
 * PulsePass (e não um id qualquer), e varredores de segredo em repositório —
 * GitHub, gitleaks — conseguem ter uma regra pra isso.
 */
const MARCA = 'pp_live_';
/** Marca + 8 caracteres do sorteio: identifica a linha sem entregar o resto. */
const TAM_PREFIXO = MARCA.length + 8;

/**
 * 32 bytes de CSPRNG em base64url = 43 caracteres sem `+`, `/` ou `=`. Isso
 * importa: a chave viaja em header e em .env, e caractere que precisa de escape
 * é caractere que alguém vai copiar errado.
 */
const BYTES = 32;

export const hashDaChave = (chave) => createHash('sha256').update(String(chave), 'utf8').digest('hex');

/** @returns {{ chave: string, prefixo: string, hash: string }} */
export function gerar() {
  const chave = MARCA + randomBytes(BYTES).toString('base64url');
  return { chave, prefixo: chave.slice(0, TAM_PREFIXO), hash: hashDaChave(chave) };
}

/** Prefixo de uma chave apresentada, ou null se o formato nem bate. */
export function prefixoDe(chave) {
  if (typeof chave !== 'string') return null;
  if (!chave.startsWith(MARCA)) return null;
  // Curta demais pra ser uma chave nossa — nem vale a ida ao banco.
  if (chave.length < MARCA.length + 40) return null;
  return chave.slice(0, TAM_PREFIXO);
}

/**
 * Conferência em tempo constante.
 *
 * `a === b` sai do laço no primeiro byte diferente, e a diferença de tempo
 * entre "errou no primeiro" e "errou no último" é mensurável pela rede com
 * amostras suficientes — dá pra reconstruir o segredo byte a byte.
 * `timingSafeEqual` compara os 32 bytes sempre.
 */
export function confere(apresentada, hashGuardado) {
  const a = Buffer.from(hashDaChave(apresentada), 'hex');
  const b = Buffer.from(String(hashGuardado ?? ''), 'hex');
  if (b.length !== a.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * Hash de uma chave que não existe, pra gastar o mesmo tempo quando o prefixo
 * não é encontrado. Sem isso, "prefixo inexistente" responderia mais rápido que
 * "prefixo certo, resto errado" — e o atacante descobriria prefixos válidos
 * cronometrando as respostas.
 */
export const HASH_INEXISTENTE = hashDaChave('chave-que-nao-existe');
