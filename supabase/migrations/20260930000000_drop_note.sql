-- One description field.
--
-- `note` and `sub_category` both meant "what was this for": the tagger read
-- one, the dashboard edited the other. `sub_category` is the one the user
-- types into, so it stays and `note` goes. Any note not yet carried over is
-- copied first, so nothing typed is lost.

UPDATE sms_transactions
  SET sub_category = note
  WHERE note IS NOT NULL
    AND note IS DISTINCT FROM sub_category;

ALTER TABLE sms_transactions DROP COLUMN note;
