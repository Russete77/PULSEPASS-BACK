// modules/platform/controller.js — HTTP do god-mode (super-admin).
import * as service from './service.js';

export async function stats(req, res) {
  res.json({ data: await service.platformStats() });
}
export async function orgs(req, res) {
  res.json({ data: await service.listOrgs() });
}
export async function fraud(req, res) {
  res.json({ data: await service.fraudSignals() });
}
export async function finance(req, res) {
  res.json({ data: await service.financeStats() });
}
export async function activity(req, res) {
  res.json({ data: await service.activityFeed() });
}
