// modules/audit/controller.js — consulta da trilha (só a gestão do evento).
import * as service from './service.js';

export async function eventTrail(req, res) {
  res.json({
    data: await service.eventTrail({
      user: req.user, eventId: req.params.id,
      action: req.query.action, moneyOnly: req.query.money === '1', limit: req.query.limit,
    }),
  });
}

export async function fraudCases(req, res) {
  res.json({ data: await service.fraudCases({ user: req.user, eventId: req.params.id }) });
}

export async function resolveFraudCase(req, res) {
  res.json({ data: await service.resolveFraudCase({ user: req.user, caseId: req.params.caseId }) });
}
