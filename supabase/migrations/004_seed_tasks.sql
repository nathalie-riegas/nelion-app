-- 004: Seed initial tasks
-- Diese Woche (Prio 1)
INSERT INTO tasks (titel, prioritaet, deadline, gate_bezug, nathalie_approved) VALUES
('RAV v6 einreichen', 1, '2026-04-14', NULL, true),
('LinkedIn Post 1 posten', 1, '2026-04-14', NULL, true),
('Anne-Transkript analysieren (Modul 2)', 1, '2026-04-14', NULL, true),
('Datenschutz-Konzept (1 Seite)', 1, '2026-04-14', NULL, true),
('Erstgespräch 1 vorbereiten', 1, '2026-04-17', 1, true),
('Erstgespräch 2 vorbereiten', 1, '2026-04-17', 1, true),

-- Gate 1 kritisch
('Tally-Survey aufsetzen (8 Fragen)', 1, '2026-05-01', 1, true),
('Whisper testen + in Workflow', 1, '2026-05-01', 1, true),
('Erster bezahlter Scan', 1, '2026-06-30', 1, true),

-- CAS Gates
('CAS Film-Konzept (15 min)', 2, '2026-06-30', NULL, true),
('CAS AI-Modul: 9 Case Studies', 2, '2026-08-31', NULL, true),
('CAS Film-Präsentation', 2, '2026-09-30', NULL, true);
