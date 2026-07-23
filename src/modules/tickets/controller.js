// modules/tickets/controller.js — camada HTTP: valida (zod) e delega ao service.
import { z } from 'zod';
import * as service from './service.js';
import { badRequest } from '../../utils/ApiError.js';

export async function listMine(req, res) {
  const tickets = await service.listMyTickets({ user: req.user });
  res.json({ data: tickets });
}

export async function getMine(req, res) {
  const ticket = await service.getMyTicket({ user: req.user, ticketId: req.params.id });
  res.json({ data: ticket });
}

export async function getQrToken(req, res) {
  const data = await service.getMyTicketQrToken({ user: req.user, ticketId: req.params.id });
  // Cabeçalho anti-cache: o token é efêmero, nunca deve ser guardado.
  res.set('Cache-Control', 'no-store');
  res.json({ data });
}

const transferSchema = z.object({ toEmail: z.string().email() });

export async function transfer(req, res) {
  const parsed = transferSchema.safeParse(req.body);
  if (!parsed.success) throw badRequest('E-mail inválido', parsed.error.flatten());
  const result = await service.transferTicket({
    user: req.user,
    ticketId: req.params.id,
    toEmail: parsed.data.toEmail,
  });
  res.json({ data: result });
}
