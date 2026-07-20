/** Registers all admin console views (Stage 5). */

import type { FastifyInstance } from 'fastify';
import type { ViewContext } from '../server.js';
import { registerDashboard } from './dashboard.js';
import { registerMessages } from './messages.js';
import { registerConsent } from './consent.js';
import { registerSettings } from './settings.js';
import { registerEmbeds } from './embeds.js';
import { registerSecurity } from './security.js';
import { registerReports } from './reports.js';

export function registerAdminViews(app: FastifyInstance, ctx: ViewContext): void {
  registerDashboard(app, ctx);
  registerMessages(app, ctx);
  registerConsent(app, ctx);
  registerSettings(app, ctx);
  registerSecurity(app, ctx);
  registerEmbeds(app, ctx);
  registerReports(app, ctx);
}
