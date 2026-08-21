-- Phase « revue » — additif, idempotent. Appliquer avec psql sur CHAQUE base.
--
-- messages.skip_reason : pourquoi un sortant n'est pas parti (interrupteur,
-- numéro hors liste d'essai, suppression, plafond du jour, délai Twilio).
-- Avant, la rangée était effacée et le message disparaissait du fil.
--
-- sms_numbers.default_assistant_id : l'assistant qui prend un fil ENTRANT
-- sans assistant. Avant, seul un barreau de campagne pouvait confier un fil.

ALTER TABLE messages ADD COLUMN IF NOT EXISTS skip_reason text;
ALTER TABLE sms_numbers ADD COLUMN IF NOT EXISTS default_assistant_id uuid
  REFERENCES assistants(id) ON DELETE SET NULL;
