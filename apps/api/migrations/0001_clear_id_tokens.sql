-- Clears Google ID tokens written before the account hooks in src/auth.ts set them to null.
UPDATE `account` SET `id_token` = NULL WHERE `id_token` IS NOT NULL;
