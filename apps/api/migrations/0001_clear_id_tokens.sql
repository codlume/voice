-- Clears Google ID tokens written before the account hooks in src/auth.ts set them to null.
-- CI applies this before the new Worker deploys, so a Nightly sign-in served by the old Worker in
-- that window can still store one. The update hook clears it at that user's next sign-in. Stable
-- has no such window: its old Worker serves only /health.
UPDATE `account` SET `id_token` = NULL WHERE `id_token` IS NOT NULL;
