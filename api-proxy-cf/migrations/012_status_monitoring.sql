-- Migration 012: status page monitoring.
--
-- status_checks holds a rolling history of automated health checks per
-- service (pruned to ~35 days by the scheduled worker) so the public
-- status page can render a 30-day uptime bar per service.
--
-- status_incidents/status_incident_updates back the incident timeline.
-- Incidents can be auto-opened by the scheduled health check (auto_created=1,
-- status starts at 'investigating' with a generic body) or created manually
-- from the admin panel. Either way, updates are appended as the situation
-- is understood and resolved.

CREATE TABLE status_checks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  service TEXT NOT NULL,
  status TEXT NOT NULL,
  checked_at TEXT NOT NULL,
  detail TEXT
);
CREATE INDEX idx_status_checks_service_time ON status_checks(service, checked_at);

CREATE TABLE status_incidents (
  id TEXT PRIMARY KEY,
  service TEXT NOT NULL,
  title TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  auto_created INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_status_incidents_service ON status_incidents(service, status);

CREATE TABLE status_incident_updates (
  id TEXT PRIMARY KEY,
  incident_id TEXT NOT NULL,
  status TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_status_incident_updates_incident ON status_incident_updates(incident_id, created_at);
