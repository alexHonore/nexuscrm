-- Porte d'activation des assistants (§11.4 du cahier) — appliquée à la main
-- avec psql sur CHAQUE base (dev, test, prod) : drizzle-kit push ne gère pas
-- les triggers. Ce fichier n'est pas dans le journal drizzle, exprès.
--
-- Un assistant ne peut passer `active` que si :
--   1. il est compilé contre la version COURANTE de prompt_cores (toujours —
--      un prompt périmé est un bug, pas un choix de politique) ;
--   2. sa suite de garde-fous est verte — sauf si require_suite_pass = false
--      (§11.2.3 : la porte devient consultative, l'UI affiche un avertissement).
--
-- La même règle est vérifiée dans l'action serveur ; le trigger attrape les
-- écritures directes en base (exigence explicite du cahier, testée).

CREATE OR REPLACE FUNCTION assistants_activation_gate() RETURNS trigger AS $$
DECLARE
  max_core integer;
  was_active boolean;
BEGIN
  was_active := (TG_OP = 'UPDATE' AND OLD.status = 'active');
  IF NEW.status = 'active' AND NOT was_active THEN
    SELECT max(version) INTO max_core FROM prompt_cores;
    IF NEW.compiled_prompt IS NULL
       OR NEW.compiled_core_version IS DISTINCT FROM max_core THEN
      RAISE EXCEPTION 'activation_gate: stale_compile';
    END IF;
    IF NEW.require_suite_pass AND NOT NEW.suite_passed THEN
      RAISE EXCEPTION 'activation_gate: suite_not_passed';
    END IF;
  END IF;
  RETURN NEW;
END
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS assistants_activation_gate_trg ON assistants;
CREATE TRIGGER assistants_activation_gate_trg
  BEFORE INSERT OR UPDATE ON assistants
  FOR EACH ROW EXECUTE FUNCTION assistants_activation_gate();
