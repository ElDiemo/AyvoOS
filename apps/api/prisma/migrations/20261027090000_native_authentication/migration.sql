-- Additive native authentication storage. Historical users/identities/sessions are retained.
-- No accounts, credentials, MFA seeds or permissions are manufactured by this migration.
ALTER TABLE user_identities DROP CONSTRAINT user_identities_provider_check;
ALTER TABLE user_identities ADD CONSTRAINT user_identities_provider_check
  CHECK (provider IN ('WORKOS', 'TEST', 'LOCAL'));
ALTER TABLE user_invitations DROP CONSTRAINT user_invitations_provider_check;
ALTER TABLE user_invitations ADD CONSTRAINT user_invitations_provider_check
  CHECK (provider IN ('WORKOS', 'TEST', 'LOCAL'));

CREATE TABLE native_credentials (
  user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  password_hash text NOT NULL,
  totp_ciphertext text NOT NULL,
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  mfa_revision integer NOT NULL DEFAULT 1 CHECK (mfa_revision > 0),
  last_totp_step bigint NOT NULL CHECK (last_totp_step >= 0),
  created_at timestamptz(3) NOT NULL DEFAULT now(),
  updated_at timestamptz(3) NOT NULL DEFAULT now(),
  CHECK (password_hash ~ '^\$argon2id\$v=19\$m=65536,t=3,p=1\$'),
  CHECK (totp_ciphertext LIKE 'v1.%')
);

CREATE TABLE native_auth_tokens (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  purpose text NOT NULL CHECK (purpose IN ('ENROLL', 'RESET_PASSWORD')),
  token_sha256 char(64) NOT NULL UNIQUE CHECK (token_sha256 ~ '^[a-f0-9]{64}$'),
  delivery_ciphertext text,
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  credential_revision integer NOT NULL CHECK (credential_revision >= 0),
  created_at timestamptz(3) NOT NULL DEFAULT now(),
  expires_at timestamptz(3) NOT NULL,
  claimed_at timestamptz(3), used_at timestamptz(3), revoked_at timestamptz(3), sent_at timestamptz(3),
  delivery_attempts integer NOT NULL DEFAULT 0 CHECK (delivery_attempts >= 0),
  next_delivery_at timestamptz(3) NOT NULL DEFAULT now(), delivery_lease_until timestamptz(3),
  CHECK (expires_at > created_at),
  CHECK (delivery_ciphertext IS NULL OR delivery_ciphertext LIKE 'v1.%')
);
CREATE INDEX native_auth_tokens_user_id_purpose_idx ON native_auth_tokens(user_id, purpose);
CREATE INDEX native_auth_tokens_next_delivery_at_idx ON native_auth_tokens(next_delivery_at);

CREATE TABLE native_auth_challenges (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  token_sha256 char(64) NOT NULL UNIQUE CHECK (token_sha256 ~ '^[a-f0-9]{64}$'),
  kind text NOT NULL CHECK (kind IN ('LOGIN', 'ENROLL', 'RESET_PASSWORD', 'REPLACE_MFA')),
  credential_revision integer NOT NULL CHECK (credential_revision >= 0),
  action_id uuid REFERENCES native_auth_tokens(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  action_revision integer,
  password_hash text, totp_ciphertext text,
  next_path text NOT NULL DEFAULT '/',
  created_at timestamptz(3) NOT NULL DEFAULT now(),
  expires_at timestamptz(3) NOT NULL,
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 5),
  used_at timestamptz(3),
  CHECK (expires_at > created_at),
  CHECK ((kind IN ('ENROLL', 'RESET_PASSWORD')) = (action_id IS NOT NULL)),
  CHECK ((action_id IS NULL) = (action_revision IS NULL)),
  CHECK (used_at IS NOT NULL OR ((kind IN ('ENROLL', 'RESET_PASSWORD')) = (password_hash IS NOT NULL))),
  CHECK (used_at IS NOT NULL OR ((kind IN ('ENROLL', 'REPLACE_MFA')) = (totp_ciphertext IS NOT NULL)))
);
CREATE INDEX native_auth_challenges_user_id_expires_at_idx ON native_auth_challenges(user_id, expires_at);

CREATE TABLE native_recovery_codes (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  code_sha256 char(64) NOT NULL UNIQUE CHECK (code_sha256 ~ '^[a-f0-9]{64}$'),
  mfa_revision integer NOT NULL CHECK (mfa_revision > 0),
  created_at timestamptz(3) NOT NULL DEFAULT now(), used_at timestamptz(3)
);
CREATE INDEX native_recovery_codes_user_id_mfa_revision_idx ON native_recovery_codes(user_id, mfa_revision);

-- Revisions invalidate pending challenges after a password/MFA change. Time steps never rewind
-- for the same MFA key, including writes made directly against the database.
CREATE FUNCTION native_credentials_transition() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'AYVO: native credentials cannot be deleted' USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW.user_id <> OLD.user_id OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'AYVO: native credential identity is immutable' USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW.password_hash IS DISTINCT FROM OLD.password_hash OR NEW.totp_ciphertext IS DISTINCT FROM OLD.totp_ciphertext THEN
    IF NEW.revision <> OLD.revision + 1 THEN
      RAISE EXCEPTION 'AYVO: credential change needs the next revision' USING ERRCODE = 'restrict_violation';
    END IF;
  ELSIF NEW.revision <> OLD.revision THEN
    RAISE EXCEPTION 'AYVO: credential revision changed without new credentials' USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW.totp_ciphertext IS DISTINCT FROM OLD.totp_ciphertext THEN
    IF NEW.mfa_revision <> OLD.mfa_revision + 1 THEN
      RAISE EXCEPTION 'AYVO: MFA change needs the next revision' USING ERRCODE = 'restrict_violation';
    END IF;
  ELSIF NEW.mfa_revision <> OLD.mfa_revision OR NEW.last_totp_step < OLD.last_totp_step THEN
    RAISE EXCEPTION 'AYVO: MFA revision or replay step cannot rewind' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER native_credentials_transition BEFORE UPDATE OR DELETE ON native_credentials
  FOR EACH ROW EXECUTE FUNCTION native_credentials_transition();
