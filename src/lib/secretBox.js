// lib/secretBox.js — cifra segredos de terceiros antes de guardar no banco.
//
// Existe por causa de UM segredo específico: a apiKey da subconta Asaas da
// produtora. Ela dá acesso total à conta dela — movimentar dinheiro, sacar,
// emitir cobrança. Guardar isso em texto claro significa que um vazamento do
// nosso banco vira acesso à conta bancária de todos os clientes.
//
// O Asaas devolve a apiKey UMA ÚNICA VEZ, na criação, e não há como
// recuperá-la depois. Por isso ela é guardada — mas cifrada, com a chave fora
// do banco (variável de ambiente). Quem tiver só o dump não abre nada.
//
// AES-256-GCM: além de cifrar, autentica. Se alguém adulterar o dado no banco,
// a decifragem falha em vez de devolver lixo silenciosamente.
import { createCipheriv, createDecipheriv, randomBytes, createHash } from 'node:crypto';
import { env } from '../config/env.js';

const ALGO = 'aes-256-gcm';

function key() {
  const raw = env.secretBoxKey;
  if (!raw || raw.length < 16) {
    throw new Error('SECRET_BOX_KEY ausente ou curta demais (mínimo 16 caracteres).');
  }
  // Deriva 32 bytes a partir da chave configurada.
  return createHash('sha256').update(raw).digest();
}

/** @returns {string} "v1:<iv b64>:<tag b64>:<cifra b64>" */
export function seal(plain) {
  if (plain == null || plain === '') return null;
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGO, key(), iv);
  const enc = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1:${iv.toString('base64')}:${tag.toString('base64')}:${enc.toString('base64')}`;
}

export function open(sealed) {
  if (!sealed) return null;
  const [versao, ivB64, tagB64, dataB64] = String(sealed).split(':');
  if (versao !== 'v1') throw new Error('Formato de segredo desconhecido');
  const decipher = createDecipheriv(ALGO, key(), Buffer.from(ivB64, 'base64'));
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
  return Buffer.concat([
    decipher.update(Buffer.from(dataB64, 'base64')), decipher.final(),
  ]).toString('utf8');
}

/** Configurado? Usado no boot para recusar subir sem a chave em produção. */
export const secretBoxReady = () => Boolean(env.secretBoxKey && env.secretBoxKey.length >= 16);
