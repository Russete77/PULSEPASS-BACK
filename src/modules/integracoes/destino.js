// modules/integracoes/destino.js — valida para onde um webhook pode sair.
//
// O PERIGO: a produtora escolhe a URL, e quem faz o POST é o NOSSO servidor,
// de dentro da nossa rede. É o formato clássico de SSRF — basta cadastrar
// `http://169.254.169.254/latest/meta-data/iam/security-credentials/` e a
// resposta do provedor de nuvem (as credenciais da máquina) volta pra tela na
// coluna "resposta" da entrega. O mesmo vale pra `http://localhost:4000/api/…`,
// que atravessaria a autenticação por vir do próprio host.
//
// Por isso: só https em produção, e nunca para endereço que não seja público.
import { isIP } from 'node:net';
import { lookup } from 'node:dns/promises';
import { badRequest } from '../../utils/ApiError.js';
import { env } from '../../config/env.js';

/** Redes que nunca são destino legítimo de webhook de cliente. */
function privadoV4(ip) {
  const [a, b] = ip.split('.').map(Number);
  return (
    a === 0 ||                              // 0.0.0.0/8 — "este host"
    a === 10 ||                             // 10/8 privada
    a === 127 ||                            // loopback
    (a === 100 && b >= 64 && b <= 127) ||   // 100.64/10 CGNAT
    (a === 169 && b === 254) ||             // link-local — metadados de nuvem
    (a === 172 && b >= 16 && b <= 31) ||    // 172.16/12 privada
    (a === 192 && b === 168) ||             // 192.168/16 privada
    (a === 192 && b === 0) ||               // 192.0.0/24 reservada
    (a === 198 && (b === 18 || b === 19)) ||// 198.18/15 benchmark
    a >= 224                                // multicast e reservadas
  );
}

function privadoV6(ip) {
  const x = ip.toLowerCase();
  if (x === '::' || x === '::1') return true;
  // IPv4 mapeado (::ffff:10.0.0.1) — mesma rede, disfarçada.
  const mapeado = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(x);
  if (mapeado) return privadoV4(mapeado[1]);
  const p = x.split(':')[0];
  // fc00::/7 (único local) e fe80::/10 (link-local)
  return /^f[cd]/.test(p) || /^fe[89ab]/.test(p);
}

const enderecoPrivado = (ip) => (isIP(ip) === 6 ? privadoV6(ip) : privadoV4(ip));

/**
 * Valida a URL de destino. Chamada no cadastro E de novo a cada envio: entre
 * uma coisa e outra o DNS do domínio pode ter sido repontado para 127.0.0.1.
 *
 * LIMITE CONHECIDO: isto não fecha DNS rebinding. Entre a resolução aqui e a
 * conexão do `fetch` existe uma segunda resolução, e um domínio hostil pode
 * responder diferente nas duas. Fechar de vez exigiria conectar no IP já
 * validado com um agente próprio (`lookup` fixado no socket). Fica registrado
 * como o buraco que sobra.
 */
export async function validar(url) {
  let u;
  try { u = new URL(String(url)); } catch { throw badRequest('URL inválida'); }

  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && !env.isProd)) {
    throw badRequest('O endereço precisa ser https:// — o payload leva dado de cliente.');
  }
  if (u.username || u.password) {
    throw badRequest('Não use usuário e senha na URL. A autenticação do webhook é a assinatura HMAC.');
  }

  const host = u.hostname.replace(/^\[|\]$/g, '');

  if (isIP(host)) {
    if (enderecoPrivado(host)) throw badRequest('Endereço de rede interna não é destino válido.');
    return u.toString();
  }

  let enderecos;
  try {
    enderecos = await lookup(host, { all: true });
  } catch {
    throw badRequest(`Não consegui resolver o domínio "${host}". Confira o endereço.`);
  }
  // TODOS têm que ser públicos: um domínio que responde um IP público e um
  // interno entregaria o interno em metade das tentativas.
  if (enderecos.some((e) => enderecoPrivado(e.address))) {
    throw badRequest('Esse domínio aponta para a rede interna. Use um endereço público.');
  }
  return u.toString();
}
