// modules/integracoes/assinatura.js — assinatura HMAC do payload de webhook.
//
// POR QUE ISTO EXISTE: a URL de webhook da produtora é, por natureza, um
// endpoint público na internet. Qualquer um pode descobrir o endereço e mandar
// um POST dizendo "pedido X foi pago". Sem assinatura, o sistema do cliente não
// tem como distinguir isso de um aviso nosso — e o que está do outro lado
// costuma ser um ERP que libera acesso, emite nota ou paga comissão.
//
// A assinatura resolve porque o segredo é compartilhado só entre nós e aquele
// endpoint: quem não o tem não consegue produzir o HMAC do corpo.
import { createHmac, timingSafeEqual } from 'node:crypto';

export const CABECALHO = 'X-PulsePass-Signature';

/**
 * O timestamp entra DENTRO do que é assinado, não só ao lado.
 *
 * Se ele fosse apenas um header separado, um atacante que capturasse uma
 * entrega antiga poderia reenviá-la trocando a data e a assinatura continuaria
 * conferindo — "pedido pago" processado duas vezes. Assinando `t.corpo`, mexer
 * na data invalida a assinatura, e quem recebe pode recusar tudo que for velho
 * demais (tolerância recomendada: 5 minutos).
 *
 * Formato do header: `t=<unix>,v1=<hmac hex>`. O `v1` é versão: se um dia o
 * algoritmo mudar, dá pra mandar `v1` e `v2` juntos durante a transição, em vez
 * de quebrar todo integrador num deploy.
 *
 * @param {string} corpoBruto  o JSON EXATO que vai no corpo — não o objeto.
 */
export function assinar(corpoBruto, secret, timestamp = Math.floor(Date.now() / 1000)) {
  const v1 = createHmac('sha256', String(secret))
    .update(`${timestamp}.${corpoBruto}`, 'utf8')
    .digest('hex');
  return { timestamp, header: `t=${timestamp},v1=${v1}`, v1 };
}

/**
 * A conferência do lado de quem recebe. Não é usada pela API em produção — ela
 * assina, não verifica — mas fica aqui porque é o contrato: é exatamente este
 * cálculo que o integrador precisa reproduzir, e tê-lo em código executável
 * (com teste) impede que a documentação e a implementação divirjam.
 *
 * @param {number} toleranciaSeg  janela de replay aceita.
 */
export function conferir(corpoBruto, header, secret, toleranciaSeg = 300) {
  const m = /^t=(\d+),v1=([0-9a-f]+)$/.exec(String(header ?? '').trim());
  if (!m) return false;

  const t = Number(m[1]);
  const agora = Math.floor(Date.now() / 1000);
  if (!Number.isFinite(t) || Math.abs(agora - t) > toleranciaSeg) return false;

  const esperado = Buffer.from(assinar(corpoBruto, secret, t).v1, 'hex');
  const recebido = Buffer.from(m[2], 'hex');
  if (recebido.length !== esperado.length) return false;
  return timingSafeEqual(esperado, recebido);
}
