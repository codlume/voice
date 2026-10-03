CREATE TABLE parent_replacement (id TEXT PRIMARY KEY, body TEXT NOT NULL DEFAULT '');
INSERT INTO parent_replacement (id, body) SELECT id, body FROM parent;
DROP/**/TABLE parent;
ALTER/**/TABLE parent_replacement RENAME/**/TO parent;
